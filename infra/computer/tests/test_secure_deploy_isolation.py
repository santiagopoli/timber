"""Synthetic-only checks for the private secure-deploy boundary (no live credentials)."""
import os
from pathlib import Path
import sys
import tempfile
import unittest

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
