"""Synthetic-only checks for the private secure-deploy boundary (no live credentials)."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import hashlib
import json
import subprocess

sys.path.insert(0, str(Path(__file__).parents[1]))
import secure_deploy
import secure_deploy_runner
import server


class SecureDeployIsolationTests(unittest.TestCase):
    def test_shell_environment_is_allowlisted_and_drops_controller_token(self):
        names = {
            "TIMBER_SECURE_DEPLOY_SYNTHETIC_CANARY": "synthetic-canary-only",
            "BOTSPACE_COMPUTER_TOKEN": "synthetic-computer-token-only",
            "CLOUDFLARE_API_TOKEN": "synthetic-provider-token-only",
        }
        old = {key: os.environ.get(key) for key in names}
        try:
            os.environ.update(names)
            env = server.Computer.child_env()
            self.assertNotIn("TIMBER_SECURE_DEPLOY_SYNTHETIC_CANARY", env)
            self.assertNotIn("BOTSPACE_COMPUTER_TOKEN", env)
            self.assertNotIn("CLOUDFLARE_API_TOKEN", env)
            self.assertEqual(env["PATH"], "/usr/local/bin:/usr/bin:/bin")
        finally:
            for key, value in old.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_pinned_artifact_open_rejects_symlink_traversal(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "workspace"
            root.mkdir()
            outside = Path(temp) / "outside.js"
            outside.write_text("export default {}")
            (root / "worker.js").symlink_to(outside)
            with self.assertRaises(ValueError):
                secure_deploy._read_pinned_file(root, "worker.js")
            with self.assertRaises(ValueError):
                secure_deploy._read_pinned_file(root, "../outside.js")

    def test_runner_rejects_unapproved_header_prefix_without_echoing_value(self):
        auth = {
            "version": 1, "operationId": "op1", "signature": "synthetic-signature-only",
            "pin": {"repository": "owner/repo", "commit": "a" * 40,
                    "artifactDigest": "sha256:" + "0" * 64, "artifactPath": "dist/worker.js",
                    "accountId": "a" * 32, "workerName": "worker",
                    "destination": "https://api.cloudflare.com/client/v4/accounts/" + "a" * 32 + "/workers/scripts/worker"},
            "refs": [{"id": "ref1", "revision": 1, "permissionEpoch": "epoch", "binding": "synthetic-binding-only"}],
        }
        pin = dict(auth["pin"])
        request = {
            "protocolVersion": 1, "operationId": "op1", "authorization": auth,
            "pin": pin, "artifact": {"sha256": "sha256:" + "0" * 64, "javascript": "export default {}"},
            "credentials": [{"refId": "ref1", "revision": 1, "header": "X-Other", "prefix": "", "value": "synthetic-only-canary"}],
        }
        with self.assertRaises(ValueError):
            secure_deploy_runner._validate(request)
        self.assertNotIn("synthetic-only-canary", secure_deploy.CODES)


    def _task_request(self, task_id):
        js = "export default {}"
        digest = "sha256:" + hashlib.sha256(js.encode()).hexdigest()
        pin = {
            "repository": "owner/repo", "commit": "a" * 40,
            "artifactDigest": digest, "artifactPath": "dist/worker.js",
            "accountId": "a" * 32, "workerName": "worker",
            "destination": "https://api.cloudflare.com/client/v4/accounts/" + "a" * 32 + "/workers/scripts/worker",
        }
        ref = {"id": "123e4567-e89b-42d3-a456-426614174000", "revision": 1,
               "permissionEpoch": "synthetic-epoch", "binding": "synthetic-binding-only"}
        signed_pin = {**pin, "planId": "123e4567-e89b-42d3-a456-426614174001", "planRevision": 1}
        auth = {
            "version": 1, "ownerId": "owner", "botId": "123e4567-e89b-42d3-a456-426614174002",
            "runId": "123e4567-e89b-42d3-a456-426614174003", "nativeOperationId": "op-native",
            "operationId": "op-task", "pin": signed_pin, "planId": signed_pin["planId"],
            "planRevision": 1, "refs": [ref], "expiresAt": int(__import__("time").time() * 1000) + 60000,
            "signature": "synthetic-signature-only-32bytes",
        }
        if task_id is not None:
            auth["taskId"] = task_id
        credential = {"refId": ref["id"], "revision": 1, "header": "Authorization",
                      "prefix": "Bearer ", "value": "synthetic-only-canary"}
        return {"operationId": "op-task", "authorization": auth, "pin": pin,
                "refs": [ref], "credentials": [credential]}, js

    def test_task_id_is_optional_signed_uuid_and_malformed_task_is_rejected_before_child(self):
        task_id = "123e4567-e89b-42d3-a456-426614174004"
        valid, js = self._task_request(task_id)
        auth, _, _ = secure_deploy._validate_request(valid)
        self.assertEqual(auth["taskId"], task_id)
        bad, _ = self._task_request("not-a-uuid")
        with patch.object(secure_deploy.subprocess, "Popen") as spawn:
            result = secure_deploy.dispatch(Path("/not-read"), bad)
        self.assertEqual(result["status"], "rejected")
        spawn.assert_not_called()
        ordinary, _ = self._task_request(None)
        auth, _, _ = secure_deploy._validate_request(ordinary)
        self.assertNotIn("taskId", auth)

    def test_cli_nonzero_after_synthetic_upload_marker_is_uncertain(self):
        request, js = self._task_request("123e4567-e89b-42d3-a456-426614174004")
        request["protocolVersion"] = 1
        request["artifact"] = {"sha256": request["pin"]["artifactDigest"], "javascript": js}
        with tempfile.TemporaryDirectory() as temp:
            marker = Path(temp) / "upload-marker"
            fake_cli = Path(temp) / "fake-wrangler"
            fake_cli.write_text(
                "#!/bin/sh\nprintf 'effect\n' >> " + repr(str(marker)) + "\nexit 1\n"
            )
            fake_cli.chmod(0o755)
            runner_copy = Path(temp) / "runner.py"
            source = Path(secure_deploy_runner.__file__).read_text()
            source = source.replace('WRANGLER = "/usr/local/bin/wrangler"',
                                    "WRANGLER = " + repr(str(fake_cli)))
            runner_copy.write_text(source)
            run = subprocess.run(
                [sys.executable, str(runner_copy)], input=json.dumps(request).encode(),
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
            )
            self.assertEqual(run.returncode, 0)
            self.assertEqual(run.stdout.strip(),
                             b'{"status":"interrupted","code":"runner_outcome_unknown"}')
            self.assertEqual(marker.read_text().splitlines(), ["effect"])

    def test_runner_accepts_signed_task_uuid_and_rejects_malformed_task(self):
        request, js = self._task_request("123e4567-e89b-42d3-a456-426614174004")
        digest = request["pin"]["artifactDigest"]
        runner_request = {
            "protocolVersion": 1, "operationId": request["operationId"],
            "authorization": request["authorization"], "pin": request["pin"],
            "artifact": {"sha256": digest, "javascript": js},
            "credentials": request["credentials"],
        }
        pin, _, _ = secure_deploy_runner._validate(runner_request)
        self.assertEqual(pin["workerName"], "worker")
        runner_request["authorization"] = {**request["authorization"], "taskId": "malformed"}
        with self.assertRaises(ValueError):
            secure_deploy_runner._validate(runner_request)

    def test_shared_unconfigured_vm_reports_secure_deploy_unsupported(self):
        # Unit-test hosts are not the hardened Docker image; never accept a
        # caller-provided flag or test stub as proof of deployment isolation.
        ready = server.secure_deploy_capabilities()
        self.assertFalse(ready["secureDeploy"])
        self.assertFalse(ready["privateCredentialChannel"])
        self.assertFalse(ready["noShellEnv"])
        self.assertFalse(ready["noBuildCredentialInheritance"])


if __name__ == "__main__":
    unittest.main()
