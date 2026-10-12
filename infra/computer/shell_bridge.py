"""Private, authenticated real PTY transport. Never expose port 6082 directly.

The DO supplies a UUID and renewable 60-second lease in the upgrade headers.
One shared manager is embedded in server.py so checkpoint admission is atomic.
Only text JSON timber-shell.v1 messages are accepted; no exec/poll emulation.
"""
from __future__ import annotations

import array
import base64
import ctypes
import errno
import codecs
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import select
import signal
import socket
import struct
import subprocess
import sys
import termios
import threading
import time
import uuid
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer

PROTOCOL = "timber-shell.v1"
MAX_FRAME = 16 * 1024
MAX_PENDING_INPUT = 64 * 1024
MAX_INPUT = 16 * 1024 * 1024
MAX_OUTPUT = 16 * 1024 * 1024
SEND_TIMEOUT = 2
CONTROL_TIMEOUT = 3
LEASE_SECONDS = 60
HARD_SECONDS = 3600
MAX_SESSION_FENCES = 1024
ERROR_CODES = frozenset({"shell_invalid_message", "shell_frame_limit", "shell_input_limit", "shell_output_limit", "shell_lease_expired", "shell_closed", "shell_failed"})


class ShellError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)


def session_id(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError()
        return value
    except (ValueError, AttributeError):
        raise ShellError("shell_invalid_session") from None


def lease(value):
    now = time.time()
    if type(value) is not int or not now * 1000 < value <= (now + LEASE_SECONDS) * 1000:
        raise ShellError("shell_invalid_lease")
    return time.monotonic() + (value / 1000 - now)


def frame(opcode, payload):
    size = len(payload)
    if size > MAX_FRAME:
        raise ShellError("shell_frame_limit")
    return bytes([0x80 | opcode, size]) + payload if size < 126 else bytes([0x80 | opcode, 126]) + struct.pack("!H", size) + payload


def parse_frame(buffer):
    """Bound length before allocating/reading payload; require masked RFC6455 frames."""
    if len(buffer) < 2:
        return None
    first, second = buffer[0], buffer[1]
    opcode = first & 15
    if first & 0x70 or not first & 0x80 or not second & 0x80 or opcode not in (1, 8, 9, 10):
        raise ShellError("shell_invalid_message")
    size, offset = second & 127, 2
    if size == 127:
        raise ShellError("shell_frame_limit")
    if size == 126:
        if len(buffer) < 4:
            return None
        size, offset = struct.unpack("!H", buffer[2:4])[0], 4
        if size < 126:
            raise ShellError("shell_invalid_message")
    if size > MAX_FRAME or (opcode >= 8 and size > 125):
        raise ShellError("shell_frame_limit")
    if opcode == 8 and size == 1:
        raise ShellError("shell_invalid_message")
    if len(buffer) < offset + 4 + size:
        return None
    mask = buffer[offset:offset + 4]
    payload = bytes(value ^ mask[i % 4] for i, value in enumerate(buffer[offset + 4:offset + 4 + size]))
    del buffer[:offset + 4 + size]
    return opcode, payload


def process_table(strict=False):
    result = {}
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            # comm can contain spaces and parentheses; split only after final ')'.
            fields = (path / "stat").read_text().rsplit(")", 1)[1].split()
            result[int(path.name)] = (int(fields[1]), int(fields[2]), int(fields[3]), fields[19], fields[0])
        except OSError as exc:
            # A vanished process is normal; inability to observe a live process
            # is not evidence of successful containment cleanup.
            if strict and exc.errno not in (errno.ENOENT, errno.ESRCH):
                raise
        except (ValueError, IndexError):
            if strict:
                raise
    return result


def shell_environment(workspace):
    # Used for BOTH the fresh interpreter and bash. No inherited private token,
    # Python startup hooks, LD_PRELOAD, shell hooks or history persistence.
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(workspace),
            "TERM": "xterm-256color", "LANG": "C.UTF-8", "SHELL": "/bin/bash",
            "HISTFILE": "/dev/null", "HISTSIZE": "0", "HISTFILESIZE": "0"}


def supervisor_cleanup(bash_pid, on_exit, seconds=2):
    """Only this fresh single-threaded subreaper's descendants are eligible.

    Reparenting (including env -i, setsid and double-fork) stays beneath this
    dedicated subreaper. ECHILD after reap is the kernel's authoritative proof
    that no descendants remain, not a marker or a sampled historical PID list.
    A failed/uncertain scan or signal leaves the helper alive for another retry.
    """
    deadline = time.monotonic() + seconds
    root = os.getpid()
    while True:
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return True
            if not pid:
                break
            if pid == bash_pid:
                on_exit(status)
        try:
            table = process_table(strict=True)
            # Kill only our CURRENT direct children. As each ancestor dies,
            # all remaining descendant subtree roots are adopted by this
            # subreaper and become eligible on the next iteration. This avoids
            # stale multi-generation /proc ancestry snapshots entirely. Because
            # only this single thread reaps, a direct child cannot be PID-reused
            # during the signal pass. pidfds provide a second identity fence.
            selected = {pid for pid, item in table.items() if item[0] == root}
            for sig in (signal.SIGSTOP, signal.SIGKILL):
                for pid in selected:
                    identity = table[pid][3]
                    try:
                        fd = os.pidfd_open(pid)
                        try:
                            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
                            if fields[19] == identity:
                                signal.pidfd_send_signal(fd, sig)
                        finally:
                            os.close(fd)
                    except (ProcessLookupError, FileNotFoundError):
                        pass
        except (OSError, ValueError, IndexError):
            return False
        if time.monotonic() >= deadline:
            return False
        time.sleep(.01)


def supervisor_startup_failed(control, subreaper_ready):
    """Acknowledge known pre-launch rejection without guessing from helper exit.

    ECHILD is checked before claiming no launch. If any child is observed, only
    a normal, fully confirmed cleanup receipt is allowed, never a no-effects one.
    """
    try:
        try:
            os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            kind = "not_started"
        else:
            while not supervisor_cleanup(None, lambda _status: None):
                time.sleep(1)
            if not subreaper_ready:
                # Unexpected pre-existing children without established
                # subreaping could have escaped. Never certify their shutdown.
                control.send(b'{"type":"pending"}')
                return 1
            kind = "cleaned"
        receipt = json.dumps({"type": kind}, separators=(",", ":")).encode()
        control.send(receipt)
        # Retain the receipt until acknowledged, just like post-launch cleanup.
        # An EOF without a receipt must remain ambiguous to the controller.
        while True:
            ready, _, _ = select.select([control], [], [], 1)
            if ready:
                message = control.recv(1024)
                if not message or message == b"ack":
                    break
                if message == b"close":
                    control.send(receipt)
    except OSError:
        pass  # No positive receipt reached the controller: it remains guarded.
    finally:
        control.close()
    return 1


def supervisor_main(control_fd, workspace):
    """Entered by exec, never by Python fork from the threaded HTTP server."""
    control = socket.socket(fileno=control_fd)
    control.settimeout(CONTROL_TIMEOUT)
    subreaper_ready = False
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
            raise OSError(ctypes.get_errno(), "subreaper unavailable")
        subreaper_ready = True
        # Native Linux forkpty and pidfds are mandatory. No Python fallback that
        # could throw during child terminal setup and misreport a launch failure.
        if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal") or not hasattr(os, "forkpty"):
            raise OSError(errno.ENOSYS, "supervision unavailable")
        fd = os.pidfd_open(os.getpid())
        os.close(fd)
        pid, terminal = os.forkpty()  # Safe: fresh exec helper has only one thread.
    except (OSError, AttributeError):
        return supervisor_startup_failed(control, subreaper_ready)
    if pid == 0:
        try:
            control.close()
            os.chdir(workspace)
            os.execve("/bin/bash", ["bash", "--noprofile", "--norc", "-i"], shell_environment(workspace))
        finally:
            os._exit(127)
    closing = False
    exited = False
    connected = True

    def send(value):
        nonlocal connected
        if connected:
            try:
                control.send(json.dumps(value, separators=(",", ":")).encode())
            except OSError:
                connected = False

    def on_exit(status):
        nonlocal exited
        if not exited:
            exited = True
            send({"type": "exit", "status": status})

    try:
        control.sendmsg([json.dumps({"type": "started", "pid": pid}).encode()],
                        [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [terminal]))])
        os.close(terminal)
        terminal = None
        while True:
            if not closing:
                # Orphaned detached jobs can finish while bash remains live.
                # Reap ALL adopted children, not only bash, to avoid accumulating
                # zombie descendants over the session's one-hour lifetime.
                while True:
                    try:
                        reaped, status = os.waitpid(-1, os.WNOHANG)
                    except ChildProcessError:
                        closing = True
                        break
                    if not reaped:
                        break
                    if reaped == pid:
                        on_exit(status)
                        closing = True
                        break
            if closing:
                if supervisor_cleanup(pid, on_exit):
                    send({"type": "cleaned"})
                    # Keep the confirmation transport alive until acknowledged.
                    # Exiting with an unread simultaneous close packet can reset
                    # a Unix socket and discard the cleanup confirmation.
                    while connected:
                        ready, _, _ = select.select([control], [], [], 1)
                        if ready:
                            message = control.recv(1024)
                            if not message or message == b"ack":
                                break
                            if message == b"close":
                                send({"type": "cleaned"})
                    return 0
                send({"type": "pending"})
                # Retain subreaping ownership after a failed attempt. A close
                # request or disconnected controller retries shutdown only.
            ready, _, _ = select.select([control] if connected else [], [], [], .1 if not closing else 1)
            if ready:
                message = control.recv(1024)
                if not message:
                    connected = False
                    closing = True
                elif message == b"close":
                    closing = True
            elif not connected:
                closing = True
    finally:
        if terminal is not None:
            # A descriptor-close error must never bypass descendant shutdown.
            try:
                os.close(terminal)
            except OSError:
                pass
        # Do not exit and orphan uncertain descendants on transport exceptions.
        while not supervisor_cleanup(pid, on_exit):
            time.sleep(1)
        control.close()


class ShellSession:
    def __init__(self, manager, ident, expires):
        self.manager, self.id = manager, ident
        self.expires, self.hard = expires, time.monotonic() + HARD_SECONDS
        self.stop = threading.Event()
        self.done = threading.Event()
        self.socket = None
        self.pid = self.fd = None
        self.helper = None
        self.control = None
        self.exit_status = None
        self.cleanup_confirmed = False
        self.run_done = threading.Event()
        self.kill_lock = threading.Lock()
        self.reason = "shell_closed"

    def start(self):
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.control = parent
        parent.settimeout(CONTROL_TIMEOUT)
        try:
            self.helper = subprocess.Popen(
                [sys.executable, "-I", str(Path(__file__).resolve()), "--supervisor", str(child.fileno()), str(self.manager.workspace)],
                pass_fds=(child.fileno(),), close_fds=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env=shell_environment(self.manager.workspace))
        finally:
            child.close()
        data, ancillary, flags, _ = parent.recvmsg(1024, socket.CMSG_SPACE(array.array("i").itemsize))
        fds = array.array("i")
        for level, kind, payload in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                fds.frombytes(payload[:len(payload) - len(payload) % fds.itemsize])
        try:
            message = json.loads(data)
            if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
                raise ShellError("shell_failed", 503)
            if not fds and message in ({"type": "not_started"}, {"type": "cleaned"}):
                # Explicit no-effects (or completed shutdown) receipt, not an
                # inference from EOF/returncode. Cleanup still acknowledges and
                # reaps this helper before releasing the admission guard.
                self.cleanup_confirmed = True
                raise ShellError("shell_failed", 503)
            if not isinstance(message, dict) or message.get("type") != "started" or len(fds) != 1:
                raise ShellError("shell_failed", 503)
            self.pid, self.fd = message["pid"], fds.pop()
        finally:
            for fd in fds:
                os.close(fd)
        os.set_blocking(self.fd, False)
        self.resize(80, 24)

    def resize(self, cols, rows):
        if type(cols) is not int or type(rows) is not int or not 1 <= cols <= 500 or not 1 <= rows <= 200:
            raise ShellError("shell_invalid_message")
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def receive_control(self, wait=0):
        if not self.control:
            return
        ready, _, _ = select.select([self.control], [], [], wait)
        if not ready:
            return False
        data = self.control.recv(1024)
        if not data:
            if not self.cleanup_confirmed:
                raise ShellError("shell_cleanup_pending", 503)
            return False
        message = json.loads(data)
        if message.get("type") == "exit":
            self.exit_status = message["status"]
        elif message == {"type": "cleaned"} or (self.pid is None and message == {"type": "not_started"}):
            self.cleanup_confirmed = True
        elif message.get("type") != "pending":
            raise ShellError("shell_cleanup_pending", 503)
        return True

    def poll_exit(self):
        with self.kill_lock:
            self.receive_control()
            return self.exit_status

    def cleanup(self):
        with self.kill_lock:
            if self.helper is None:
                # No process was launched; any pre-spawn socket is inert.
                self.cleanup_confirmed = True
            elif not self.cleanup_confirmed:
                try:
                    # A helper may already have completed after bash exit.
                    # Consume its queued confirmation before writing to a socket
                    # whose peer has exited; a broken send is NOT lost cleanup.
                    while not self.cleanup_confirmed and self.receive_control():
                        pass
                    if not self.cleanup_confirmed:
                        try:
                            self.control.send(b"close")
                        except OSError:
                            pass
                    deadline = time.monotonic() + CONTROL_TIMEOUT + 1
                    while not self.cleanup_confirmed and time.monotonic() < deadline:
                        self.receive_control(min(.1, max(0, deadline - time.monotonic())))
                except (OSError, ValueError):
                    raise ShellError("shell_cleanup_pending", 503) from None
                if not self.cleanup_confirmed:
                    raise ShellError("shell_cleanup_pending", 503)
            if self.helper is not None:
                try:
                    if self.helper.poll() is None:
                        try:
                            self.control.send(b"ack")
                        except OSError:
                            # The cleanup receipt is already authoritative. A
                            # peer exiting between poll and ack must still be
                            # reaped; don't mistake a broken ack for lost proof.
                            pass
                    self.helper.wait(timeout=CONTROL_TIMEOUT)
                except subprocess.TimeoutExpired:
                    raise ShellError("shell_cleanup_pending", 503) from None
            if self.fd is not None:
                fd, self.fd = self.fd, None
                # Consume the owned handle before close: EINTR/EBADF must not
                # make a retry close a recycled, unrelated descriptor number.
                os.close(fd)
            if self.control is not None:
                self.control.close()
                self.control = None

    def settle_cleanup(self):
        try:
            self.cleanup()
        except Exception:
            # Any cleanup exception is uncertainty, not permission to release.
            # Keep the manager guard and the helper for explicit close/maintenance
            # retries. Handler completion is separate from cleanup confirmation.
            return False
        self.manager.finished(self)
        self.done.set()
        return True

    def request_close(self, reason="shell_closed"):
        self.reason = reason
        self.stop.set()
        if self.socket:
            try:
                self.socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def send(self, value):
        self.socket.sendall(frame(1, json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode()))

    def run(self, sock):
        self.socket = sock
        sock.settimeout(SEND_TIMEOUT)
        # Bound kernel buffering as part of transport backpressure. The DO also
        # maintains an application-level acknowledged output window.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 16 * 1024)
        received, pending = bytearray(), bytearray()
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        output_count = input_count = 0
        terminal_eof = False
        try:
            while not self.stop.is_set():
                now = time.monotonic()
                if now >= min(self.expires, self.hard):
                    raise ShellError("shell_lease_expired")
                ready, writable, _ = select.select([sock] + ([] if terminal_eof else [self.fd]), [self.fd] if pending else [], [], min(.1, max(0, self.expires - now)))
                if sock in ready:
                    chunk = sock.recv(MAX_FRAME + 8 - len(received))
                    if not chunk:
                        break
                    received.extend(chunk)
                while received:
                    parsed = parse_frame(received)
                    if parsed is None:
                        break
                    opcode, payload = parsed
                    if opcode == 8:
                        # Validate close payload UTF-8/code, then acknowledge.
                        if len(payload) >= 2:
                            code = struct.unpack("!H", payload[:2])[0]
                            if code < 1000 or code in (1004, 1005, 1006, 1015) or 1016 <= code < 3000 or code >= 5000:
                                raise ShellError("shell_invalid_message")
                            payload[2:].decode("utf-8")
                        sock.sendall(frame(8, payload))
                        return
                    if opcode == 9:
                        sock.sendall(frame(10, payload))
                        continue
                    if opcode == 10:
                        continue
                    try:
                        message = json.loads(payload.decode("utf-8"))
                    except (ValueError, UnicodeError, RecursionError):
                        raise ShellError("shell_invalid_message") from None
                    if not isinstance(message, dict):
                        raise ShellError("shell_invalid_message")
                    if message.get("type") == "input" and set(message) == {"type", "data"} and isinstance(message["data"], str):
                        try:
                            data = message["data"].encode("utf-8")
                        except UnicodeError:
                            raise ShellError("shell_invalid_message") from None
                        input_count += len(data)
                        if input_count > MAX_INPUT or len(pending) + len(data) > MAX_PENDING_INPUT:
                            raise ShellError("shell_input_limit")
                        pending.extend(data)
                    elif message.get("type") == "resize" and set(message) == {"type", "cols", "rows"}:
                        self.resize(message["cols"], message["rows"])
                    else:
                        raise ShellError("shell_invalid_message")
                if writable:
                    try:
                        written = os.write(self.fd, pending)
                        del pending[:written]
                    except BlockingIOError:
                        pass
                if self.fd in ready:
                    try:
                        chunk = os.read(self.fd, 2048)
                    except OSError as exc:
                        if exc.errno != 5:  # Linux PTY EOF is EIO.
                            raise
                        chunk = b""
                    if not chunk:
                        terminal_eof = True
                    else:
                        data = decoder.decode(chunk)
                        output_count += len(data.encode("utf-8"))
                        if output_count > MAX_OUTPUT:
                            raise ShellError("shell_output_limit")
                        if data:
                            self.send({"type": "output", "data": data})
                # Background jobs can retain the PTY after bash exits. They must
                # not keep the session alive; cleanup owns their termination.
                status = self.poll_exit()
                if status is not None:
                    # Bash can exit with more than one chunk still buffered in
                    # the PTY. Drain it before emitting exit; never wait for a
                    # background job that inherited this terminal to close it.
                    drain_deadline = min(time.monotonic() + 1, self.expires, self.hard)
                    while not terminal_eof and time.monotonic() < drain_deadline:
                        try:
                            chunk = os.read(self.fd, 2048)
                        except BlockingIOError:
                            break
                        except OSError as exc:
                            if exc.errno != 5:
                                raise
                            break
                        if not chunk:
                            break
                        data = decoder.decode(chunk)
                        output_count += len(data.encode("utf-8"))
                        if output_count > MAX_OUTPUT:
                            raise ShellError("shell_output_limit")
                        if data:
                            self.send({"type": "output", "data": data})
                    tail = decoder.decode(b"", final=True)
                    output_count += len(tail.encode("utf-8"))
                    if output_count > MAX_OUTPUT:
                        raise ShellError("shell_output_limit")
                    if tail:
                        self.send({"type": "output", "data": tail})
                    code = os.waitstatus_to_exitcode(status)
                    self.send({"type": "exit", "exitCode": code if code >= 0 else None})
                    sock.sendall(frame(8, struct.pack("!H", 1000)))
                    return
        except ShellError as exc:
            try:
                self.send({"type": "error", "code": exc.code})
                sock.sendall(frame(8, struct.pack("!H", 1008)))
            except OSError:
                pass
        except (OSError, ValueError, UnicodeError):
            # Fixed diagnostics only: never expose process/socket exception text.
            try:
                self.send({"type": "error", "code": "shell_failed"})
            except OSError:
                pass
        finally:
            # A failed cleanup still represents a closing session, not a live
            # renewable grant. Keep the execution guard until confirmed cleanup.
            self.stop.set()
            self.settle_cleanup()
            self.run_done.set()


class ShellManager:
    def __init__(self, workspace, admission_lock=None, snapshot_busy=lambda: False):
        self.workspace = Path(workspace)
        self.lock = admission_lock or threading.RLock()
        self.snapshot_busy = snapshot_busy
        self.session = None
        self.snapshot = False
        self.closed_all = False
        self.fences = {}

    def fence(self, ident, reject_existing=False):
        # Caller holds admission lock. Never evict an unexpired fence to admit
        # more work: doing so could revive an in-flight delayed handshake.
        now = time.monotonic()
        self.fences = {key: expiry for key, expiry in self.fences.items() if expiry > now}
        if reject_existing and ident in self.fences:
            raise ShellError("shell_session_closed", 409)
        if ident not in self.fences and len(self.fences) >= MAX_SESSION_FENCES:
            raise ShellError("shell_fence_limit", 503)
        self.fences[ident] = now + HARD_SECONDS

    def open(self, ident, expires):
        ident, expires = session_id(ident), lease(expires)
        with self.lock:
            if self.closed_all:
                raise ShellError("shell_session_closed", 409)
            # Check a close-before-open fence before any fork or PTY effect.
            self.fences = {key: expiry for key, expiry in self.fences.items() if expiry > time.monotonic()}
            if ident in self.fences:
                raise ShellError("shell_session_closed", 409)
            if self.snapshot or self.snapshot_busy():
                raise ShellError("shell_snapshot_busy", 409)
            if self.session:
                raise ShellError("shell_busy", 409)
            self.fence(ident, reject_existing=True)
            session = ShellSession(self, ident, expires)
            self.session = session
            try:
                session.start()
            except BaseException:
                session.request_close()
                session.settle_cleanup()
                session.run_done.set()
                raise
            return session

    def finished(self, session):
        with self.lock:
            if self.session is session:
                self.session = None

    def renew(self, ident, expires):
        ident, expires = session_id(ident), lease(expires)
        with self.lock:
            session = self.session
            now = time.monotonic()
            if self.closed_all or not session or session.id != ident or session.stop.is_set() or now >= min(session.expires, session.hard):
                raise ShellError("shell_session_not_found", 404)
            session.expires = min(session.hard, max(session.expires, expires))
        return {"ok": True}

    def close(self, ident=None):
        if ident is not None:
            session_id(ident)
        with self.lock:
            if ident is not None:
                self.fence(ident)  # Fence even if an upgrade has not arrived yet.
            session = self.session
            if not session or (ident is not None and session.id != ident):
                return {"ok": True}
            session.request_close()
        if not session.run_done.wait(SEND_TIMEOUT + CONTROL_TIMEOUT + 3):
            # The transport still owns the terminal; don't close its FD under it.
            raise ShellError("shell_cleanup_pending", 503)
        if not session.done.is_set() and not session.settle_cleanup():
            raise ShellError("shell_cleanup_pending", 503)
        return {"ok": True}

    def close_all(self):
        # Without an upstream generation header, a permanent boot-local fence is
        # the only way to reject every unknown pre-close in-flight handshake.
        # Suspend/delete stop this bridge; a new boot constructs a new manager.
        with self.lock:
            self.closed_all = True
        return self.close()

    @contextmanager
    def checkpoint_guard(self):
        with self.lock:
            if self.session:
                raise ValueError("Shell session is still running; close it before checkpoint or restore")
            self.snapshot = True
        try:
            yield
        finally:
            with self.lock:
                self.snapshot = False


class ShellBridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(*args, **kwargs)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def server_bind(self):
        TCPServer.server_bind(self)
        self.server_name, self.server_port = "timber-shell", self.server_address[1]

    def get_request(self):
        sock, addr = super().get_request()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 64 * 1024)
        sock.settimeout(5)  # Bounded incomplete HTTP headers/upgrade.
        return sock, addr


def create_handler(manager, token):
    if not isinstance(token, str) or len(token) < 24:
        raise ValueError("Computer authentication is not configured")
    expected = ("Bearer " + token).encode()

    class Handler(BaseHTTPRequestHandler):
        # No buffered prefetch: bytes after upgrade belong to the WS parser.
        rbufsize = 0
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def one(self, key):
            values = self.headers.get_all(key, [])
            return values[0] if len(values) == 1 else ""

        def authorized(self):
            return hmac.compare_digest(self.one("Authorization").encode(), expected)

        def reject(self, code, status):
            data = json.dumps({"error": {"code": code}}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def do_POST(self):
            if not self.authorized():
                return self.reject("shell_unauthorized", 401)
            try:
                if self.one("Transfer-Encoding") or not self.one("Content-Length").isascii() or not self.one("Content-Length").isdigit():
                    raise ShellError("shell_invalid_message")
                length = int(self.one("Content-Length"))
                if not 0 < length <= MAX_FRAME:
                    raise ShellError("shell_invalid_message")
                payload = bytearray()
                deadline = time.monotonic() + 5
                while len(payload) < length:
                    remaining_time = deadline - time.monotonic()
                    if remaining_time <= 0:
                        raise ShellError("shell_invalid_message")
                    self.connection.settimeout(remaining_time)
                    chunk = self.rfile.read(length - len(payload))
                    if not chunk:
                        raise ShellError("shell_invalid_message")
                    payload.extend(chunk)
                body = json.loads(payload)
                if not isinstance(body, dict):
                    raise ShellError("shell_invalid_message")
                if self.path == "/shell/renew" and set(body) == {"sessionId", "expiresAt"}:
                    value = manager.renew(body["sessionId"], body["expiresAt"])
                elif self.path == "/shell/close" and set(body) == {"sessionId"}:
                    value = manager.close(body["sessionId"])
                elif self.path == "/shell/close-all" and not body:
                    value = manager.close_all()
                else:
                    raise ShellError("shell_invalid_message")
                data = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)
                self.close_connection = True
            except ShellError as exc:
                return self.reject(exc.code, exc.status)
            except (ValueError, OSError, RecursionError):
                return self.reject("shell_invalid_message", 400)

        def do_GET(self):
            if not self.authorized():
                return self.reject("shell_unauthorized", 401)
            if self.path == "/health":
                data = b'{"ok":true,"protocol":"timber-shell.v1"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)
                self.close_connection = True
                return
            if self.path not in ("/", "/shell"):
                return self.reject("shell_not_found", 404)
            try:
                if self.one("Upgrade").lower() != "websocket" or "upgrade" not in [v.strip().lower() for v in self.one("Connection").split(",")]:
                    raise ShellError("shell_invalid_upgrade")
                if self.one("Sec-WebSocket-Version") != "13" or self.one("Sec-WebSocket-Protocol") != PROTOCOL:
                    raise ShellError("shell_invalid_upgrade")
                key = self.one("Sec-WebSocket-Key")
                if len(base64.b64decode(key, validate=True)) != 16:
                    raise ShellError("shell_invalid_upgrade")
                expiry = self.one("X-Timber-Shell-Expires")
                if not expiry.isascii() or not expiry.isdigit():
                    raise ShellError("shell_invalid_lease")
                session = manager.open(self.one("X-Timber-Shell-Session"), int(expiry))
            except ShellError as exc:
                return self.reject(exc.code, exc.status)
            except (ValueError, OSError):
                return self.reject("shell_invalid_upgrade", 400)
            try:
                self.send_response(101)
                self.send_header("Upgrade", "websocket")
                self.send_header("Connection", "Upgrade")
                self.send_header("Sec-WebSocket-Protocol", PROTOCOL)
                self.send_header("Sec-WebSocket-Accept", base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode())
                self.end_headers()
                self.close_connection = True
                session.run(self.connection)
            finally:
                if not session.run_done.is_set():
                    session.request_close()
                    session.settle_cleanup()
                    session.run_done.set()
    return Handler


def start_bridge(manager, token, host="0.0.0.0", port=6082):
    server = ShellBridgeServer((host, port), create_handler(manager, token))
    thread = threading.Thread(target=server.serve_forever, name="shell-bridge", daemon=True)
    thread.start()
    return server


def ready(token, port=6082):
    """Authenticated non-starting protocol probe, not merely an open TCP port."""
    import http.client
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=.3)
    try:
        connection.request("GET", "/health", headers={"Authorization": "Bearer " + token})
        response = connection.getresponse()
        return response.status == 200 and response.read(128) == b'{"ok":true,"protocol":"timber-shell.v1"}'
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--supervisor":
        sys.exit(supervisor_main(int(sys.argv[2]), sys.argv[3]))
    # Standalone transport for focused tests/development. Production embeds it
    # in server.py to share atomic checkpoint and /shell/* control endpoints.
    manager = ShellManager(os.environ.get("BOTSPACE_WORKSPACE", "/workspace"))
    server = ShellBridgeServer(("0.0.0.0", 6082), create_handler(manager, os.environ.get("BOTSPACE_COMPUTER_TOKEN", "")))
    try:
        server.serve_forever()
    finally:
        manager.close()
        server.server_close()
