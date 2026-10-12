"""Private close fences and genuine UID10002 process lifecycle, no provider I/O."""
import json
import ctypes
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import secure_deploy as deploy
import test_secure_deploy_isolation as fixture


@unittest.skipUnless(os.geteuid() == 0 and shutil.which("setpriv"), "requires Linux UID-separated runner")
class PrivateCloseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="timber-private-close-")
        self.root = Path(self.tmp.name)
        self.root.chmod(0o755)
        self.status = self.root / "status"
        self.status.mkdir(mode=0o733)
        self.status.chmod(0o733)
        self.workspace = self.root / "workspace"
        (self.workspace / "dist").mkdir(parents=True)
        self.request, js = fixture.SecureDeployIsolationTests()._task_request(None)
        self.op = "close-" + str(uuid.uuid4())
        self.request["operationId"] = self.request["authorization"]["operationId"] = self.op
        (self.workspace / "dist" / "worker.js").write_text(js)
        self.runner = self.root / "runner.py"
        self.runner.write_text("import json,os,sys,time\nfrom pathlib import Path\nassert os.getuid()==10002\njson.load(sys.stdin)\nPath(%r).write_text(str(os.getpid()))\ntime.sleep(90)\n" % str(self.status / "pid"))
        self.runner.chmod(0o644)
        self.thread = None
        self.result = None

    def tearDown(self):
        deploy.close(self.op)
        if self.thread:
            self.thread.join(12)
            self.assertFalse(self.thread.is_alive(), "fixture dispatch must settle")
        self.tmp.cleanup()

    def launch(self):
        def run():
            self.result = deploy.dispatch(self.workspace, self.request, runner_path=str(self.runner))
        self.thread = threading.Thread(target=run)
        self.thread.start()

    def wait_for(self, check):
        deadline = time.monotonic() + 5
        while not check() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(check())

    def test_close_unknown_fences_delayed_dispatch_and_duplicate(self):
        self.assertEqual(deploy.close(self.op), {"operationId": self.op, "quiescent": True})
        with patch.object(deploy.subprocess, "Popen") as spawn:
            result = deploy.dispatch(self.workspace, self.request, runner_path=str(self.runner))
        spawn.assert_not_called()
        self.assertEqual(result, {"operationId": self.op, "status": "interrupted", "code": "dispatch_already_seen", "quiescent": True})
        self.assertEqual(deploy.close(self.op), {"operationId": self.op, "quiescent": True})
        self.assertEqual(deploy.close("bad/id")["quiescent"], False)

    def test_close_waits_active_prelaunch_read_and_never_launches(self):
        entered, release = threading.Event(), threading.Event()
        real_read = deploy._read_pinned_file
        def slow_read(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return real_read(*args)
        with patch.object(deploy, "_read_pinned_file", side_effect=slow_read), patch.object(deploy.subprocess, "Popen") as spawn:
            self.launch()
            self.assertTrue(entered.wait(3))
            self.assertEqual(deploy.close(self.op, seconds=.02)["quiescent"], False)
            release.set()
            self.thread.join(3)
            spawn.assert_not_called()
        self.assertEqual(self.result["status"], "interrupted")
        self.assertTrue(self.result["quiescent"])
        self.assertTrue(deploy.close(self.op)["quiescent"])

    def test_close_running_waits_real_kernel_death_reap_and_fences(self):
        self.runner.write_text("import json,os,subprocess,sys,time\nfrom pathlib import Path\nassert os.getuid()==10002\njson.load(sys.stdin)\nchild=subprocess.Popen(['/usr/bin/python3','-c','import time;time.sleep(90)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nPath(%r).write_text(str(child.pid))\nPath(%r).write_text(str(os.getpid()))\ntime.sleep(90)\n" % (str(self.status / "cli-pid"), str(self.status / "pid")))
        # Production tini/PID1 reaps orphans. Isolate the same behavior in this
        # root fixture; reap ONLY the known CLI PID, never another Popen child.
        libc = ctypes.CDLL(None)
        previous = ctypes.c_int()
        self.assertEqual(libc.prctl(37, ctypes.byref(previous), 0, 0, 0), 0)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        self.launch()
        self.wait_for(lambda: (self.status / "pid").exists())
        pid = int((self.status / "pid").read_text())
        cli_pid = int((self.status / "cli-pid").read_text())
        reaped = threading.Event()
        def init_reaper():
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                try:
                    if os.waitpid(cli_pid, os.WNOHANG)[0]:
                        reaped.set()
                        return
                except ChildProcessError:
                    pass
                time.sleep(.01)
        reaper = threading.Thread(target=init_reaper)
        reaper.start()
        try:
            real_killpg = os.killpg
            def proof_only(pgid, sig):
                self.assertEqual(sig, 0, "numeric group kill forbidden")
                return real_killpg(pgid, sig)
            with patch.object(deploy.os, "killpg", side_effect=proof_only):
                self.assertTrue(deploy.close(self.op)["quiescent"])
            self.assertTrue(reaped.wait(3))
        finally:
            reaper.join(12)
            libc.prctl(36, previous.value, 0, 0, 0)
        self.thread.join(3)
        self.assertFalse(Path(f"/proc/{pid}").exists(), "runner must be dead and reaped before proof")
        cli = Path(f"/proc/{int((self.status / 'cli-pid').read_text())}/stat")
        if cli.exists():
            self.assertEqual(cli.read_text().rsplit(")", 1)[1].split()[0], "Z", "trusted CLI has no live credential memory")
        self.assertEqual(self.result["status"], "interrupted")
        self.assertTrue(self.result["quiescent"])
        self.assertEqual(deploy.dispatch(self.workspace, self.request)["code"], "dispatch_already_seen")

    def test_close_during_real_spawn_publication_race_cannot_certify_early(self):
        created, release = threading.Event(), threading.Event()
        real_popen = subprocess.Popen
        spawned = []
        def delayed_publication(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            spawned.append(process)
            created.set()
            self.assertTrue(release.wait(5))
            return process
        with patch.object(deploy.subprocess, "Popen", side_effect=delayed_publication):
            self.launch()
            self.assertTrue(created.wait(3))
            self.assertIsNone(spawned[0].poll())
            self.assertFalse(deploy.close(self.op, seconds=.02)["quiescent"])
            release.set()
            self.thread.join(5)
        self.assertFalse(self.thread.is_alive())
        self.assertTrue(deploy.close(self.op)["quiescent"])
        self.assertIsNotNone(spawned[0].returncode)
        self.assertFalse(Path(f"/proc/{spawned[0].pid}").exists())
        self.assertTrue(self.result["quiescent"])

    def test_pidfd_signal_fault_returns_false_until_same_dispatch_retry_succeeds(self):
        self.launch()
        self.wait_for(lambda: (self.status / "pid").exists())
        pid = int((self.status / "pid").read_text())
        with patch.object(deploy.signal, "pidfd_send_signal", side_effect=PermissionError("synthetic signal denial")):
            self.assertFalse(deploy.close(self.op, seconds=.02)["quiescent"])
            self.assertTrue(Path(f"/proc/{pid}").exists())
            self.assertTrue(self.thread.is_alive())
        self.assertTrue(deploy.close(self.op)["quiescent"])
        self.thread.join(3)
        self.assertFalse(Path(f"/proc/{pid}").exists())
        self.assertTrue(self.result["quiescent"])

    def test_real_fork_after_proc_snapshot_cannot_certify_quiescence(self):
        libc = ctypes.CDLL(None)
        previous = ctypes.c_int()
        self.assertEqual(libc.prctl(37, ctypes.byref(previous), 0, 0, 0), 0)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        process = subprocess.Popen(["/usr/bin/setpriv", "--reuid=10002", "--regid=10002", "--clear-groups", "--bounding-set=-all", "--inh-caps=-all", "--no-new-privs", "--", "/usr/bin/python3", "-c", "import os,sys,time\nprint('ready',flush=True)\nsys.stdin.readline()\nchild=os.fork()\nif child==0:\n os.close(1);time.sleep(90);os._exit(0)\nprint(child,flush=True)\n"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True, env={"PATH": "/usr/bin:/bin"})
        child_fd = None
        child = None
        try:
            self.assertEqual(process.stdout.readline(), b"ready\n")
            snapshot = list(Path("/proc").iterdir())
            out, _ = process.communicate(b"fork-after-snapshot\n", timeout=5)
            child = int(out.strip())
            child_fd = os.pidfd_open(child)
            self.assertNotIn(str(child), {path.name for path in snapshot})
            self.assertFalse(Path(f"/proc/{process.pid}").exists(), "direct leader already reaped")
            # Any snapshot-only completion code could miss this late child.
            with patch.object(deploy.Path, "iterdir", return_value=iter(snapshot)) as scan:
                self.assertFalse(deploy._group_quiescent(process.pid))
                scan.assert_not_called()
            signal.pidfd_send_signal(child_fd, signal.SIGKILL)
            self.assertEqual(os.waitpid(child, 0)[0], child)
            child = None
            self.assertTrue(deploy._group_quiescent(process.pid))
        finally:
            if child is not None:
                if child_fd is not None:
                    signal.pidfd_send_signal(child_fd, signal.SIGKILL)
                os.waitpid(child, 0)
            if child_fd is not None:
                os.close(child_fd)
            if process.poll() is None:
                process.kill()
            process.communicate()
            libc.prctl(36, previous.value, 0, 0, 0)

    def test_kernel_empty_group_proof_does_not_use_racy_proc_snapshot(self):
        # Deterministically model a child born after /proc enumeration: the
        # snapshot appears empty, but the kernel group still exists. Neither
        # scanning twice nor ignoring zombies would be sufficient evidence.
        with patch.object(deploy.Path, "iterdir", return_value=iter(())) as scan, patch.object(deploy.os, "killpg", return_value=None) as probe:
            self.assertFalse(deploy._group_quiescent(424242))
            scan.assert_not_called()
            probe.assert_called_once_with(424242, 0)
        with patch.object(deploy.os, "killpg", side_effect=ProcessLookupError):
            self.assertTrue(deploy._group_quiescent(424242))
        with patch.object(deploy.os, "killpg", side_effect=PermissionError):
            self.assertFalse(deploy._group_quiescent(424242))

    def test_normal_outcome_without_cleanup_proof_retains_guard_for_close_retry(self):
        self.runner.write_text("import json,sys\njson.load(sys.stdin)\nprint('{\"status\":\"completed\",\"code\":\"deploy_accepted\"}')\n")
        with patch.object(deploy, "_group_quiescent", return_value=False):
            self.launch()
            self.thread.join(12)
            self.assertFalse(self.thread.is_alive())
            self.assertEqual(self.result, {"operationId": self.op, "status": "completed", "code": "deploy_accepted", "quiescent": False})
            self.assertFalse(deploy.close(self.op, seconds=.02)["quiescent"])
        self.assertTrue(deploy.close(self.op)["quiescent"])
        self.assertEqual(deploy.dispatch(self.workspace, self.request)["code"], "dispatch_already_seen")


if __name__ == "__main__":
    unittest.main()
