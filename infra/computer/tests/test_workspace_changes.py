"""Real shell/filesystem coverage: classification follows effects, not shell text."""
import os
from pathlib import Path
import struct
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import server


class WorkspaceChangeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.computer = server.Computer(self.root / "workspace", self.root / "state")
        self.assertTrue(self.computer.workspace_changes.healthy)
        self.serial = 0

    def tearDown(self):
        self.computer.close()
        self.tmp.cleanup()

    def command(self, command, **options):
        self.serial += 1
        result = self.computer.execute(f"exec-{self.serial}", {"type": "exec", "command": command, "yieldMs": 30000, **options})
        self.assertNotEqual(result["status"], "running", result)
        return result

    def test_cd_grep_and_other_reads_do_not_save_or_rescan(self):
        (self.computer.workspace / "report.txt").write_text("label\n")
        started = time.monotonic()
        with patch.object(server.os, "walk", side_effect=AssertionError("read commands must not rescan")):
            result = self.command('cd . && grep -rn "label" report.txt', timeoutMs=10000)
            self.assertFalse(result["workspaceChanged"])
            self.assertFalse(self.command("cat report.txt; pwd; ls; stat report.txt")["workspaceChanged"])
        self.assertLess(time.monotonic() - started, 3, "timeout is a ceiling, not a fixed wait")

    def test_redirection_substitution_and_failed_writes_are_detected(self):
        for command in ["printf first > report.txt", "cat report.txt > copy.txt", "printf '%s' \"$(printf nested > nested.txt)\"", "printf x >> report.txt; exit 1"]:
            with self.subTest(command=command):
                self.assertTrue(self.command(command)["workspaceChanged"])
        self.assertFalse(self.command("cat report.txt copy.txt nested.txt")["workspaceChanged"])

    def test_nested_creation_rename_delete_and_metadata_changes(self):
        for command in ["mkdir -p tree/deep; printf x > tree/deep/file", "printf y >> tree/deep/file", "mv tree renamed", "printf z >> renamed/deep/file", "chmod 600 renamed/deep/file", "rm -r renamed"]:
            with self.subTest(command=command):
                self.assertTrue(self.command(command)["workspaceChanged"])
        self.assertTrue(self.computer.workspace_changes.healthy)
        self.assertFalse(self.command("pwd")["workspaceChanged"])

    def test_moving_an_existing_tree_into_workspace_installs_nested_watches(self):
        outside = self.root / "incoming"
        (outside / "deep").mkdir(parents=True)
        (outside / "deep" / "file").write_text("before")
        os.rename(outside, self.computer.workspace / "incoming")
        self.assertFalse(self.command("cat incoming/deep/file")["workspaceChanged"])
        self.assertTrue(self.command("printf after > incoming/deep/file")["workspaceChanged"])

    def test_excluded_caches_and_live_browser_do_not_dirty_file_checkpoints(self):
        self.assertFalse(self.command("mkdir -p node_modules/deep .cache .browser-profile; printf x > node_modules/deep/file; printf x > .cache/file; printf x > .browser-profile/file")["workspaceChanged"])
        # A regular file named like an excluded directory is still archived.
        self.assertTrue(self.command("printf x > .venv")["workspaceChanged"])

    def test_overflow_and_unavailable_watch_never_claim_no_changes(self):
        overflow = struct.pack("iIII", -1, server.WorkspaceChanges.OVERFLOW, 0, 0)
        with patch.object(server.os, "read", return_value=overflow):
            self.assertIsNone(self.computer.workspace_changes.snapshot())
        self.assertTrue(self.command("pwd")["workspaceChanged"])
        with patch.object(server.WorkspaceChanges, "add_tree", side_effect=OSError("watch limit")):
            watcher = server.WorkspaceChanges(self.computer.workspace)
            try:
                self.assertTrue(watcher.changed_since(watcher.snapshot()))
            finally:
                watcher.close()

    def test_concurrent_commands_do_not_discard_another_commands_changes(self):
        started = self.computer.execute("reader", {"type": "exec", "command": "printf ready; while [ ! -f release ]; do sleep .01; done; cat release", "yieldMs": 0})
        deadline = time.monotonic() + 3
        while "ready" not in started["output"] and time.monotonic() < deadline:
            started = self.computer.execute("observe", {"type": "execPoll", "processId": "reader", "yieldMs": 10})
        self.assertIn("ready", started["output"])
        self.assertTrue(self.command("printf x > release")["workspaceChanged"])
        result = self.computer.execute("finish", {"type": "execPoll", "processId": "reader", "yieldMs": 30000})
        self.assertTrue(result["workspaceChanged"])

    def test_delayed_background_child_remains_conservative(self):
        result = self.command("(sleep .5; printf late > late.txt) >/dev/null 2>&1 &")
        self.assertTrue(result["workspaceChanged"])
        time.sleep(.6)
        self.assertEqual((self.computer.workspace / "late.txt").read_text(), "late")

    def test_timeout_keeps_detected_writes_and_duplicate_receipt(self):
        action = {"type": "exec", "command": "printf x > report.txt; sleep 10", "timeoutMs": 100, "yieldMs": 30000}
        # Expire the clock after the real write, rather than assuming CI can
        # schedule a fresh bash process within 100 ms. The contract under test
        # is retaining effects and their receipt after timeout, not startup speed.
        clock_started = False
        def clock():
            nonlocal clock_started
            if not clock_started:
                clock_started = True
                return 0.0
            return 1.0 if (self.computer.workspace / "report.txt").exists() else 0.0
        with patch("server.time.monotonic", side_effect=clock):
            result = self.computer.execute("timeout", action)
        self.assertEqual(result["status"], "failed")
        self.assertIn("timed out", result["error"])
        self.assertEqual((self.computer.workspace / "report.txt").read_text(), "x")
        self.assertTrue(result["workspaceChanged"])
        self.assertEqual(self.computer.execute("timeout", action), result)

    def test_mmap_and_writes_through_external_hardlinks_are_not_misclassified_as_reads(self):
        self.command("printf original > report.txt")
        script = "import mmap; f=open('report.txt','r+b'); m=mmap.mmap(f.fileno(),0); m[0:1]=b'X'; m.flush(); m.close()"
        self.assertTrue(self.command(f'python3 -c "{script}"')["workspaceChanged"])
        outside = self.root / "alias"
        self.assertTrue(self.command(f"ln report.txt '{outside}'")["workspaceChanged"])
        self.assertFalse(self.command("cat report.txt")["workspaceChanged"])
        self.assertTrue(self.command(f"printf replaced > '{outside}'")["workspaceChanged"])
        self.assertFalse(self.command("cat report.txt")["workspaceChanged"])

    def test_no_event_metadata_audit_is_bounded_and_does_not_read_contents(self):
        self.command("mkdir tree; printf original > tree/file")
        with patch.object(Path, "read_bytes", side_effect=AssertionError("must not read file contents")), patch.object(server.os, "walk", side_effect=AssertionError("must not rediscover directories")):
            self.assertFalse(self.command("cat tree/file")["workspaceChanged"])


if __name__ == "__main__":
    unittest.main()
