"""Genuine PTY UID/private-service boundary probes; synthetic canaries only."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import server
import shell_bridge as shell
from test_shell_bridge import Client, TOKEN


@unittest.skipUnless(os.geteuid() == 0 and shutil.which("setpriv"), "requires trusted Linux root supervisor/setpriv")
class ShellIsolationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="timber-pty-boundary-")
        self.root = Path(self.tmp.name)
        self.root.chmod(0o755)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        os.chown(self.workspace, 0, 10001)
        self.workspace.chmod(0o2770)
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        (self.state / "private-canary").write_text("synthetic-private-path-only")
        self.code = self.root / "trusted-code"
        self.code.mkdir(mode=0o755)
        for name in ("server.py", "shell_bridge.py"):
            shutil.copyfile(Path(shell.__file__).parent / name, self.code / name)
            (self.code / name).chmod(0o644)
        self.manager = shell.ShellManager(self.workspace)
        self.bridge = shell.start_bridge(self.manager, TOKEN, "127.0.0.1", 0)
        self.clients = []
        self.private = None

    def tearDown(self):
        for client in self.clients:
            client.close()
        self.manager.close()
        self.bridge.shutdown()
        self.bridge.server_close()
        if self.private:
            self.private.kill()
            self.private.wait()
            self.private.stdout.close()
        self.tmp.cleanup()

    def client(self):
        client = Client(self.bridge.server_address[1])
        self.clients.append(client)
        self.assertEqual(client.status, 101)
        return client

    def run_probe(self, client, source):
        probe = self.workspace / "probe.py"
        probe.write_text(source)
        probe.chmod(0o644)
        client.send({"type": "input", "data": "/usr/bin/python3 probe.py && printf '\\nPROBE_PASSED\\n'\n"})
        client.until("\r\nPROBE_PASSED\r\n")
        self.assertNotIn("Traceback", client.output)

    def test_actual_pty_uid_groups_caps_nnp_private_proc_signal_ptrace_and_setuid(self):
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b"synthetic-private-pipe-only")
        os.close(write_fd)
        args = ["/usr/bin/setpriv", "--reuid=10002", "--regid=10002", "--clear-groups",
                "--bounding-set=-all", "--inh-caps=-all", "--no-new-privs", "--",
                "/usr/bin/python3", "-c",
                "import ctypes,time; assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0; print('ready',flush=True); time.sleep(90)"]
        try:
            self.private = subprocess.Popen(args, pass_fds=(read_fd,), stdout=subprocess.PIPE,
                                            stderr=subprocess.DEVNULL,
                                            env={"PATH": "/usr/bin:/bin", "TIMBER_SYNTHETIC_CANARY": "synthetic-private-env-only"})
        finally:
            os.close(read_fd)
        self.assertEqual(self.private.stdout.readline(), b"ready\n")
        setuid_id = self.code / "setuid-id"
        shutil.copyfile("/usr/bin/id", setuid_id)
        setuid_id.chmod(0o4755)
        self.assertEqual(setuid_id.stat().st_uid, 0)
        self.assertTrue(setuid_id.stat().st_mode & 0o4000)
        client = self.client()
        session = self.manager.session
        source = '''import ctypes,errno,json,os,signal,subprocess
from pathlib import Path
assert os.getuid()==os.geteuid()==10001
assert os.getgid()==os.getegid()==10001
assert os.getgroups()==[]
status=dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
for name in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb'):
 assert int(status[name].strip(),16)==0,(name,status[name])
assert status['NoNewPrivs'].strip()=='1'
assert all(os.isatty(fd) for fd in (0,1,2))
assert not any('synthetic-private' in v or 'test-only-shell-token' in v for v in os.environ.values())
for path in PATHS:
 try: os.open(path,os.O_RDONLY)
 except PermissionError: pass
 else: raise AssertionError('private path readable: '+path)
for pid in PIDS:
 for item in ('environ','mem','fd/0'):
  try: os.open('/proc/'+str(pid)+'/'+item,os.O_RDONLY)
  except PermissionError: pass
  else: raise AssertionError('private proc readable')
 for sig in (0,signal.SIGTERM):
  try: os.kill(pid,sig)
  except PermissionError: pass
  else: raise AssertionError('private process signalable')
 libc=ctypes.CDLL(None,use_errno=True)
 assert libc.ptrace(16,pid,0,0)==-1 and ctypes.get_errno()==errno.EPERM
for path in CODE:
 try: os.open(path,os.O_WRONLY|os.O_APPEND)
 except PermissionError: pass
 else: raise AssertionError('trusted code writable')
try: os.setuid(0)
except PermissionError: pass
else: raise AssertionError('root escalation')
assert subprocess.run(['/usr/bin/setpriv','--reuid=0','--','/usr/bin/id','-u'],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode!=0
assert subprocess.check_output([SETUID,'-u']).strip()==b'10001'
Path('identity-proof.json').write_text(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'groups':os.getgroups(),'NoNewPrivs':status['NoNewPrivs'].strip(),'caps':{n:status[n].strip() for n in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb')}}))
'''
        source = source.replace("PATHS", repr([str(self.state / "private-canary"), f"/proc/{self.private.pid}/fd/{read_fd}"]))
        source = source.replace("PIDS", repr([session.helper.pid, self.private.pid, os.getpid()]))
        source = source.replace("CODE", repr([str(self.code / n) for n in ("server.py", "shell_bridge.py")]))
        source = source.replace("SETUID", repr(str(setuid_id)))
        self.run_probe(client, source)
        proof = self.workspace / "identity-proof.json"
        self.assertEqual(proof.stat().st_uid, 10001)
        self.assertEqual(json.loads(proof.read_text())["groups"], [])
        self.assertIsNone(self.private.poll())
        self.assertIsNone(session.helper.poll())
        self.manager.close(client.ident)
        self.assertTrue(session.cleanup_confirmed)
        self.assertEqual(session.helper.poll(), 0)
        self.assertIsNone(self.private.poll(), "cleanup excludes credential helper")

    def test_private_management_http_and_shell_upgrade_require_auth_from_real_pty(self):
        computer = server.Computer(self.workspace, self.state)
        control = server.ComputerHTTPServer(("127.0.0.1", 0), server.create_handler(computer, TOKEN))
        threading.Thread(target=control.serve_forever, daemon=True).start()
        try:
            client = self.client()
            self.run_probe(client, '''import http.client,socket
for port in (CONTROL,BRIDGE):
 for auth in (None,'Bearer invalid-local-shell-token'):
  headers={} if auth is None else {'Authorization':auth}
  for method,path,body in [('GET','/health',None),('POST','/shell/close-all','{}'),('POST','/secure-deploy','{}'),('POST','/secure-deploy/close','{}'),('POST','/actions','{}')]:
   conn=http.client.HTTPConnection('127.0.0.1',port,timeout=2)
   conn.request(method,path,body,headers)
   response=conn.getresponse()
   assert response.status==401,(port,path,response.status)
   response.read();conn.close()
sock=socket.create_connection(('127.0.0.1',BRIDGE),2)
sock.sendall(b'GET /shell HTTP/1.1\\r\\nHost: localhost\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Protocol: timber-shell.v1\\r\\n\\r\\n')
assert sock.recv(1024).split(b' ')[1]==b'401'
sock.close()
'''.replace("CONTROL", str(control.server_address[1])).replace("BRIDGE", str(self.bridge.server_address[1])))
            self.assertIsNotNone(self.manager.session)
            self.manager.close(client.ident)
        finally:
            computer.close()
            control.shutdown()
            control.server_close()

    def test_nonroot_supervisor_is_acknowledged_without_pty_effect(self):
        real_popen = subprocess.Popen
        processes = []
        def untrusted_supervisor(arguments, **kwargs):
            prefix = ["/usr/bin/setpriv", "--reuid=10001", "--regid=10001", "--clear-groups",
                      "--bounding-set=-all", "--inh-caps=-all", "--no-new-privs", "--"]
            arguments = ["/usr/bin/python3", "-I", str(self.code / "shell_bridge.py"), *arguments[3:]]
            process = real_popen(prefix + arguments, **kwargs)
            processes.append(process)
            return process
        with patch.object(shell.subprocess, "Popen", side_effect=untrusted_supervisor):
            client = Client(self.bridge.server_address[1])
            self.clients.append(client)
        self.assertEqual(client.status, 503)
        self.assertEqual(processes[0].poll(), 1)
        self.assertIsNone(self.manager.session)
        with self.manager.checkpoint_guard():
            pass
        replacement = self.client()
        self.manager.close(replacement.ident)


if __name__ == "__main__":
    unittest.main()
