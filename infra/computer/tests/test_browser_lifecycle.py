"""Portable checkpoints preserve a live browser and a consistent closed profile."""
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import server


class BrowserLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.computer = server.Computer(self.root / "workspace", self.root / "state")
        self.preference = self.computer.workspace / ".browser-profile" / "Default" / "Preferences"
        self.preference.parent.mkdir(parents=True)
        self.preference.write_text("closed profile")
        self.launch = patch.object(server.subprocess, "Popen").start()
        self.launch.return_value.poll.return_value = None
        self.activate = patch.object(self.computer, "activate_browser").start()
        self.computer.ensure_browser()

    def tearDown(self):
        self.computer.browser = None  # Popen is mocked; never signal an actual PID.
        self.computer.close()
        patch.stopall()
        self.tmp.cleanup()

    def contents(self, archive, name):
        with tarfile.open(archive, "r:gz") as saved:
            return saved.extractfile(name).read().decode()

    def test_navigation_reuses_one_process_and_automatic_saves_keep_live_state(self):
        browser = self.computer.browser
        self.computer.ensure_browser()
        self.assertEqual(self.launch.call_count, 1)
        self.preference.write_text("live profile changed by Chromium")
        (self.computer.workspace / "code.txt").write_text("latest code")
        with patch.object(self.computer, "close_browser") as close:
            first = self.computer.checkpoint(preserve_browser=True)
            (self.computer.workspace / "code.txt").write_text("newer code")
            second = self.computer.checkpoint(preserve_browser=True)
            close.assert_not_called()
        self.assertIs(self.computer.browser, browser)
        self.assertEqual(self.launch.call_count, 1)
        self.assertEqual(self.contents(first, "code.txt"), "latest code")
        self.assertEqual(self.contents(second, "code.txt"), "newer code")
        self.assertEqual(self.contents(second, ".browser-profile/Default/Preferences"), "closed profile")
        restored = server.Computer(self.root / "restored", self.root / "restored-state")
        try:
            restored.restore(second)
            self.assertEqual((restored.workspace / "code.txt").read_text(), "newer code")
            self.assertEqual((restored.workspace / ".browser-profile/Default/Preferences").read_text(), "closed profile")
        finally:
            restored.close()

    def test_explicit_save_refreshes_the_baseline_for_later_automatic_saves(self):
        self.preference.write_text("fresh profile")
        with patch.object(self.computer, "close_browser", side_effect=lambda: setattr(self.computer, "browser", None)) as close:
            explicit = self.computer.checkpoint()
            close.assert_called_once()
        self.assertEqual(self.contents(explicit, ".browser-profile/Default/Preferences"), "fresh profile")
        self.assertEqual(self.launch.call_count, 2)
        self.preference.write_text("unsaved live profile")
        automatic = self.computer.checkpoint(preserve_browser=True)
        self.assertEqual(self.contents(automatic, ".browser-profile/Default/Preferences"), "fresh profile")
        self.assertEqual(self.launch.call_count, 2)

    def test_suspend_flushes_current_profile_and_does_not_reopen(self):
        self.preference.write_text("profile at suspension")
        with patch.object(self.computer, "close_browser", side_effect=lambda: setattr(self.computer, "browser", None)) as close:
            archive = self.computer.checkpoint(resume_browser=False, preserve_browser=True)
            close.assert_called_once()
        self.assertEqual(self.contents(archive, ".browser-profile/Default/Preferences"), "profile at suspension")
        self.assertIsNone(self.computer.browser)
        self.assertEqual(self.launch.call_count, 1)

    def test_failed_automatic_save_does_not_restart_browser(self):
        (self.computer.workspace / "escape").symlink_to(self.root / "outside")
        with patch.object(self.computer, "close_browser") as close:
            with self.assertRaisesRegex(ValueError, "escaping symlink"):
                self.computer.checkpoint(preserve_browser=True)
            close.assert_not_called()
        self.assertEqual(self.launch.call_count, 1)
        self.assertFalse(list(self.computer.state.glob("*.tar.gz")))

    def test_profile_baseline_excludes_caches_and_process_locks(self):
        self.computer.browser = None
        profile = self.preference.parent.parent
        (profile / "SingletonLock").symlink_to("/tmp/browser-lock")
        cache = profile / "Default" / "Cache"
        cache.mkdir()
        (cache / "unneeded").write_text("cache")
        self.computer.ensure_browser()
        archive = self.computer.checkpoint(preserve_browser=True)
        with tarfile.open(archive, "r:gz") as saved:
            names = saved.getnames()
        self.assertNotIn(".browser-profile/SingletonLock", names)
        self.assertFalse(any("/Cache" in name for name in names))

    def test_combined_file_limit_includes_the_saved_profile(self):
        (self.computer.workspace / "code.txt").write_text("code")
        with patch.object(server, "MAX_FILES", 3), self.assertRaisesRegex(ValueError, "checkpoint limit"):
            self.computer.checkpoint(preserve_browser=True)

    def test_profile_baseline_cannot_copy_a_directory_outside_workspace(self):
        self.computer.browser = None
        profile = self.preference.parent.parent
        profile.rename(self.root / "outside-profile")
        profile.symlink_to(self.root / "outside-profile", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "inside the workspace"):
            self.computer.ensure_browser()
        self.assertEqual(self.launch.call_count, 1)

    def test_missing_or_redirected_baseline_fails_without_copying_the_live_profile(self):
        baseline = self.computer.browser_checkpoint_profile
        baseline.rename(self.root / "closed-profile")
        with patch.object(self.computer, "close_browser") as close:
            for redirected in (False, True):
                if redirected:
                    baseline.symlink_to(self.root / "closed-profile", target_is_directory=True)
                with self.assertRaisesRegex(ValueError, "consistent browser profile"):
                    self.computer.checkpoint(preserve_browser=True)
            close.assert_not_called()
        self.assertEqual(self.launch.call_count, 1)
