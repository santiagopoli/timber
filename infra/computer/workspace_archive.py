"""Unprivileged, dirfd-only workspace checkpoint archive helpers.

Call these functions in a short-lived process dropped to timber-shell with a
minimal environment. Pass already-open descriptors: the workspace directory,
protected archive input/output, and (for restore) a private staging directory.
This module never opens a root-protected pathname, never reads controller state,
and never uses tarfile's path-based extraction helpers.

The caller keeps the protected archive file descriptor open and passes it with
``pass_fds``. Restore writes only below a staging directory owned by the
unprivileged caller; the trusted controller may atomically exchange that
completed directory with /workspace after this helper succeeds.
"""
from __future__ import annotations

import io
import json
import json
import os
import posixpath
import stat
import tarfile
from pathlib import PurePosixPath

MAX_ARCHIVE = 256 * 1024 * 1024
MAX_ENTRIES = 10_000
EXCLUDED = {"node_modules", ".cache", "__pycache__", ".venv"}
PROFILE_EXCLUDED = {"Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache"}


class ArchiveError(ValueError):
    """An unsafe or out-of-bounds workspace archive was rejected."""


def _dup_dir(fd: int) -> int:
    value = os.dup(fd)
    info = os.fstat(value)
    if not stat.S_ISDIR(info.st_mode):
        os.close(value)
        raise ArchiveError("Workspace archive root is not a directory")
    return value


def _path_parts(name: str) -> tuple[str, ...]:
    if not isinstance(name, str) or not name or "\x00" in name or "\\" in name:
        raise ArchiveError("Invalid archive path")
    pure = PurePosixPath(name)
    parts = pure.parts
    if pure.is_absolute() or not parts or any(part in {"", ".", ".."} for part in parts):
        raise ArchiveError("Invalid archive path")
    return parts


def _normalized_link(name: str, link: str) -> str:
    if not isinstance(link, str) or not link or "\x00" in link or "\\" in link or link.startswith("/"):
        raise ArchiveError("Checkpoint contains an escaping symlink")
    joined = posixpath.normpath(posixpath.join(posixpath.dirname(name), link))
    if joined in {"", "."} or joined == ".." or joined.startswith("../"):
        raise ArchiveError("Workspace symlink escapes its root")
    return joined


def _validate_link_map(links: dict[str, str], member_names: set[str]) -> None:
    """Reject links whose traversal would pass through another symlink.

    This conservative rule avoids path-resolution ambiguity and link-chain races
    while retaining ordinary internal relative links.
    """
    for name, link in links.items():
        target = _normalized_link(name, link)
        parts = target.split("/")
        for index in range(1, len(parts) + 1):
            if "/".join(parts[:index]) in links:
                raise ArchiveError("Symlink targets cannot traverse another symlink")
        if any(member.startswith(name + "/") for member in member_names):
            raise ArchiveError("Archive member traverses a symlink")


def _open_parent(root_fd: int, parts: tuple[str, ...]) -> tuple[int, str]:
    current = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = nxt
        return current, parts[-1]
    except BaseException:
        os.close(current)
        raise


def _dir_info(name: str, st: os.stat_result) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name.rstrip("/") + "/")
    info.type = tarfile.DIRTYPE
    info.mode = stat.S_IMODE(st.st_mode) & 0o777
    info.mtime = st.st_mtime
    info.uid = info.gid = 0
    return info


def _add_tree(archive: tarfile.TarFile, root_fd: int, prefix: str, *, exclude_root_profile: bool,
              count: list[int], total: list[int], links: dict[str, str], names: set[str]) -> None:
    root = _dup_dir(root_fd)
    try:
        if prefix:
            info = os.fstat(root)
            name = prefix.rstrip("/")
            if name in names:
                raise ArchiveError("Duplicate archive path")
            names.add(name)
            count[0] += 1
            if count[0] > MAX_ENTRIES:
                raise ArchiveError("Workspace exceeds checkpoint entry limit")
            archive.addfile(_dir_info(name, info))
        _walk_dir(archive, root, prefix.rstrip("/"), count, total, links, names,
                  root_level=True, exclude_root_profile=exclude_root_profile)
    finally:
        os.close(root)


def _walk_dir(archive: tarfile.TarFile, directory_fd: int, rel: str, count: list[int], total: list[int],
              links: dict[str, str], names: set[str], *, root_level: bool, exclude_root_profile: bool) -> None:
    before = os.fstat(directory_fd)
    try:
        entries = sorted(os.listdir(directory_fd))
    except OSError as exc:
        raise ArchiveError("Workspace changed during checkpoint") from exc
    for name in entries:
        if name in {"", ".", ".."} or "/" in name or "\\" in name or "\x00" in name:
            raise ArchiveError("Invalid workspace entry")
        if root_level and ((exclude_root_profile and name == ".browser-profile") or name == ".browser-profile-baseline"):
            continue
        child_rel = f"{rel}/{name}" if rel else name
        try:
            st = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError as exc:
            raise ArchiveError("Workspace changed during checkpoint") from exc
        count[0] += 1
        if count[0] > MAX_ENTRIES:
            raise ArchiveError("Workspace exceeds checkpoint entry limit")
        if stat.S_ISLNK(st.st_mode):
            link = os.readlink(name, dir_fd=directory_fd)
            try:
                _normalized_link(child_rel, link)
            except ArchiveError:
                # Chromium's live profile contains process-local Singleton links;
                # the prior checkpoint behavior deliberately omitted these.
                if child_rel.startswith(".browser-profile/") and name.startswith("Singleton"):
                    count[0] -= 1
                    continue
                raise
            if child_rel in names:
                raise ArchiveError("Duplicate archive path")
            names.add(child_rel)
            links[child_rel] = link
            item = tarfile.TarInfo(child_rel)
            item.type = tarfile.SYMTYPE
            item.linkname = link
            item.mode = 0o777
            item.mtime = st.st_mtime
            archive.addfile(item)
            continue
        if stat.S_ISDIR(st.st_mode):
            if name in EXCLUDED or (rel == ".browser-profile" and name in PROFILE_EXCLUDED):
                count[0] -= 1
                continue
            child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                actual = os.fstat(child_fd)
                if (actual.st_dev, actual.st_ino) != (st.st_dev, st.st_ino):
                    raise ArchiveError("Workspace changed during checkpoint")
                if child_rel in names:
                    raise ArchiveError("Duplicate archive path")
                names.add(child_rel)
                archive.addfile(_dir_info(child_rel, actual))
                _walk_dir(archive, child_fd, child_rel, count, total, links, names,
                          root_level=False, exclude_root_profile=exclude_root_profile)
                after = os.fstat(child_fd)
                if (actual.st_dev, actual.st_ino, actual.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_mtime_ns):
                    raise ArchiveError("Workspace changed during checkpoint")
            finally:
                os.close(child_fd)
            continue
        if not stat.S_ISREG(st.st_mode):
            raise ArchiveError("Workspace contains a special file")
        parent_fd, leaf = _open_parent(directory_fd, (name,))
        try:
            fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
            try:
                actual = os.fstat(fd)
                if not stat.S_ISREG(actual.st_mode) or (actual.st_dev, actual.st_ino) != (st.st_dev, st.st_ino):
                    raise ArchiveError("Workspace changed during checkpoint")
                if actual.st_size < 0 or total[0] + actual.st_size > MAX_ARCHIVE:
                    raise ArchiveError("Workspace exceeds checkpoint size limit")
                chunks = []
                remaining = actual.st_size + 1
                while remaining:
                    block = os.read(fd, min(65536, remaining))
                    if not block:
                        break
                    chunks.append(block)
                    remaining -= len(block)
                data = b"".join(chunks)
                final = os.fstat(fd)
                if len(data) != actual.st_size or (actual.st_dev, actual.st_ino, actual.st_size, actual.st_mtime_ns) != (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns):
                    raise ArchiveError("Workspace changed during checkpoint")
                if child_rel in names:
                    raise ArchiveError("Duplicate archive path")
                names.add(child_rel)
                total[0] += len(data)
                item = tarfile.TarInfo(child_rel)
                item.size = len(data)
                item.mode = stat.S_IMODE(actual.st_mode) & 0o777
                item.mtime = actual.st_mtime
                item.uid = item.gid = 0
                archive.addfile(item, io.BytesIO(data))
            finally:
                os.close(fd)
        finally:
            os.close(parent_fd)
    after_dir = os.fstat(directory_fd)
    if (before.st_dev, before.st_ino, before.st_mtime_ns) != (after_dir.st_dev, after_dir.st_ino, after_dir.st_mtime_ns):
        raise ArchiveError("Workspace changed during checkpoint")


def create_archive(workspace_fd: int, output_fd: int, *, profile_fd: int | None = None,
                   include_workspace_profile: bool = True) -> dict[str, int]:
    """Write a bounded gzip tar from already-open directory/output descriptors.

    ``profile_fd`` optionally adds a read-permitted, closed browser-profile
    snapshot as `.browser-profile`; when supplied, any current workspace
    `.browser-profile` is excluded to preserve live-browser snapshot behavior.
    The controller must pass a descriptor only when its contents are readable
    by the unprivileged helper; do not let the helper traverse `/state` paths.
    """
    count = [0]
    total = [0]
    links: dict[str, str] = {}
    names: set[str] = set()
    out = os.fdopen(os.dup(output_fd), "wb", closefd=True)
    try:
        with tarfile.open(fileobj=out, mode="w:gz", dereference=False, format=tarfile.PAX_FORMAT) as archive:
            _add_tree(archive, workspace_fd, "", exclude_root_profile=profile_fd is not None or not include_workspace_profile,
                      count=count, total=total, links=links, names=names)
            if profile_fd is not None:
                _add_tree(archive, profile_fd, ".browser-profile", exclude_root_profile=False,
                          count=count, total=total, links=links, names=names)
            _validate_link_map(links, names)
        out.flush()
        os.fsync(out.fileno())
    finally:
        out.close()
    return {"entries": count[0], "bytes": total[0]}


def _member_table(archive: tarfile.TarFile) -> tuple[list[tarfile.TarInfo], dict[str, str], set[str]]:
    members: list[tarfile.TarInfo] = []
    links: dict[str, str] = {}
    names: set[str] = set()
    kinds: dict[str, str] = {}
    total = 0
    for item in archive:
        raw = item.name[:-1] if item.name.endswith("/") else item.name
        parts = _path_parts(raw)
        canonical = "/".join(parts)
        if canonical in names:
            raise ArchiveError("Invalid or duplicate archive member")
        if not (item.isfile() or item.isdir() or item.issym()):
            raise ArchiveError("Archive hardlinks and special files are forbidden")
        if item.size < 0:
            raise ArchiveError("Invalid archive member size")
        if item.isfile():
            total += item.size
            if total > MAX_ARCHIVE:
                raise ArchiveError("Archive exceeds extraction size limit")
        if item.issym():
            links[canonical] = item.linkname
            _normalized_link(canonical, item.linkname)
        names.add(canonical)
        kinds[canonical] = "directory" if item.isdir() else "symlink" if item.issym() else "file"
        members.append(item)
        if len(members) > MAX_ENTRIES:
            raise ArchiveError("Archive exceeds extraction entry limit")
    for name in names:
        parts = name.split("/")
        for index in range(1, len(parts)):
            ancestor = "/".join(parts[:index])
            if kinds.get(ancestor) == "symlink":
                raise ArchiveError("Archive member traverses a symlink")
            if kinds.get(ancestor) == "file":
                raise ArchiveError("Archive member traverses a regular file")
    _validate_link_map(links, names)
    return members, links, names


def _ensure_dir(root_fd: int, parts: tuple[str, ...], mode: int = 0o770) -> int:
    current = os.dup(root_fd)
    try:
        for part in parts:
            try:
                os.mkdir(part, mode=0o2770, dir_fd=current)
            except FileExistsError:
                pass
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.fchmod(nxt, mode | stat.S_ISGID)
            os.close(current)
            current = nxt
        return current
    except BaseException:
        os.close(current)
        raise


def extract_archive(archive_fd: int, destination_fd: int) -> dict[str, int]:
    """Validate and extract a gzip tar below an already-open private staging dir.

    The extractor is designed to run unprivileged. It never writes via archive
    member paths and rejects symlinks that could become traversal components.
    The caller performs the trusted atomic workspace swap only after success.
    """
    root = _dup_dir(destination_fd)
    try:
        root_stat = os.fstat(root)
        if root_stat.st_uid != os.geteuid() or root_stat.st_mode & 0o077:
            raise ArchiveError("Restore staging directory must be private and owned by the helper")
        source = os.fdopen(os.dup(archive_fd), "rb", closefd=True)
        try:
            with tarfile.open(fileobj=source, mode="r:gz") as archive:
                members, links, _names = _member_table(archive)
                # Create explicit and implicit directories first. Never follow
                # archive symlinks while placing descendants.
                directory_names = set()
                for item in members:
                    parts = _path_parts(item.name[:-1] if item.name.endswith("/") else item.name)
                    for index in range(1, len(parts)):
                        directory_names.add("/".join(parts[:index]))
                    if item.isdir():
                        directory_names.add("/".join(parts))
                for name in sorted(directory_names, key=lambda n: (n.count("/"), n)):
                    if name in links:
                        raise ArchiveError("Archive symlink collides with a directory")
                    fd = _ensure_dir(root, tuple(name.split("/")))
                    os.close(fd)
                for item in members:
                    name = item.name[:-1] if item.name.endswith("/") else item.name
                    parts = _path_parts(name)
                    if item.isdir() or item.issym():
                        continue
                    parent = _ensure_dir(root, parts[:-1]) if len(parts) > 1 else os.dup(root)
                    try:
                        leaf = parts[-1]
                        fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                        source_file = None
                        try:
                            source_file = archive.extractfile(item)
                            if source_file is None:
                                raise ArchiveError("Missing archive data")
                            remaining = item.size
                            while remaining:
                                block = source_file.read(min(65536, remaining))
                                if not block:
                                    raise ArchiveError("Truncated archive member")
                                view = memoryview(block)
                                while view:
                                    written = os.write(fd, view)
                                    if written <= 0:
                                        raise ArchiveError("Unable to write restored file")
                                    view = view[written:]
                                remaining -= len(block)
                            os.fchmod(fd, 0o770 if item.mode & 0o111 else 0o660)
                        finally:
                            os.close(fd)
                            if source_file is not None:
                                source_file.close()
                    finally:
                        os.close(parent)
                # Create validated links only after all regular paths are fixed.
                for item in members:
                    if not item.issym():
                        continue
                    parts = _path_parts(item.name)
                    parent = _ensure_dir(root, parts[:-1]) if len(parts) > 1 else os.dup(root)
                    try:
                        os.symlink(item.linkname, parts[-1], dir_fd=parent)
                    finally:
                        os.close(parent)
                return {"entries": len(members), "bytes": sum(x.size for x in members if x.isfile())}
        finally:
            source.close()
    except (OSError, tarfile.TarError) as exc:
        if isinstance(exc, ArchiveError):
            raise
        raise ArchiveError("Workspace archive could not be safely processed") from exc
    finally:
        os.close(root)


def create_archive_cli() -> int:
    """Descriptor-oriented command entry point for the root controller.

    argv: ``create WORKSPACE_FD OUTPUT_FD [PROFILE_FD]`` or
    ``extract ARCHIVE_FD DESTINATION_FD``. The caller supplies descriptors via
    ``pass_fds`` and starts this module under the workspace UID with env -i.
    """
    import sys
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "create":
            result = create_archive(int(sys.argv[2]), int(sys.argv[3]))
            print(json.dumps(result, separators=(",", ":")))
            return 0
        if len(sys.argv) == 5 and sys.argv[1] == "create" and sys.argv[4] != "-":
            result = create_archive(int(sys.argv[2]), int(sys.argv[3]), profile_fd=int(sys.argv[4]))
            print(json.dumps(result, separators=(",", ":")))
            return 0
        if len(sys.argv) == 4 and sys.argv[1] == "extract":
            result = extract_archive(int(sys.argv[2]), int(sys.argv[3]))
            print(json.dumps(result, separators=(",", ":")))
            return 0
    except (ArchiveError, OSError, ValueError, tarfile.TarError):
        print("workspace archive operation rejected", file=sys.stderr)
        return 1
    print("invalid workspace archive invocation", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(create_archive_cli())
