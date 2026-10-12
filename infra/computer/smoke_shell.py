"""Built-image Linux PTY smoke; run with docker exec -i ... python3 - < this file.

Uses shipped modules only, real native forkpty/root supervisor/UID10001 bash.
No production token is read or printed; localhost probes are unauthenticated.
"""
import http.client
import os
from pathlib import Path
import select
import shutil
import sys
import tempfile
import time
import uuid

sys.path.insert(0, "/opt/botspace")
import shell_bridge as shell

assert os.geteuid() == 0, "trusted image supervisor required"
with tempfile.TemporaryDirectory(prefix="timber-image-pty-") as temporary:
    root = Path(temporary)
    root.chmod(0o755)
    workspace = root / "workspace"
    workspace.mkdir()
    os.chown(workspace, 0, 10001)
    workspace.chmod(0o2770)
    private = root / "private"
    private.mkdir(mode=0o700)
    (private / "canary").write_text("synthetic-smoke-private-path-only")
    setuid_id = root / "setuid-id"
    shutil.copyfile("/usr/bin/id", setuid_id)
    setuid_id.chmod(0o4755)
    manager = shell.ShellManager(workspace)
    session = manager.open(str(uuid.uuid4()), int(time.time() * 1000) + 59000)
    output = bytearray()

    def until(marker, start=0):
        marker = marker.encode()
        deadline = time.monotonic() + 5
        while marker not in output[start:] and time.monotonic() < deadline:
            if select.select([session.fd], [], [], .1)[0]:
                output.extend(os.read(session.fd, 4096))
        assert marker in output[start:], "real PTY output proof missing"

    try:
        session.resize(113, 37)
        probe = workspace / "identity.py"
        probe.write_text('''import ctypes,errno,os,subprocess
from pathlib import Path
assert os.getuid()==os.geteuid()==10001
assert os.getgid()==os.getegid()==10001 and os.getgroups()==[]
assert all(os.isatty(fd) for fd in (0,1,2))
status=dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
assert status['NoNewPrivs'].strip()=='1'
assert all(int(status[name].strip(),16)==0 for name in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb'))
for path in %r:
 try: os.open(path,os.O_RDONLY)
 except PermissionError: pass
 else: raise AssertionError('private path readable')
try: os.kill(%d,0)
except PermissionError: pass
else: raise AssertionError('trusted supervisor signalable')
assert subprocess.check_output([%r,'-u']).strip()==b'10001'
assert not any(name in os.environ for name in ('BOTSPACE_COMPUTER_TOKEN','CLOUDFLARE_API_TOKEN','NODE_OPTIONS'))
print('SMOKE_IDENTITY_OK',flush=True)
''' % ([str(private / "canary"), f"/proc/{session.helper.pid}/environ"], session.helper.pid, str(setuid_id)))
        probe.chmod(0o644)
        os.write(session.fd, b"/usr/bin/python3 identity.py; stty size; printf '\\nUNICODE:'; cat > unicode-input\n")
        until("SMOKE_IDENTITY_OK\r\n")
        until("37 113")
        until("\r\nUNICODE:")
        os.write(session.fd, "árbol 🌲\n".encode())
        time.sleep(.1)
        cursor = len(output)
        os.write(session.fd, b"\x03")
        until("$ ", cursor)  # shell regained foreground; don't race input flush
        os.write(session.fd, b"printf '\\nINTERRUPTED:%s\\n' \"$?\"\n")
        until("INTERRUPTED:130\r\n")
        assert (workspace / "unicode-input").read_text() == "árbol 🌲\n"
        writer = workspace / "escape.py"
        writer.write_text("import os,time\nif os.fork(): os._exit(0)\nos.setsid()\nif os.fork(): os._exit(0)\nopen('writer.pid','w').write(str(os.getpid()))\nf=open('writer-output','ab',buffering=0)\nwhile True: f.write(b'x');time.sleep(.01)\n")
        writer.chmod(0o644)
        os.write(session.fd, b"env -i /usr/bin/python3 escape.py >/dev/null 2>&1 &\n")
        deadline = time.monotonic() + 5
        while not (workspace / "writer.pid").exists() and time.monotonic() < deadline:
            time.sleep(.01)
        pid = int((workspace / "writer.pid").read_text())
        while shell.process_table()[pid][0] != session.helper.pid and time.monotonic() < deadline:
            time.sleep(.01)
        assert shell.process_table()[pid][0] == session.helper.pid
        try:
            with manager.checkpoint_guard():
                raise AssertionError("active PTY allowed checkpoint")
        except ValueError:
            pass
        try:
            manager.open(str(uuid.uuid4()), int(time.time() * 1000) + 59000)
            raise AssertionError("second shell allowed")
        except shell.ShellError as error:
            assert error.code == "shell_busy"
    finally:
        # This smoke owns the terminal synchronously, not a WebSocket handler.
        session.run_done.set()
        manager.close(session.id)
    assert session.cleanup_confirmed and session.helper.poll() == 0
    assert not Path(f"/proc/{session.pid}").exists()
    assert not Path(f"/proc/{pid}").exists(), "detached writer not reaped"
    size = (workspace / "writer-output").stat().st_size
    time.sleep(.05)
    assert (workspace / "writer-output").stat().st_size == size
    with manager.checkpoint_guard():
        pass

# Actual start.sh controller: neither localhost nor direct PTY bypasses auth.
for method, path, body in (("GET", "/health", None), ("POST", "/secure-deploy/close", "{}")):
    connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=3)
    connection.request(method, path, body)
    response = connection.getresponse()
    assert response.status == 401, "management localhost auth bypass"
    response.read()
    connection.close()
print("Built-image PTY identity, Unicode, resize, Ctrl-C, detached cleanup and auth smoke passed")
