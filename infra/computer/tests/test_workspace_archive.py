"""Focused contract tests for the isolated workspace archive helper.

These tests deliberately call descriptor-only APIs; production must run them in
an unprivileged helper process and pass only the four scoped FDs it needs.
"""
from __future__ import annotations

import io
import os
import sys
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
from workspace_archive import ArchiveError, create_archive, extract_archive, unlock_browser_profile, PROFILE_LOCKS


def directory_fd(path: Path) -> int:
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def archive_bytes(items: list[tuple[str, str, bytes | str, int]]) -> bytes:
    target = io.BytesIO()
    with tarfile.open(fileobj=target, mode="w:gz") as archive:
        for name, kind, content, mode in items:
            entry = tarfile.TarInfo(name)
            entry.mode = mode
            if kind == "dir":
                entry.type = tarfile.DIRTYPE
                archive.addfile(entry)
            elif kind == "symlink":
                entry.type = tarfile.SYMTYPE
                entry.linkname = str(content)
                archive.addfile(entry)
            else:
                raw = bytes(content)
                entry.size = len(raw)
                archive.addfile(entry, io.BytesIO(raw))
    return target.getvalue()


class WorkspaceArchiveTests(unittest.TestCase):
    def test_checkpoint_omits_valid_machine_local_browser_locks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'workspace'
            profile = root / '.browser-profile'
            profile.mkdir(parents=True)
            (profile / 'Preferences').write_text('keep browser sessions')
            (profile / 'SingletonLock').symlink_to('old-computer-15264')
            (profile / 'SingletonCookie').symlink_to('123456')
            (profile / 'SingletonSocket').write_text('machine-local socket placeholder')
            output = Path(temp) / 'checkpoint.tgz'
            source_fd = directory_fd(root)
            output_fd = os.open(output, os.O_WRONLY | os.O_CREAT, 0o600)
            try:
                create_archive(source_fd, output_fd)
            finally:
                os.close(source_fd)
                os.close(output_fd)
            with tarfile.open(output) as archive:
                self.assertEqual(archive.extractfile('.browser-profile/Preferences').read(), b'keep browser sessions')
                self.assertFalse(any(Path(name).name in PROFILE_LOCKS for name in archive.getnames()))

    def test_stale_lock_cleanup_preserves_sessions_and_does_not_follow_links(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            profile = root / 'profile'
            profile.mkdir()
            proc = root / 'proc'
            proc.mkdir()
            outside = root / 'outside'
            outside.write_text('untouched')
            (profile / 'Preferences').write_text('session')
            for name in PROFILE_LOCKS:
                (profile / name).symlink_to(outside)
            fd = directory_fd(profile)
            try:
                unlock_browser_profile(fd, proc_root=proc)
                unlock_browser_profile(fd, proc_root=proc)
            finally:
                os.close(fd)
            self.assertEqual(outside.read_text(), 'untouched')
            self.assertEqual((profile / 'Preferences').read_text(), 'session')
            self.assertFalse(PROFILE_LOCKS.intersection(os.listdir(profile)))

    def test_cleanup_refuses_a_live_local_browser_even_with_a_foreign_lock_hostname(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            profile = root / 'profile'
            profile.mkdir()
            (profile / 'SingletonLock').symlink_to('foreign-computer-15264')
            process = root / 'proc' / '15264'
            process.mkdir(parents=True)
            alias = root / 'alias'
            alias.symlink_to(profile, target_is_directory=True)
            (process / 'cmdline').write_bytes(b'/usr/lib/chromium/chromium\0--user-data-dir=' + os.fsencode(alias) + b'\0')
            fd = directory_fd(profile)
            try:
                with self.assertRaisesRegex(ArchiveError, 'already in use'):
                    unlock_browser_profile(fd, proc_root=process.parent)
                self.assertTrue((profile / 'SingletonLock').is_symlink())
                (process / 'cmdline').write_bytes(b'/usr/lib/chromium/chromium\0--user-data-dir=/different/profile\0')
                unlock_browser_profile(fd, proc_root=process.parent)
                self.assertFalse((profile / 'SingletonLock').is_symlink())
            finally:
                os.close(fd)

    def test_round_trip_regular_tree_internal_link_modes_and_exclusions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "workspace"
            root.mkdir()
            (root / "src").mkdir()
            (root / "src" / "main.js").write_text("export default {}\n")
            (root / "src" / "main.js").chmod(0o770)
            (root / "src" / "alias").symlink_to("main.js")
            (root / "node_modules").mkdir()
            (root / "node_modules" / "skip.js").write_text("excluded")
            (root / "dist").mkdir()
            (root / "dist" / "worker.js").write_text("this deploy artifact must persist")
            output = Path(temp) / "archive.tgz"
            src_fd = directory_fd(root)
            out_fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                result = create_archive(src_fd, out_fd)
            finally:
                os.close(src_fd)
                os.close(out_fd)
            self.assertEqual(result["entries"], 5)
            with tarfile.open(output, "r:gz") as archive:
                names = {name.rstrip("/") for name in archive.getnames()}
                self.assertEqual(names, {"src", "src/main.js", "src/alias", "dist", "dist/worker.js"})
            restored = Path(temp) / "restore"
            restored.mkdir(mode=0o700)
            inp_fd = os.open(output, os.O_RDONLY | os.O_NOFOLLOW)
            dst_fd = directory_fd(restored)
            try:
                extract_archive(inp_fd, dst_fd)
            finally:
                os.close(inp_fd)
                os.close(dst_fd)
            self.assertEqual((restored / "src" / "main.js").read_text(), "export default {}\n")
            self.assertTrue((restored / "src" / "main.js").stat().st_mode & stat.S_IXUSR)
            self.assertTrue((restored / "src" / "alias").is_symlink())
            self.assertEqual(os.readlink(restored / "src" / "alias"), "main.js")
            self.assertFalse((restored / "node_modules").exists())
            self.assertEqual((restored / "dist" / "worker.js").read_text(), "this deploy artifact must persist")

    def test_restore_rejects_escaping_paths_links_hardlinks_and_specials_without_escape(self):
        malicious = [
            archive_bytes([("../escape", "file", b"x", 0o600)]),
            archive_bytes([("/absolute", "file", b"x", 0o600)]),
            archive_bytes([("link", "symlink", "../../outside", 0o777)]),
        ]
        # Build unsupported tar member types without using any filesystem paths.
        hardlink_buffer = io.BytesIO()
        with tarfile.open(fileobj=hardlink_buffer, mode="w:gz") as archive:
            member = tarfile.TarInfo("hard")
            member.type = tarfile.LNKTYPE
            member.linkname = "victim"
            archive.addfile(member)
        malicious.append(hardlink_buffer.getvalue())
        fifo_buffer = io.BytesIO()
        with tarfile.open(fileobj=fifo_buffer, mode="w:gz") as archive:
            member = tarfile.TarInfo("pipe")
            member.type = tarfile.FIFOTYPE
            archive.addfile(member)
        malicious.append(fifo_buffer.getvalue())

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            outside = root / "outside"
            outside.write_text("unchanged")
            for index, encoded in enumerate(malicious):
                stage = root / f"stage-{index}"
                stage.mkdir(mode=0o700)
                archive_path = root / f"evil-{index}.tgz"
                archive_path.write_bytes(encoded)
                source_fd = os.open(archive_path, os.O_RDONLY | os.O_NOFOLLOW)
                target_fd = directory_fd(stage)
                try:
                    with self.assertRaises(ArchiveError):
                        extract_archive(source_fd, target_fd)
                finally:
                    os.close(source_fd)
                    os.close(target_fd)
                self.assertEqual(outside.read_text(), "unchanged")
                self.assertFalse((root / "escape").exists())

    def test_restore_rejects_member_beneath_internal_symlink_and_canonical_duplicates(self):
        payloads = [
            archive_bytes([("pivot", "symlink", "safe", 0o777), ("pivot/child", "file", b"bad", 0o600)]),
            archive_bytes([("a//b", "file", b"one", 0o600), ("a/b", "file", b"two", 0o600)]),
        ]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for i, payload in enumerate(payloads):
                stage = root / f"stage-{i}"
                stage.mkdir(mode=0o700)
                inp = root / f"archive-{i}.tgz"
                inp.write_bytes(payload)
                source_fd = os.open(inp, os.O_RDONLY | os.O_NOFOLLOW)
                destination_fd = directory_fd(stage)
                try:
                    with self.assertRaises(ArchiveError):
                        extract_archive(source_fd, destination_fd)
                finally:
                    os.close(source_fd)
                    os.close(destination_fd)
                self.assertFalse((root / "safe").exists())

    def test_checkpoint_serializes_workspace_hardlinks_as_regular_members(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "workspace"
            root.mkdir()
            (root / "first").write_text("shared bytes")
            os.link(root / "first", root / "second")
            output = base / "archive.tgz"
            src_fd = directory_fd(root)
            out_fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                create_archive(src_fd, out_fd)
            finally:
                os.close(src_fd)
                os.close(out_fd)
            with tarfile.open(output, "r:gz") as archive:
                members = {member.name: member for member in archive.getmembers()}
                self.assertTrue(members["first"].isreg())
                self.assertTrue(members["second"].isreg())
                self.assertEqual(archive.extractfile(members["first"]).read(), b"shared bytes")
                self.assertEqual(archive.extractfile(members["second"]).read(), b"shared bytes")

    def test_checkpoint_rejects_escaping_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "workspace"
            root.mkdir()
            outside = base / "outside"
            outside.write_text("private")
            (root / "escape").symlink_to(outside)
            output = base / "archive.tgz"
            src_fd = directory_fd(root)
            out_fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with self.assertRaises(ArchiveError):
                    create_archive(src_fd, out_fd)
            finally:
                os.close(src_fd)
                os.close(out_fd)

    def test_optional_profile_fd_uses_browser_prefix_and_cache_exclusions(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "workspace"
            profile = base / "profile"
            root.mkdir()
            profile.mkdir()
            (root / ".browser-profile").mkdir()
            (root / ".browser-profile" / "live.sqlite").write_text("workspace-live")
            (root / ".browser-profile-baseline").mkdir()
            (root / ".browser-profile-baseline" / "Preferences").write_text("must be represented only by profile_fd")
            (profile / "Preferences").write_text("closed baseline")
            (profile / "Cache").mkdir()
            (profile / "Cache" / "ignored").write_text("ignored")
            output = base / "archive.tgz"
            ws_fd, profile_fd = directory_fd(root), directory_fd(profile)
            out_fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                create_archive(ws_fd, out_fd, profile_fd=profile_fd)
            finally:
                os.close(ws_fd)
                os.close(profile_fd)
                os.close(out_fd)
            with tarfile.open(output, "r:gz") as archive:
                names = {name.rstrip("/") for name in archive.getnames()}
            self.assertIn(".browser-profile/Preferences", names)
            self.assertNotIn(".browser-profile/live.sqlite", names)
            self.assertNotIn(".browser-profile-baseline/Preferences", names)
            self.assertFalse(any(name.startswith(".browser-profile/Cache/") for name in names))


if __name__ == "__main__":
    unittest.main()
