#!/usr/bin/python3
"""Build-time deterministic patch and root-only verifier for pinned Wrangler."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat

WRANGLER_VERSION = "4.147.0"
BUILD_ID = "wrangler-4.147.0-timber-no-retry-v1"
SOURCE_SHA256 = "f2ec95b41d7f7665a42b75fc9631100e95ea6c0dbabc09eb65ae7f772dbc2fed"
PATCHED_SHA256 = "07f2d4392dbaa8944bd2a73dc1bcbef481840fddb65b6e6bd5c697e000163511"
NEEDLE = b"    MAX_ATTEMPTS = 3;"
REPLACEMENT = b"    MAX_ATTEMPTS = 1;"


class VerificationError(ValueError):
    pass


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def patch_bytes(raw: bytes, *, source_sha256: str = SOURCE_SHA256,
                patched_sha256: str = PATCHED_SHA256) -> bytes:
    """Patch only the exact known CLI, idempotently; reject all source drift."""
    current = sha256(raw)
    if current == patched_sha256:
        return raw
    if current != source_sha256:
        raise VerificationError("wrangler_cli_source_digest_mismatch")
    if raw.count(NEEDLE) != 1:
        raise VerificationError("wrangler_cli_patch_needle_count_mismatch")
    patched = raw.replace(NEEDLE, REPLACEMENT, 1)
    if sha256(patched) != patched_sha256:
        raise VerificationError("wrangler_cli_post_patch_digest_mismatch")
    return patched


def _check_root_protected(path: Path, *, directory: bool = False,
                          regular: bool = False, allow_symlink: bool = False) -> None:
    info = path.lstat()
    is_link = stat.S_ISLNK(info.st_mode)
    if is_link and not allow_symlink:
        raise VerificationError("wrangler_cli_symlink_not_allowed")
    if info.st_uid != 0 or (not is_link and info.st_mode & 0o022):
        raise VerificationError("wrangler_cli_path_not_root_protected")
    if directory and (is_link or not stat.S_ISDIR(info.st_mode)):
        raise VerificationError("wrangler_cli_parent_not_directory")
    if regular and (is_link or not stat.S_ISREG(info.st_mode)):
        raise VerificationError("wrangler_cli_file_not_regular")


def cli_path_from_executable(executable: str | Path) -> tuple[Path, Path]:
    """Resolve the sole allowed global-bin symlink to its protected package."""
    entry = Path(executable)
    # npm's global bin entry is commonly a symlink. Its owner and parent are
    # checked here; every resolved target and target parent is checked below.
    _check_root_protected(entry, allow_symlink=True)
    for parent in entry.parents:
        _check_root_protected(parent, directory=True)
    wrapper = entry.resolve(strict=True)
    _check_root_protected(wrapper, regular=True)
    for parent in wrapper.parents:
        _check_root_protected(parent, directory=True)
    if wrapper.parent.name != "bin":
        raise VerificationError("wrangler_executable_not_package_bin")
    package = wrapper.parent.parent
    package_json = package / "package.json"
    _check_root_protected(package_json, regular=True)
    try:
        metadata = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VerificationError("wrangler_package_metadata_invalid") from exc
    if metadata.get("name") != "wrangler" or metadata.get("version") != WRANGLER_VERSION:
        raise VerificationError("wrangler_package_version_mismatch")
    cli = package / "wrangler-dist" / "cli.js"
    _check_root_protected(cli, regular=True)
    for parent in cli.parents:
        _check_root_protected(parent, directory=True)
    return wrapper, cli


def patch_installed_cli(executable: str | Path) -> Path:
    _, cli = cli_path_from_executable(executable)
    try:
        original = cli.read_bytes()
    except OSError as exc:
        raise VerificationError("wrangler_cli_unreadable") from exc
    patched = patch_bytes(original)
    if patched != original:
        temporary = cli.with_name(cli.name + ".timber-tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(patched)
                output.flush()
                os.fsync(output.fileno())
            os.chown(temporary, 0, 0)
            os.chmod(temporary, 0o644)
            os.replace(temporary, cli)
        except BaseException:
            try:
                temporary.unlink()
            except OSError:
                pass
            raise
    verify_installed_cli(executable)
    return cli


def verify_installed_cli(executable: str | Path) -> dict:
    if os.geteuid() != 0:
        raise VerificationError("wrangler_cli_verification_requires_root")
    _, cli = cli_path_from_executable(executable)
    if sha256(cli.read_bytes()) != PATCHED_SHA256:
        raise VerificationError("wrangler_cli_patched_digest_mismatch")
    return {"cliVersion": WRANGLER_VERSION, "cliBuildId": BUILD_ID,
            "cliDigest": "sha256:" + PATCHED_SHA256, "noAutomaticRetry": True}


def main() -> int:
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--patch", action="store_true")
    modes.add_argument("--verify", action="store_true")
    parser.add_argument("executable", nargs="?", default="/usr/local/bin/wrangler")
    args = parser.parse_args()
    try:
        if args.patch:
            path = patch_installed_cli(args.executable)
            print(json.dumps({"cliVersion": WRANGLER_VERSION, "cliBuildId": BUILD_ID,
                              "cliDigest": "sha256:" + PATCHED_SHA256,
                              "cliPath": str(path), "noAutomaticRetry": True}, sort_keys=True))
        else:
            print(json.dumps(verify_installed_cli(args.executable), sort_keys=True))
        return 0
    except (OSError, VerificationError):
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
