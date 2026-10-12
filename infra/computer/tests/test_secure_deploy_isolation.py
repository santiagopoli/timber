"""Synthetic canary proof that the shared Linux computer is not a deploy sandbox.

This test uses no real credentials: it demonstrates that a sibling process under
this VM's normal trust boundary can inspect another child process's environment.
"""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
import server


class SecureDeployIsolationTests(unittest.TestCase):
    def test_computer_child_env_inherits_arbitrary_values_and_sibling_can_read_proc(self):
        canary_name = "TIMBER_SECURE_DEPLOY_SYNTHETIC_CANARY"
        canary = "synthetic-only-canary-not-a-credential"
        old_value = os.environ.get(canary_name)
        os.environ[canary_name] = canary
        proc = None
        with tempfile.TemporaryDirectory(prefix="timber-deploy-isolation-") as scratch:
            try:
                child_env = server.Computer.child_env()
                self.assertEqual(child_env.get(canary_name), canary)
                # The computer token is explicitly removed, but other env values
                # are inherited into ordinary shell/build subprocesses.
                child_env["BOTSPACE_COMPUTER_TOKEN"] = "synthetic-computer-auth-canary"
                cleaned = server.Computer.child_env()
                self.assertNotIn("BOTSPACE_COMPUTER_TOKEN", cleaned)
                self.assertEqual(cleaned.get(canary_name), canary)

                # A long-lived synthetic child lets an independent sibling read
                # its /proc environ. No canary is put in argv, a file, or stdout.
                code = "import time; time.sleep(60)"
                proc = subprocess.Popen(
                    [sys.executable, "-c", code],
                    cwd=scratch,
                    env=cleaned,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                environ_path = Path(f"/proc/{proc.pid}/environ")
                deadline = time.monotonic() + 3
                observed = b""
                while time.monotonic() < deadline:
                    try:
                        observed = environ_path.read_bytes()
                    except (FileNotFoundError, PermissionError, ProcessLookupError):
                        time.sleep(0.02)
                        continue
                    if canary.encode() in observed:
                        break
                    time.sleep(0.02)
                self.assertIn(canary_name.encode() + b"=" + canary.encode(), observed)
                # An independent, credentialless sibling models an untrusted hook.
                sibling_env = {k: v for k, v in cleaned.items() if k != canary_name}
                hook = "import pathlib,sys; raw=pathlib.Path('/proc/'+sys.argv[1]+'/environ').read_bytes(); print('observed' if (sys.argv[2]+'=').encode() in raw else 'hidden')"
                sibling = subprocess.run([sys.executable, "-c", hook, str(proc.pid), canary_name], env=sibling_env, cwd=scratch, capture_output=True, check=True, timeout=3)
                self.assertEqual(sibling.stdout.strip(), b"observed")

            finally:
                if proc is not None and proc.poll() is None:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait(timeout=3)
                if old_value is None:
                    os.environ.pop(canary_name, None)
                else:
                    os.environ[canary_name] = old_value


if __name__ == "__main__":
    unittest.main()
