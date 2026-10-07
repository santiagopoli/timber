"""Exercise Git against a real authenticated HTTPS smart-HTTP server."""
import sys
import importlib.util
import io
import json
import os
from pathlib import Path
import ssl
import subprocess
import tarfile
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location("git_computer_server", Path(__file__).parents[1] / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
CAPABILITY = "test-only-repository-capability-000000000000"


class GitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.computer = server.Computer(self.root / "workspace", self.root / "state")
        self.projects = self.root / "projects"
        self.remote = self.projects / "octo" / "private.git"
        self.remote.parent.mkdir(parents=True)
        self.git("init", "--bare", str(self.remote))
        self.git("--git-dir", str(self.remote), "config", "http.receivepack", "true")
        source = self.root / "source"
        source.mkdir()
        self.git("init", "-b", "main", str(source))
        (source / "README.md").write_text("private repository\n")
        self.git("-C", str(source), "add", "README.md")
        self.git("-C", str(source), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Initial")
        self.git("-C", str(source), "push", str(self.remote), "main")
        self.git("--git-dir", str(self.remote), "symbolic-ref", "HEAD", "refs/heads/main")
        self.cert = self.root / "cert.pem"
        key = self.root / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", str(key), "-out", str(self.cert), "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], check=True, capture_output=True)
        projects = self.projects
        requests = self.requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def handle_git(self):
                requests.append((self.command, self.path))
                if self.headers.get("Authorization") != f"Bearer {CAPABILITY}":
                    self.send_error(401)
                    return
                path, _, query = self.path.partition("?")
                length = int(self.headers.get("Content-Length", "0"))
                env = dict(os.environ, GIT_PROJECT_ROOT=str(projects), GIT_HTTP_EXPORT_ALL="1", PATH_INFO=path,
                           REQUEST_METHOD=self.command, QUERY_STRING=query, CONTENT_TYPE=self.headers.get("Content-Type", ""),
                           CONTENT_LENGTH=str(length), REMOTE_USER="fixture")
                result = subprocess.run(["git", "http-backend"], env=env, input=self.rfile.read(length), capture_output=True, check=True)
                head, body = result.stdout.split(b"\r\n\r\n", 1)
                self.send_response(200)
                for line in head.decode().split("\r\n"):
                    name, value = line.split(":", 1)
                    self.send_header(name, value.strip())
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = handle_git
            do_POST = handle_git

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.cert, key)
        self.http.socket = context.wrap_socket(self.http.socket, server_side=True)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.transport = {"url": f"https://localhost:{self.http.server_port}/octo/private.git", "token": CAPABILITY}
        self.environment = patch.dict(os.environ, {"GIT_SSL_CAINFO": str(self.cert)})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.http.shutdown()
        self.http.server_close()
        self.computer.db.close()
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", *args], check=True, capture_output=True).stdout.decode()

    def clone(self, operation="clone", path="repo"):
        return self.computer.execute(operation, {"type": "gitClone", "repository": "octo/private", "path": path}, self.transport)

    def test_private_clone_edit_push_and_checkpoint_without_credentials(self):
        # Record the actual process API to catch accidental command-line secrets.
        argv_seen = []
        real_run = self.computer.run_process
        def record(argv, timeout, cwd, env):
            argv_seen.append(argv)
            self.assertNotIn(CAPABILITY, " ".join(argv))
            return real_run(argv, timeout, cwd, env)
        with patch.object(self.computer, "run_process", side_effect=record):
            cloned = self.clone()
            self.assertEqual(cloned["status"], "completed", cloned)
            repo = self.computer.workspace / "repo"
            self.assertEqual((repo / "README.md").read_text(), "private repository\n")
            config = (repo / ".git" / "config").read_text()
            self.assertIn("https://github.com/octo/private.git", config)
            self.assertNotIn("localhost", config)
            self.git("-C", str(repo), "checkout", "-b", "timber/change")
            (repo / "README.md").write_text("edited and tested\n")
            self.git("-C", str(repo), "add", "README.md")
            self.git("-C", str(repo), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Edit")
            pushed = self.computer.execute("push", {"type": "gitPush", "repository": "octo/private", "path": "repo", "branch": "timber/change"}, self.transport)
            self.assertEqual(pushed["status"], "completed", pushed)
            self.assertEqual(self.git("--git-dir", str(self.remote), "show", "timber/change:README.md"), "edited and tested\n")
            requests_before = len(self.requests)
            replay = self.computer.execute("clone", {"type": "gitClone", "repository": "octo/private", "path": "repo"}, {"url": self.transport["url"], "token": "different-ephemeral-capability-000000"})
            self.assertEqual(replay, cloned)
            self.assertEqual(len(self.requests), requests_before)
        checkpoint = self.computer.checkpoint()
        with tarfile.open(checkpoint, "r:gz") as archive:
            contents = b"".join(archive.extractfile(item).read() for item in archive if item.isfile())
        self.assertNotIn(CAPABILITY.encode(), contents)
        self.assertNotIn(CAPABILITY.encode(), (self.computer.state / "operations.sqlite").read_bytes())
        self.assertNotIn(CAPABILITY, json.dumps([cloned, pushed]))
        self.assertTrue(any(argv[1] == "push" for argv in argv_seen))

    def test_rejects_unsafe_paths_branches_and_transport(self):
        (self.computer.workspace / "escape").symlink_to(self.root)
        for index, path in enumerate(["../outside", "/tmp/outside", "escape/clone", "."]):
            result = self.computer.execute(f"path-{index}", {"type": "gitClone", "repository": "octo/private", "path": path}, self.transport)
            self.assertEqual(result["status"], "failed")
        for index, branch in enumerate(["-force", "a..b", "refs/.secret", "topic.lock", "x//y"]):
            result = self.computer.execute(f"branch-{index}", {"type": "gitClone", "repository": "octo/private", "path": "repo", "branch": branch}, self.transport)
            self.assertEqual(result["status"], "failed")
        result = self.computer.execute("bad-url", {"type": "gitClone", "repository": "octo/private", "path": "repo"}, {"url": "file:///tmp/repo.git", "token": CAPABILITY})
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.requests, [])

    def test_push_rejects_repository_credential_helpers_and_includes(self):
        self.assertEqual(self.clone()["status"], "completed")
        repo = self.computer.workspace / "repo"
        marker = self.root / "helper-was-executed"
        self.git("-C", str(repo), "config", "credential.helper", f"!touch {marker}")
        before = len(self.requests)
        result = self.computer.execute("unsafe-config", {"type": "gitPush", "repository": "octo/private", "path": "repo", "branch": "main"}, self.transport)
        self.assertEqual(result["status"], "failed")
        self.assertIn("unsupported Git configuration", result["error"])
        self.assertFalse(marker.exists())
        self.assertEqual(len(self.requests), before)

    def test_clone_failure_does_not_leak_capability(self):
        transport = dict(self.transport, token="wrong-capability-that-must-stay-private-0000")
        result = self.computer.execute("denied", {"type": "gitClone", "repository": "octo/private", "path": "repo"}, transport)
        self.assertEqual(result["status"], "failed")
        self.assertNotIn(transport["token"], json.dumps(result))
        self.assertNotIn("localhost", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
