import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
import patch_wrangler_cli


class WranglerPatchTests(unittest.TestCase):
    def test_synthetic_patch_is_exact_and_idempotent(self):
        source = b"start\n    MAX_ATTEMPTS = 3;\nend\n"
        expected = source.replace(b"    MAX_ATTEMPTS = 3;", b"    MAX_ATTEMPTS = 1;")
        patched = patch_wrangler_cli.patch_bytes(
            source,
            source_sha256=hashlib.sha256(source).hexdigest(),
            patched_sha256=hashlib.sha256(expected).hexdigest(),
        )
        self.assertEqual(patched, expected)
        self.assertEqual(
            patch_wrangler_cli.patch_bytes(
                patched,
                source_sha256=hashlib.sha256(source).hexdigest(),
                patched_sha256=hashlib.sha256(expected).hexdigest(),
            ),
            expected,
        )

    def test_synthetic_drift_and_duplicate_needle_fail_closed(self):
        source = b"start\n    MAX_ATTEMPTS = 3;\nend\n"
        patched = source.replace(b"    MAX_ATTEMPTS = 3;", b"    MAX_ATTEMPTS = 1;")
        kwargs = {
            "source_sha256": hashlib.sha256(source).hexdigest(),
            "patched_sha256": hashlib.sha256(patched).hexdigest(),
        }
        with self.assertRaises(patch_wrangler_cli.VerificationError):
            patch_wrangler_cli.patch_bytes(b"unrecognized drift", **kwargs)
        duplicate = source + b"\n    MAX_ATTEMPTS = 3;\n"
        with self.assertRaises(patch_wrangler_cli.VerificationError):
            patch_wrangler_cli.patch_bytes(
                duplicate,
                source_sha256=hashlib.sha256(duplicate).hexdigest(),
                patched_sha256=hashlib.sha256(duplicate.replace(
                    b"    MAX_ATTEMPTS = 3;", b"    MAX_ATTEMPTS = 1;", 1
                )).hexdigest(),
            )

    def test_rejects_root_owned_cli_and_package_json_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ("cli.js", "package.json"):
                writable_target = root / (name + ".user-writable")
                writable_target.write_text("synthetic fixture only")
                writable_target.chmod(0o666)
                link = root / name
                link.symlink_to(writable_target)
                if os.geteuid() == 0:
                    os.chown(link, 0, 0, follow_symlinks=False)
                    self.assertEqual(link.lstat().st_uid, 0)
                with self.assertRaisesRegex(
                    patch_wrangler_cli.VerificationError, "wrangler_cli_symlink_not_allowed"
                ):
                    patch_wrangler_cli._check_root_protected(link, regular=True)

    def test_only_global_bin_entry_may_be_a_symlink(self):
        if os.geteuid() != 0:
            self.skipTest("root-owned global npm bin link fixture")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / "bin" / "wrangler.js"
            target.parent.mkdir()
            target.write_text("synthetic wrapper fixture only")
            target.chmod(0o755)
            link = root / "wrangler"
            link.symlink_to(target)
            os.chown(link, 0, 0, follow_symlinks=False)
            patch_wrangler_cli._check_root_protected(link, allow_symlink=True)
            with self.assertRaises(patch_wrangler_cli.VerificationError):
                patch_wrangler_cli._check_root_protected(link, regular=True)

    def test_pinned_constants_match_a_single_compiled_cli_needle(self):
        # Read-only audit only: do not patch installed node_modules in this fixture.
        source_path = Path(__file__).parents[3] / "node_modules/wrangler/wrangler-dist/cli.js"
        if source_path.exists():
            original = source_path.read_bytes()
            self.assertEqual(hashlib.sha256(original).hexdigest(), patch_wrangler_cli.SOURCE_SHA256)
            self.assertEqual(original.count(patch_wrangler_cli.NEEDLE), 1)
            self.assertEqual(hashlib.sha256(original.replace(
                patch_wrangler_cli.NEEDLE, patch_wrangler_cli.REPLACEMENT, 1
            )).hexdigest(), patch_wrangler_cli.PATCHED_SHA256)


if __name__ == "__main__":
    unittest.main()
