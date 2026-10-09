"""Real subprocess coverage for queryable, cancellable execution sessions."""
import json
import http.client
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
import server


class ExecutionSessionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.computer = server.Computer(self.root / "workspace", self.root / "state")

    def tearDown(self):
        self.computer.close()
        self.tmp.cleanup()

    def poll(self, process_id, yield_ms=0, operation_id="poll"):
        return self.computer.execute(operation_id, {"type": "execPoll", "processId": process_id, "yieldMs": yield_ms})

    def until(self, process_id, accept):
        deadline = time.monotonic() + 5
        result = self.poll(process_id)
        while not accept(result) and time.monotonic() < deadline:
            time.sleep(0.02)
            result = self.poll(process_id)
        self.assertTrue(accept(result), result)
        return result

    def test_yield_returns_running_and_poll_keeps_process_alive_without_timeout(self):
        action = {"type": "exec", "command": "printf before; while [ ! -f release ]; do sleep .02; done; printf after", "yieldMs": 0}
        started = self.computer.execute("process", action)
        self.assertEqual(started["status"], "running")
        self.assertEqual(started["processId"], "process")
        partial = self.until("process", lambda value: value["output"] == "before")
        self.assertEqual(partial["status"], "running")
        # Another action proceeds while the first shell and a long poll wait.
        waiting = []
        thread = threading.Thread(target=lambda: waiting.append(self.poll("process", 30000)))
        thread.start()
        second = self.computer.execute("second", {"type": "exec", "command": "printf independent"})
        self.assertEqual(second["output"], "independent")
        self.assertEqual(self.poll("process")["status"], "running")
        self.computer.execute("release", {"type": "writeFile", "path": "release", "content": "ready"})
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(waiting[0]["output"], "beforeafter")
        self.assertEqual(waiting[0]["status"], "completed")
        self.assertEqual(waiting[0]["exitCode"], 0)
        self.assertNotIn("poll", [row[0] for row in self.computer.db.execute("SELECT id FROM operations")])

    def test_start_receipt_loss_and_duplicate_starts_never_repeat_the_effect(self):
        action = {"type": "exec", "command": "printf x >> effects; printf ready; while [ ! -f release ]; do sleep .02; done; cat effects", "yieldMs": 0}
        self.computer.execute("same", action)
        self.until("same", lambda value: value["output"] == "ready")
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.computer.execute("same", action))) for _ in range(5)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(2)
        self.assertTrue(all(value["status"] == "running" for value in results))
        self.assertEqual(self.computer.execute("same", {**action, "yieldMs": 1})["status"], "running")
        (self.computer.workspace / "release").touch()
        final = self.until("same", lambda value: value["status"] == "completed")
        self.assertEqual(final["output"], "readyx")
        self.assertEqual(self.computer.execute("same", action)["output"], "readyx")
        self.assertEqual(self.computer.execute("same", {**action, "yieldMs": 30000})["output"], "readyx")
        self.assertEqual((self.computer.workspace / "effects").read_text(), "x")
        with self.assertRaises(ValueError):
            self.computer.execute("same", {**action, "command": "printf changed"})
        with self.assertRaises(server.IdempotencyConflict):
            self.computer.execute("same", {**action, "timeoutMs": 1000})

    def test_http_idempotency_conflict_has_a_fixed_code_and_no_second_effect(self):
        httpd = server.ComputerHTTPServer(("127.0.0.1", 0), server.create_handler(self.computer, "test-token"))
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            def request(operation_id, action):
                body = json.dumps({"operationId": operation_id, "action": action})
                connection.request("POST", "/actions", body, {"Authorization": "Bearer test-token", "Content-Type": "application/json"})
                response = connection.getresponse()
                return response.status, json.loads(response.read())

            self.assertEqual(request("start", {"type": "exec", "command": "printf x >> effects"})[0], 200)
            status, result = request("start", {"type": "exec", "command": "printf y >> effects"})
            self.assertEqual(status, 409)
            self.assertEqual(result["error"]["code"], "computer_idempotency_conflict")
            self.assertEqual((self.computer.workspace / "effects").read_text(), "x")
            self.assertEqual(request("stop", {"type": "execCancel", "processId": "first"})[0], 200)
            status, result = request("stop", {"type": "execCancel", "processId": "other"})
            self.assertEqual(status, 409)
            self.assertEqual(result["error"]["code"], "computer_idempotency_conflict")
            self.assertIsNone(self.computer.db.execute("SELECT id FROM execution_sessions WHERE id='other'").fetchone())
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()
            thread.join(2)

    def test_cancel_interrupts_a_long_poll_and_kills_descendants_retaining_output(self):
        self.computer.execute("cancel-me", {"type": "exec", "command": "printf ready; (sleep 1; touch escaped) & wait", "yieldMs": 0})
        self.until("cancel-me", lambda value: value["output"] == "ready")
        received = []
        thread = threading.Thread(target=lambda: received.append(self.poll("cancel-me", 30000)))
        thread.start()
        started = time.monotonic()
        cancelled = self.computer.execute("stop", {"type": "execCancel", "processId": "cancel-me"})
        self.assertLess(time.monotonic() - started, 1.5)
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["output"], "ready")
        self.assertLess(cancelled["exitCode"], 0)
        self.assertEqual(received[0]["status"], "cancelled")
        time.sleep(1)
        self.assertFalse((self.computer.workspace / "escaped").exists())
        self.assertEqual(self.computer.execute("stop-again", {"type": "execCancel", "processId": "cancel-me"})["status"], "cancelled")

    def test_prestart_cancellation_durably_fences_a_delayed_start(self):
        cancel = {"type": "execCancel", "processId": "delayed"}
        stopped = self.computer.execute("stop-first", cancel)
        self.assertEqual(stopped["status"], "cancelled")
        self.assertEqual(self.computer.execute("stop-first", cancel), stopped)
        with self.assertRaises(ValueError):
            self.computer.execute("stop-first", {"type": "execCancel", "processId": "different"})
        self.computer.close()
        self.computer = server.Computer(self.root / "workspace", self.root / "state")
        self.assertEqual(self.computer.execute("stop-first", cancel), stopped)
        result = self.computer.execute("delayed", {"type": "exec", "command": "touch must-not-run"})
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["processId"], "delayed")
        self.assertFalse((self.computer.workspace / "must-not-run").exists())

    def test_optional_timeout_has_no_short_maximum_and_invalid_values_are_rejected(self):
        for value in (120001, 86_400_000, server.MAX_SAFE_INTEGER):
            result = self.computer.execute(f"large-{value}", {"type": "exec", "command": "printf accepted", "timeoutMs": value})
            self.assertEqual(result["status"], "completed")
        for value in (0, -1, True, 1.5, None, float("inf"), server.MAX_SAFE_INTEGER + 1):
            with self.subTest(timeout=value), self.assertRaises(ValueError):
                self.computer.execute("invalid", {"type": "exec", "command": "touch invalid", "timeoutMs": value})
        for value in (-1, 30001, True, 0.5, None):
            with self.subTest(yield_ms=value), self.assertRaises(ValueError):
                self.computer.execute("invalid", {"type": "exec", "command": "touch invalid", "yieldMs": value})
        self.assertFalse((self.computer.workspace / "invalid").exists())

    def test_checkpoint_and_restore_reject_active_execution_without_stopping_it(self):
        archive = self.computer.checkpoint()
        self.computer.execute("active", {"type": "exec", "command": "printf ready; sleep 30", "yieldMs": 0})
        self.until("active", lambda value: value["output"] == "ready")
        with self.assertRaisesRegex(ValueError, "still running"):
            self.computer.checkpoint()
        with self.assertRaisesRegex(ValueError, "still running"):
            self.computer.restore(archive)
        self.assertEqual(self.poll("active")["status"], "running")
        self.computer.execute("cancel", {"type": "execCancel", "processId": "active"})
        self.assertTrue(self.computer.checkpoint().is_file())

    def test_server_crash_preserves_partial_output_and_never_replays_the_command(self):
        self.computer.close()
        command = "printf x >> effects; printf saved-before-crash; sleep 30; touch must-not-run"
        action = {"type": "exec", "command": command, "yieldMs": 0}
        script = """
import json, os, sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from server import Computer
computer = Computer(Path(sys.argv[2]), Path(sys.argv[3]))
computer.execute('crashed', json.loads(sys.argv[4]))
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    result = computer.execute('poll', {'type':'execPoll','processId':'crashed','yieldMs':0})
    if result['output'] == 'saved-before-crash':
        os._exit(0)
    time.sleep(.02)
os._exit(1)
"""
        crashed = subprocess.run([sys.executable, "-c", script, str(Path(server.__file__).parent), str(self.root / "workspace"), str(self.root / "state"), json.dumps(action)], capture_output=True, timeout=10)
        self.computer = server.Computer(self.root / "workspace", self.root / "state")
        self.assertEqual(crashed.returncode, 0, crashed.stderr.decode())
        result = self.poll("crashed")
        self.assertEqual(result["status"], "interrupted")
        self.assertEqual(result["output"], "saved-before-crash")
        self.assertEqual(self.computer.execute("crashed", action)["status"], "interrupted")
        self.assertEqual((self.computer.workspace / "effects").read_text(), "x")
        self.assertFalse((self.computer.workspace / "must-not-run").exists())

    def test_unknown_poll_is_interrupted_and_does_not_admit_work(self):
        result = self.poll("missing")
        self.assertEqual(result["status"], "interrupted")
        self.assertEqual(result["processId"], "missing")
        self.assertEqual(self.computer.db.execute("SELECT COUNT(*) FROM operations").fetchone()[0], 0)

    def test_crash_after_fork_before_identity_commit_cannot_start_command_effects(self):
        self.computer.close()
        action = {"type": "exec", "command": "touch must-not-run; sleep 30", "yieldMs": 0}
        script = """
import json, os, sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import server
computer = server.Computer(Path(sys.argv[2]), Path(sys.argv[3]))
original = server.subprocess.Popen
def crash_after_fork(*args, **kwargs):
    process = original(*args, **kwargs)
    Path(sys.argv[5]).write_text(str(process.pid))
    os._exit(0)
server.subprocess.Popen = crash_after_fork
computer.execute('fork-crash', json.loads(sys.argv[4]))
time.sleep(5)
os._exit(1)
"""
        pid_file = self.root / "fork-pid"
        crashed = subprocess.run([sys.executable, "-c", script, str(Path(server.__file__).parent), str(self.root / "workspace"), str(self.root / "state"), json.dumps(action), str(pid_file)], capture_output=True, timeout=10)
        self.computer = server.Computer(self.root / "workspace", self.root / "state")
        self.assertEqual(crashed.returncode, 0, crashed.stderr.decode())
        self.assertIsNone(self.computer.db.execute("SELECT pid FROM execution_sessions WHERE id='fork-crash'").fetchone()[0])
        self.assertEqual(self.computer.execute("fork-crash", action)["status"], "interrupted")
        pid = int(pid_file.read_text())
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
                if state == "Z":
                    break
            except FileNotFoundError:
                break
            time.sleep(0.02)
        else:
            self.fail("The launch wrapper remained alive after its parent crashed")
        self.assertFalse((self.computer.workspace / "must-not-run").exists())

    def test_launch_handshake_preserves_null_stdin_for_the_command(self):
        result = self.computer.execute("stdin", {"type": "exec", "command": "if read -r value; then printf unexpected-input; else printf eof; fi"})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["output"], "eof")

    def test_output_is_bounded_in_utf8_bytes_even_for_invalid_binary_output(self):
        result = self.computer.execute("binary", {"type": "exec", "command": "python3 -c 'import os; os.write(1, bytes([255]) * 160000)'"})
        self.assertEqual(result["status"], "completed")
        self.assertLessEqual(len(result["output"].encode("utf-8")), server.MAX_OUTPUT)
        self.assertIn("truncated", result["output"])


if __name__ == "__main__":
    unittest.main()
