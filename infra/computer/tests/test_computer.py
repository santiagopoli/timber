import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

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
        result = self.action("timeout", type="exec", command="printf ready; sleep 10; touch too-late", timeoutMs=50)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["output"], "ready")
        self.assertIn("timed out", result["error"])
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
        http = ThreadingHTTPServer(("127.0.0.1", 0), server.create_handler(self.computer, "test-token"))
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
            request = urllib.request.Request(url + "/actions", data=json.dumps({"operationId":"http", "action":{"type":"exec","command":"printf actual-process"}}).encode(), headers={"Authorization":"Bearer test-token","Content-Type":"application/json"})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response)["output"], "actual-process")
        finally:
            http.shutdown()
            http.server_close()


if __name__ == "__main__":
    unittest.main()
