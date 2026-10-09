import sys
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location("computer_server", Path(__file__).parents[1] / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class ComputerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.computer = server.Computer(self.root / "workspace", self.root / "state")

    def tearDown(self):
        self.computer.close_browser()
        self.computer.db.close()
        self.tmp.cleanup()

    def action(self, operation_id, **action):
        return self.computer.execute(operation_id, action)

    def test_shell_deduplicates_effect_across_restart(self):
        action = {"type": "exec", "command": "printf x >> count.txt; cat count.txt"}
        first = self.computer.execute("op.1", action)
        self.assertEqual(first["output"], "x")
        self.computer.db.close()
        self.computer = server.Computer(self.root / "workspace", self.root / "state")
        self.assertEqual(self.computer.execute("op.1", action), first)
        self.assertEqual((self.computer.workspace / "count.txt").read_text(), "x")

    def test_operation_id_rejects_changed_arguments(self):
        self.action("same", type="writeFile", path="safe", content="original")
        with self.assertRaises(ValueError):
            self.action("same", type="writeFile", path="safe", content="changed")
        self.assertEqual((self.computer.workspace / "safe").read_text(), "original")

    def test_pending_operation_is_interrupted_after_restart(self):
        action = {"type": "exec", "command": "touch should-not-exist"}
        digest = hashlib.sha256(json.dumps(action, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.computer.db.execute("INSERT INTO operations(id,digest) VALUES(?,?)", ("pending", digest))
        self.computer.db.commit()
        self.computer.db.close()
        self.computer = server.Computer(self.root / "workspace", self.root / "state")
        self.assertEqual(self.computer.execute("pending", action)["status"], "interrupted")
        self.assertFalse((self.computer.workspace / "should-not-exist").exists())

    def test_server_restart_preserves_filesystem_identity(self):
        boot_id = self.computer.boot_id
        self.computer.db.close()
        self.computer = server.Computer(self.root / "workspace", self.root / "state")
        self.assertEqual(self.computer.boot_id, boot_id)

    def test_invalid_mouse_gestures_produce_no_input(self):
        invalid = [
            {"type": "move", "x": 1280, "y": 0},
            {"type": "move", "x": True, "y": 0},
            {"type": "doubleClick", "x": 0, "y": 800},
            {"type": "doubleClick", "x": 0, "y": 0, "button": {}},
            {"type": "drag", "fromX": 10, "fromY": 20, "toX": -1, "toY": 30},
            {"type": "drag", "fromX": 10, "fromY": 20, "toX": 30, "toY": 40, "durationMs": 99},
            {"type": "drag", "fromX": 10, "fromY": 20, "toX": 30, "toY": 40, "durationMs": 2001},
            {"type": "drag", "fromX": 10, "fromY": 20, "toX": 30, "toY": 40, "durationMs": 100.5},
        ]
        with patch.object(self.computer, "run") as dispatch:
            for index, action in enumerate(invalid):
                self.assertEqual(self.computer.execute(f"invalid-mouse-{index}", action)["status"], "failed")
            dispatch.assert_not_called()

    def test_drag_releases_the_button_after_failed_press_or_movement_and_never_replays(self):
        for failure_stage in ("mousedown", "sleep"):
            calls = []
            def fail_during_gesture(argv):
                calls.append(argv)
                if argv[1] == failure_stage:
                    raise subprocess.TimeoutExpired(argv, 15)
            with self.subTest(stage=failure_stage), patch.object(self.computer, "run", side_effect=fail_during_gesture):
                action = {"type": "drag", "fromX": 30, "fromY": 40, "toX": 200, "toY": 300, "button": "right"}
                operation_id = f"drag-failure-{failure_stage}"
                first = self.computer.execute(operation_id, action)
                self.assertEqual(first["status"], "failed")
                self.assertEqual(calls[-1][1:3], ["mouseup", "3"])
                before_retry = len(calls)
                self.assertEqual(self.computer.execute(operation_id, action), first)
                self.assertEqual(len(calls), before_retry)

    def test_double_click_deduplicates_and_move_never_presses_a_button(self):
        with patch.object(self.computer, "run") as dispatch:
            move = self.action("hover", type="move", x=300, y=200)
            self.assertEqual(move["status"], "completed")
            self.assertNotIn("click", dispatch.call_args.args[0])
            self.assertNotIn("mousedown", dispatch.call_args.args[0])
            first = self.action("double", type="doubleClick", x=300, y=200)
            self.assertEqual(first["status"], "completed")
            self.assertEqual(self.action("double", type="doubleClick", x=300, y=200), first)
            self.assertEqual(dispatch.call_count, 2)

    def test_checkpoint_copies_hardlinked_files_as_regular_files(self):
        import os
        self.action("hardlink-file", type="writeFile", path="one", content="same")
        os.link(self.computer.workspace / "one", self.computer.workspace / "two")
        archive = self.computer.checkpoint()
        self.computer.restore(archive)
        self.assertEqual((self.computer.workspace / "two").read_text(), "same")

    def test_text_files_and_directory_listing(self):
        self.action("write", type="writeFile", path="folder/á.txt", content="Hola, Poli 👋")
        self.assertEqual(self.action("read", type="readFile", path="folder/á.txt")["output"], "Hola, Poli 👋")
        listed = json.loads(self.action("list", type="listFiles", path="folder")["output"])
        self.assertEqual(listed, [{"name": "á.txt", "kind": "file"}])

    def test_paths_reject_parent_absolute_and_symlink_escape(self):
        (self.computer.workspace / "escape").symlink_to(self.root)
        for index, path in enumerate(["../outside", "/etc/passwd", "escape/outside"]):
            result = self.action(f"escape{index}", type="writeFile", path=path, content="bad")
            self.assertEqual(result["status"], "failed")
        self.assertFalse((self.root / "outside").exists())

    def test_timeout_kills_command_and_retains_partial_output(self):
        import os
        import select
        import signal
        from unittest.mock import patch

        real_popen = server.subprocess.Popen

        def start_after_output_is_ready(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            # CI login-shell startup can itself exceed a 50 ms timeout. Start
            # this test's deadline only once the real child has emitted output.
            # Wait after the durable launch gate is opened. Readiness does not
            # consume output; the session monitor must still capture it.
            original_stdin = process.stdin
            outer = self

            class ReadyInput:
                write = original_stdin.write
                close = original_stdin.close

                def flush(self):
                    original_stdin.flush()
                    readable, _, _ = select.select([process.stdout], [], [], 10)
                    if not readable:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)
                        outer.fail("Test shell did not produce initial output")

            process.stdin = ReadyInput()
            return process

        with patch.object(server.subprocess, "Popen", side_effect=start_after_output_is_ready):
            result = self.action("timeout", type="exec", command="printf ready; sleep 10; touch too-late", timeoutMs=100, yieldMs=30000)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["output"], "ready")
        self.assertIn("timed out", result["error"])
        self.assertLess(result["exitCode"], 0)
        self.assertFalse((self.computer.workspace / "too-late").exists())

    def test_output_is_bounded(self):
        result = self.action("large", type="exec", command="python3 -c 'print(\"x\" * 200000)'", timeoutMs=3000)
        self.assertEqual(result["status"], "completed")
        self.assertIn("truncated", result["output"])
        self.assertLess(len(result["output"]), server.MAX_OUTPUT + 100)

    def test_internal_token_not_in_shell_environment(self):
        import os
        from unittest.mock import patch
        with patch.dict(os.environ, {"BOTSPACE_COMPUTER_TOKEN": "private-test-value"}):
            result = self.action("env", type="exec", command="printf '%s' \"${BOTSPACE_COMPUTER_TOKEN-unset}\"")
        self.assertEqual(result["output"], "unset")

    def test_checkpoint_and_restore_replace_workspace(self):
        self.action("one", type="writeFile", path="nested/file.txt", content="original")
        archive = self.computer.checkpoint()
        self.action("two", type="writeFile", path="nested/file.txt", content="modified")
        self.action("three", type="writeFile", path="later.txt", content="remove me")
        self.computer.restore(archive)
        self.assertEqual((self.computer.workspace / "nested/file.txt").read_text(), "original")
        self.assertFalse((self.computer.workspace / "later.txt").exists())

    def test_checkpoint_excludes_rebuildable_dependencies(self):
        self.action("dep", type="writeFile", path="node_modules/lib/index.js", content="dep")
        self.action("keep", type="writeFile", path="package.json", content="{}")
        archive = self.computer.checkpoint()
        with tarfile.open(archive, "r:gz") as contents:
            self.assertEqual(contents.getnames(), ["package.json"])

    def test_checkpoint_preserves_contained_symlinks(self):
        self.action("file", type="writeFile", path="data.txt", content="hello")
        (self.computer.workspace / "alias").symlink_to("data.txt")
        archive = self.computer.checkpoint()
        self.computer.restore(archive)
        self.assertTrue((self.computer.workspace / "alias").is_symlink())
        self.assertEqual((self.computer.workspace / "alias").read_text(), "hello")

    def malicious_archive(self, names):
        path = self.root / "malicious.tar.gz"
        with tarfile.open(path, "w:gz") as archive:
            for name, link in names:
                item = tarfile.TarInfo(name)
                if link:
                    item.type = tarfile.SYMTYPE
                    item.linkname = link
                    archive.addfile(item)
                else:
                    item.size = 4
                    archive.addfile(item, io.BytesIO(b"evil"))
        return path

    def test_archive_traversal_cannot_modify_existing_workspace(self):
        self.action("existing", type="writeFile", path="keep.txt", content="keep")
        for names in [[("../outside", None)], [("/tmp/outside", None)], [("escape", "../../"), ("escape/outside", None)]]:
            with self.assertRaises(ValueError):
                self.computer.restore(self.malicious_archive(names))
            self.assertEqual((self.computer.workspace / "keep.txt").read_text(), "keep")

    def test_archive_member_cannot_traverse_even_contained_symlink(self):
        with self.assertRaises(ValueError):
            self.computer.restore(self.malicious_archive([("alias", "nested"), ("alias/file", None)]))

    def test_archive_symlink_cycle_is_rejected(self):
        with self.assertRaises(ValueError):
            self.computer.restore(self.malicious_archive([("a", "b"), ("b", "a")]))

    def test_http_management_requires_token(self):
        http = server.ComputerHTTPServer(("127.0.0.1", 0), server.create_handler(self.computer, "test-token"))
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{http.server_port}"
            with self.assertRaises(urllib.error.HTTPError) as denied:
                urllib.request.urlopen(url + "/health")
            self.assertEqual(denied.exception.code, 401)
            request = urllib.request.Request(url + "/health", headers={"Authorization": "Bearer test-token"})
            with urllib.request.urlopen(request) as response:
                health = json.load(response)
            self.assertTrue(health["ok"])
            self.assertEqual(health["bootId"], self.computer.boot_id)
            self.assertIn("execSessions", health["capabilities"])
            request = urllib.request.Request(url + "/actions", data=json.dumps({"operationId":"http", "action":{"type":"exec","command":"printf actual-process"}}).encode(), headers={"Authorization":"Bearer test-token","Content-Type":"application/json"})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response)["output"], "actual-process")
        finally:
            http.shutdown()
            http.server_close()

    def test_http_server_starts_with_a_cloudflare_hostname_too_long_for_idna(self):
        hostname = "a" * 64
        def reject_fqdn(_host):
            return hostname.encode("idna").decode()
        with patch("socket.getfqdn", side_effect=reject_fqdn) as lookup:
            http = server.ComputerHTTPServer(("0.0.0.0", 0), server.create_handler(self.computer, "test-token"))
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                request = urllib.request.Request(f"http://127.0.0.1:{http.server_port}/health", headers={"Authorization": "Bearer test-token"})
                with urllib.request.urlopen(request) as response:
                    self.assertTrue(json.load(response)["ok"])
                self.assertEqual(http.server_name, "timber-computer")
                lookup.assert_not_called()
            finally:
                http.shutdown()
                http.server_close()


if __name__ == "__main__":
    unittest.main()
