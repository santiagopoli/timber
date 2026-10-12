"""Real TCP/WebSocket + Linux PTY tests; no shell execution is mocked."""
import base64
import http.client
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import shell_bridge as shell
import server

TOKEN = "test-only-shell-token-000000000000"


class Client:
    def __init__(self, port, token=TOKEN, ident=None, expiry=None, extra=""):
        self.ident = ident or str(uuid.uuid4())
        self.sock = socket.create_connection(("127.0.0.1", port), 3)
        # Startup can consume the bounded helper timeout, followed by guarded
        # cleanup before HTTP rejection. Don't race that boundary at 3 seconds.
        self.sock.settimeout(10)
        headers = (f"GET /shell HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: {shell.PROTOCOL}\r\n"
                   f"Sec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode()}\r\nAuthorization: Bearer {token}\r\n"
                   f"X-Timber-Shell-Session: {self.ident}\r\nX-Timber-Shell-Expires: {expiry or int(time.time()*1000)+59000}\r\n{extra}\r\n")
        self.sock.sendall(headers.encode())
        response = bytearray()
        while not response.endswith(b"\r\n\r\n"):
            response.extend(self.sock.recv(1))
        self.status = int(response.split(b" ")[1])
        self.sock.settimeout(3)
        self.output = ""

    def send(self, message, opcode=1):
        payload = json.dumps(message).encode() if not isinstance(message, bytes) else message
        mask = os.urandom(4)
        header = bytes([128 | opcode, 128 | len(payload)]) if len(payload) < 126 else bytes([128 | opcode, 254]) + struct.pack("!H", len(payload))
        self.sock.sendall(header + mask + bytes(b ^ mask[i%4] for i,b in enumerate(payload)))

    def exact(self, size):
        data = bytearray()
        while len(data) < size:
            chunk = self.sock.recv(size-len(data))
            if not chunk:
                raise EOFError()
            data.extend(chunk)
        return data

    def receive(self):
        first, size = self.exact(2)
        if size == 126:
            size = struct.unpack("!H", self.exact(2))[0]
        payload = self.exact(size)
        if first & 15 == 8:
            return {"type": "close"}
        message = json.loads(payload)
        if message["type"] == "output":
            self.output += message["data"]
        return message

    def until(self, text):
        deadline = time.monotonic()+5
        while text not in self.output and time.monotonic() < deadline:
            self.receive()
        if text not in self.output:
            raise AssertionError(self.output[-1000:])
        return self.output

    def close(self):
        self.sock.close()


class ShellBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.manager = shell.ShellManager(self.tmp.name)
        self.bridge = shell.start_bridge(self.manager, TOKEN, "127.0.0.1", 0)
        self.port = self.bridge.server_address[1]
        self.clients = []

    def tearDown(self):
        for client in self.clients:
            client.close()
        self.manager.close()
        self.bridge.shutdown()
        self.bridge.server_close()
        self.tmp.cleanup()

    def client(self, **kwargs):
        client = Client(self.port, **kwargs)
        self.clients.append(client)
        return client

    def wait_closed(self):
        deadline = time.monotonic()+5
        while self.manager.session and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertIsNone(self.manager.session)

    def test_auth_duplicate_and_protocol_lease_fail_closed(self):
        for options, status in [({"token": "wrong"}, 401), ({"extra": f"Authorization: Bearer {TOKEN}\r\n"}, 401),
                                ({"ident": "not-uuid"}, 400), ({"expiry": int(time.time()*1000)-1}, 400),
                                ({"expiry": int(time.time()*1000)+61000}, 400),
                                ({"extra": "Sec-WebSocket-Protocol: bad\r\n"}, 400)]:
            self.assertEqual(self.client(**options).status, status)
            self.assertIsNone(self.manager.session)
        self.assertTrue(shell.ready(TOKEN, self.port))
        self.assertFalse(shell.ready("wrong", self.port))

    def test_real_tty_input_resize_ctrl_c_exit_clean_environment(self):
        with patch.dict(os.environ, {"BOTSPACE_COMPUTER_TOKEN": "secret-never-in-shell", "OPENAI_API_KEY": "secret-never-in-shell"}):
            client = self.client()
        self.assertEqual(client.status, 101)
        client.send({"type": "resize", "cols": 113, "rows": 37})
        client.send({"type": "input", "data": "printf '\\nTTY:'; test -t 0 && test -t 1 && test -t 2 && echo yes; stty size; pwd; env | grep -E 'BOTSPACE|OPENAI' || echo CLEAN_ENV\n"})
        client.until("TTY:yes")
        client.until("37 113")
        client.until("\r\nCLEAN_ENV\r\n")
        client.until(self.tmp.name)
        self.assertNotIn("secret-never-in-shell", client.output)
        client.send({"type": "input", "data": "sleep 30\n"})
        time.sleep(.1)
        client.send({"type": "input", "data": "\u0003"})
        client.send({"type": "input", "data": "printf '\\nINTERRUPTED:%s\\n' \"$?\"\n"})
        client.until("INTERRUPTED:130")
        client.send({"type": "input", "data": "exit 7\n"})
        messages = []
        while not any(m["type"] == "exit" for m in messages):
            messages.append(client.receive())
        self.assertIn({"type": "exit", "exitCode": 7}, messages)
        self.wait_closed()

    def test_bash_exit_drains_buffered_output_and_kills_inherited_background(self):
        client = self.client()
        client.send({"type": "input", "data": "sleep 90 & printf 'TAIL_BEGIN'; printf '%10000s' '' | tr ' ' z; printf 'TAIL_END'; exit 4\n"})
        messages = []
        while not any(m["type"] == "exit" for m in messages):
            messages.append(client.receive())
        self.assertIn({"type": "exit", "exitCode": 4}, messages)
        self.assertIn("TAIL_BEGIN" + "z"*10000 + "TAIL_END", client.output)
        self.wait_closed()

    def test_one_session_renew_deadline_and_snapshot_guard(self):
        client = self.client()
        self.assertEqual(self.client().status, 409)
        with self.assertRaises(ValueError):
            with self.manager.checkpoint_guard():
                pass
        self.assertEqual(self.manager.renew(client.ident, int(time.time()*1000)+59000), {"ok": True})
        hard = self.manager.session.hard = time.monotonic()+.1
        self.manager.renew(client.ident, int(time.time()*1000)+59000)
        self.assertEqual(self.manager.session.hard, hard)
        self.assertLessEqual(self.manager.session.expires, hard)
        found = []
        while not any(m["type"] == "error" for m in found):
            found.append(client.receive())
        self.assertIn({"type": "error", "code": "shell_lease_expired"}, found)
        self.wait_closed()
        with self.manager.checkpoint_guard():
            self.assertEqual(self.client().status, 409)

    def test_disconnect_kills_background_and_detached_descendants(self):
        client = self.client()
        client.send({"type": "input", "data": "sleep 90 & echo $! > bg; setsid sh -c 'echo $$ > detached; exec sleep 90' >/dev/null 2>&1 &\n"})
        deadline = time.monotonic()+3
        paths = [Path(self.tmp.name)/name for name in ("bg", "detached")]
        while not all(p.exists() for p in paths) and time.monotonic() < deadline:
            time.sleep(.02)
        pids = [int(p.read_text()) for p in paths]
        client.close()
        self.wait_closed()
        for pid in pids:
            path = Path(f"/proc/{pid}/stat")
            if path.exists():
                self.assertEqual(path.read_text().rsplit(")", 1)[1].split()[0], "Z")

    def test_env_i_setsid_double_fork_writer_is_reaped_and_unrelated_survives(self):
        # Both processes have empty environments and detach. Only the writer
        # launched under this session's dedicated subreaper belongs to it.
        script = Path(self.tmp.name) / "escape.py"
        script.write_text("""import os, sys, time
if os.fork(): os._exit(0)
os.setsid()
if os.fork(): os._exit(0)
os.chdir(sys.argv[1])
open('escaped.pid', 'w').write(str(os.getpid()))
fd = os.open('writes', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
while True:
    os.write(fd, b'x')
    time.sleep(.005)
""")
        unrelated = subprocess.Popen(["/usr/bin/env", "-i", "/usr/bin/setsid", "/bin/sleep", "90"],
                                     env={})
        try:
            client = self.client()
            session = self.manager.session
            self.assertNotEqual(session.helper.pid, os.getpid())
            client.send({"type": "input", "data": f"env -i /usr/bin/python3 {script} {self.tmp.name} >/dev/null 2>&1 &\n"})
            pidfile = Path(self.tmp.name) / "escaped.pid"
            writes = Path(self.tmp.name) / "writes"
            deadline = time.monotonic() + 3
            while (not pidfile.exists() or not writes.exists()) and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(pidfile.exists())
            pid = int(pidfile.read_text())
            # Prove the env marker is absent and reparenting completed before
            # cleanup. Setsid + doublefork previously escaped all sampled scans.
            deadline = time.monotonic() + 3
            while shell.process_table()[pid][0] != session.helper.pid and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(shell.process_table()[pid][0], session.helper.pid)
            self.assertNotIn(b"TIMBER_SHELL_SESSION", Path(f"/proc/{pid}/environ").read_bytes())
            self.assertEqual(self.manager.close(client.ident), {"ok": True})
            self.assertFalse(Path(f"/proc/{pid}").exists(), "detached writer was not reaped")
            size = writes.stat().st_size
            time.sleep(.1)
            self.assertEqual(writes.stat().st_size, size)
            self.assertIsNone(unrelated.poll(), "unrelated detached process was killed")
        finally:
            unrelated.kill()
            unrelated.wait()

    def test_failed_handler_cleanup_stays_guarded_and_explicit_close_retries(self):
        client = self.client()
        session = self.manager.session
        real_cleanup = session.cleanup
        calls = []

        def transient_failure():
            calls.append(True)
            if len(calls) <= 2:
                raise shell.ShellError("shell_cleanup_pending", 503)
            real_cleanup()

        with patch.object(session, "cleanup", side_effect=transient_failure):
            client.close()
            self.assertTrue(session.run_done.wait(3))
            self.assertFalse(session.done.is_set())
            self.assertIs(self.manager.session, session)
            self.assertTrue(session.stop.is_set())
            self.assertIsNone(session.helper.poll())
            self.assertTrue(Path(f"/proc/{session.pid}").exists())
            with self.assertRaises(shell.ShellError) as error:
                self.manager.renew(client.ident, int(time.time()*1000)+59000)
            self.assertEqual(error.exception.code, "shell_session_not_found")
            with self.assertRaises(ValueError):
                with self.manager.checkpoint_guard():
                    pass
            self.assertEqual(self.client().status, 409)
            with self.assertRaises(shell.ShellError) as error:
                self.manager.close(client.ident)
            self.assertEqual(error.exception.code, "shell_cleanup_pending")
            self.assertIs(self.manager.session, session)
            self.assertFalse(session.done.is_set())
            self.assertEqual(self.manager.close(client.ident), {"ok": True})
        self.assertEqual(len(calls), 3)
        self.assertTrue(session.done.is_set())
        self.assertIsNone(self.manager.session)
        self.assertFalse(Path(f"/proc/{session.pid}").exists())
        with self.manager.checkpoint_guard():
            pass
        self.assertEqual(self.client(ident=client.ident).status, 409)

    def test_limits_invalid_json_binary_and_frame(self):
        for payload, opcode, code in [(b"bad", 1, "shell_invalid_message"), (b"binary", 2, "shell_invalid_message"),
                                       ({"type": "resize", "cols": True, "rows": 20}, 1, "shell_invalid_message"),
                                       (b"x"*(shell.MAX_FRAME+1), 1, "shell_frame_limit")]:
            client = self.client()
            client.send(payload, opcode)
            found = []
            while not any(m["type"] == "error" for m in found):
                found.append(client.receive())
            self.assertIn({"type": "error", "code": code}, found)
            self.wait_closed()
        with patch.object(shell, "MAX_OUTPUT", 4096):
            client = self.client()
            client.send({"type": "input", "data": "yes output\n"})
            found = []
            while not any(m["type"] == "error" for m in found):
                found.append(client.receive())
            self.assertIn({"type": "error", "code": "shell_output_limit"}, found)
            self.wait_closed()
        with patch.object(shell, "MAX_INPUT", 8):
            client = self.client()
            client.send({"type": "input", "data": "too much input"})
            found = []
            while not any(m["type"] == "error" for m in found):
                found.append(client.receive())
            self.assertIn({"type": "error", "code": "shell_input_limit"}, found)
            self.wait_closed()

    def test_invalid_utf8_output_replacement_stays_within_text_budget(self):
        with patch.object(shell, "MAX_OUTPUT", 4096):
            client = self.client()
            client.send({"type": "input", "data": "head -c 20000 /dev/zero | tr '\\000' '\\377'\n"})
            messages = []
            while not any(m["type"] == "error" for m in messages):
                messages.append(client.receive())
            self.assertIn({"type": "error", "code": "shell_output_limit"}, messages)
            self.assertLessEqual(len(client.output.encode("utf-8")), 4096)
            self.wait_closed()

    def test_close_all_kills_bash_and_is_idempotent(self):
        client = self.client()
        self.assertEqual(self.manager.close(str(uuid.uuid4())), {"ok": True})
        self.assertIsNotNone(self.manager.session)
        pid = self.manager.session.pid
        self.assertEqual(self.manager.close(), {"ok": True})
        self.assertEqual(self.manager.close(), {"ok": True})
        self.assertFalse(Path(f"/proc/{pid}").exists())
        self.assertEqual(self.client().status, 101)

    def test_slow_reader_is_bounded_and_terminated(self):
        with patch.object(shell, "SEND_TIMEOUT", .1):
            client = self.client()
            client.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
            client.send({"type": "input", "data": "yes flood\n"})
            self.wait_closed()

    def test_fail_closed_configuration_and_strict_wire_frames(self):
        for token in ("", "short", None):
            with self.assertRaises(ValueError):
                shell.create_handler(self.manager, token)
        for raw in (b"\x81\x00", b"\x01\x80", b"\xc1\x80", b"\x89\xfe\x00\x7e", b"\x81\xff"):
            with self.assertRaises(shell.ShellError):
                shell.parse_frame(bytearray(raw))
        with patch.object(shell, "MAX_PENDING_INPUT", 8):
            client = self.client()
            client.send({"type": "input", "data": "input queue capped"})
            found = []
            while not any(m["type"] == "error" for m in found):
                found.append(client.receive())
            self.assertIn({"type": "error", "code": "shell_input_limit"}, found)
            self.wait_closed()

    def test_bridge_port_internal_authenticated_controls(self):
        client = self.client()
        def post(path, body, token=TOKEN):
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            conn.request("POST", path, json.dumps(body), {"Authorization": "Bearer "+token, "Content-Type": "application/json"})
            response = conn.getresponse()
            result = response.status, json.loads(response.read())
            conn.close()
            return result
        self.assertEqual(post("/shell/renew", {"sessionId":client.ident,"expiresAt":int(time.time()*1000)+59000}), (200,{"ok":True}))
        self.assertEqual(post("/shell/close", {"sessionId":client.ident}, "wrong")[0], 401)
        self.assertIsNotNone(self.manager.session)
        self.assertEqual(post("/shell/close", {"sessionId":client.ident}), (200,{"ok":True}))
        self.assertEqual(post("/shell/close-all", {}), (200,{"ok":True}))
        self.assertIsNone(self.manager.session)

    def test_close_before_upgrade_and_one_use_bounded_fences(self):
        ident = str(uuid.uuid4())
        self.assertEqual(self.manager.close(ident), {"ok": True})
        self.assertEqual(self.client(ident=ident).status, 409)
        self.assertIsNone(self.manager.session)
        client = self.client()
        self.manager.close(client.ident)
        self.assertEqual(self.client(ident=client.ident).status, 409)
        with patch.object(shell, "MAX_SESSION_FENCES", 2):
            self.assertEqual(self.client().status, 503)
        self.assertIsNone(self.manager.session)
        self.assertEqual(self.manager.close_all(), {"ok": True})
        self.assertEqual(self.client().status, 409)
        self.assertIsNone(self.manager.session)

    def test_interactive_bash_does_not_persist_terminal_history(self):
        history = Path(self.tmp.name) / ".bash_history"
        history.write_text("existing owner history\n")
        client = self.client()
        client.send({"type": "input", "data": "printf '\\nHISTORY:%s:%s:%s\\n' \"$HISTFILE\" \"$HISTSIZE\" \"$HISTFILESIZE\"\n"})
        client.until("HISTORY:/dev/null:0:0")
        client.send({"type": "input", "data": "echo new-terminal-input-must-not-be-saved; exit 0\n"})
        messages = []
        while not any(m["type"] == "exit" for m in messages):
            messages.append(client.receive())
        self.wait_closed()
        self.assertEqual(history.read_text(), "existing owner history\n")

    def test_lease_expiry_without_renew(self):
        client = self.client(expiry=int(time.time()*1000)+200)
        found = []
        while not any(m["type"] == "error" for m in found):
            found.append(client.receive())
        self.assertIn({"type": "error", "code": "shell_lease_expired"}, found)
        self.wait_closed()


class ShellControlTests(unittest.TestCase):
    def test_real_http_renew_close_checkpoint_and_health(self):
        with tempfile.TemporaryDirectory() as directory:
            computer = server.Computer(Path(directory)/"workspace", Path(directory)/"state")
            bridge = shell.start_bridge(computer.shell, TOKEN, "127.0.0.1", 0)
            port = bridge.server_address[1]
            control = server.ComputerHTTPServer(("127.0.0.1", 0), server.create_handler(computer, TOKEN))
            thread = threading.Thread(target=control.serve_forever, daemon=True)
            thread.start()
            client = Client(port)
            def post(path, body, auth=TOKEN):
                conn = http.client.HTTPConnection("127.0.0.1", control.server_address[1], timeout=5)
                conn.request("POST", path, json.dumps(body), {"Authorization": "Bearer "+auth, "Content-Type": "application/json"})
                response = conn.getresponse()
                result = response.status, json.loads(response.read())
                conn.close()
                return result
            try:
                self.assertEqual(post("/shell/renew", {"sessionId":client.ident,"expiresAt":int(time.time()*1000)+59000}), (200,{"ok":True}))
                self.assertEqual(post("/shell/close", {"sessionId":client.ident}, "wrong")[0], 401)
                self.assertEqual(post("/checkpoint", {})[0], 400)
                self.assertEqual(post("/shell/close", {"sessionId":client.ident}), (200,{"ok":True}))
                self.assertEqual(post("/shell/close-all", {}), (200,{"ok":True}))
                self.assertEqual(post("/shell/renew", {"sessionId":client.ident,"expiresAt":int(time.time()*1000)+59000})[0], 404)
                for bridge_ready in (True, False):
                    with patch.object(shell, "ready", return_value=bridge_ready), patch.object(server.shutil, "which", return_value=None):
                        conn = http.client.HTTPConnection("127.0.0.1", control.server_address[1], timeout=3)
                        conn.request("GET", "/health", headers={"Authorization":"Bearer "+TOKEN})
                        capabilities = json.loads(conn.getresponse().read())["capabilities"]
                        self.assertIn("shellPtySupported", capabilities)
                        self.assertEqual("shellPty" in capabilities, bridge_ready)
                        conn.close()
            finally:
                client.close()
                computer.close()
                control.shutdown()
                control.server_close()
                bridge.shutdown()
                bridge.server_close()


if __name__ == "__main__":
    unittest.main()
