"""Private single-computer server. The Worker owns user auth and R2 credentials.

The VM is the isolation boundary, not this HTTP process. The operation journal
prevents an HTTP retry from repeating an effect after a connection is lost.
"""
from __future__ import annotations

import hashlib
import ctypes
import errno
import hmac
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import shutil
import signal
import sqlite3
import subprocess
import struct
import tarfile
import stat
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer
from urllib.parse import urlparse, parse_qs
from workspace import WorkspaceInspector
from secure_deploy import dispatch as secure_deploy_dispatch, cancel as secure_deploy_cancel
import workspace_archive
import socket
from patch_wrangler_cli import verify_installed_cli, VerificationError as WranglerVerificationError

MAX_JSON = 2 * 1024 * 1024
MAX_OUTPUT = 128 * 1024
MAX_READ = 256 * 1024
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_FILES = 10000
MAX_SAFE_INTEGER = 9_007_199_254_740_991
DEFAULT_EXEC_YIELD_MS = 1000
EXCLUDED = {"node_modules", ".cache", "__pycache__", ".venv"}


class WorkspaceChanges:
    """One recursive Linux watch and a bounded index of persistent file metadata.

    A missing watch or lost event makes the answer conservative for this boot.
    New/moved directories are indexed only when their parent reports a change.
    Commands without events check indexed metadata, covering mmap/hardlink writes
    that inotify can miss, without reading content or rediscovering directories.
    The live browser profile is not part of automatic file checkpoints.
    """
    MODIFY, ATTRIB = 0x2, 0x4
    MOVED_FROM, MOVED_TO, CREATE, DELETE = 0x40, 0x80, 0x100, 0x200
    DELETE_SELF, MOVE_SELF = 0x400, 0x800
    OVERFLOW, IGNORED, ISDIR = 0x4000, 0x8000, 0x40000000
    MASK = MODIFY | ATTRIB | MOVED_FROM | MOVED_TO | CREATE | DELETE | DELETE_SELF | MOVE_SELF

    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.Lock()
        self.fd = -1
        self.watches: dict[int, Path] = {}
        self.files: dict[Path, tuple] = {}
        self.revision = 0
        self.healthy = False
        try:
            self.libc = ctypes.CDLL(None, use_errno=True)
            self.libc.inotify_init1.argtypes = [ctypes.c_int]
            self.libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
            self.fd = self.libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
            if self.fd < 0:
                raise OSError("Workspace watch unavailable")
            self.healthy = True
            self.add_tree(root)
            self.drain()
        except (OSError, AttributeError):
            self.healthy = False

    def included(self, path: Path, *, directory: bool = False) -> bool:
        parts = path.relative_to(self.root).parts
        parents = parts if directory else parts[:-1]
        return not any(part in EXCLUDED for part in parents) and (not parts or parts[0] != ".browser-profile")

    def add_tree(self, root: Path):
        if root.is_symlink() or not self.included(root, directory=True):
            return
        def failed(_error):
            self.healthy = False
        for directory, dirs, files in os.walk(root, onerror=failed, followlinks=False):
            path = Path(directory)
            link_dirs = [name for name in dirs if (path / name).is_symlink() and self.included(path / name, directory=True)]
            dirs[:] = [name for name in dirs if self.included(path / name, directory=True) and not (path / name).is_symlink()]
            # Directory links are stored by the checkpoint without following them.
            for name in files + link_dirs:
                target = path / name
                if self.included(target):
                    self.refresh_file(target)
                    if not self.healthy:
                        return
            # Match the archive entry budget; never let watch setup run unbounded.
            if len(self.watches) >= MAX_FILES:
                self.healthy = False
                return
            wd = self.libc.inotify_add_watch(self.fd, os.fsencode(path), self.MASK | 0x02000000 | 0x01000000)  # DONT_FOLLOW | ONLYDIR
            if wd < 0:
                self.healthy = False
                return
            self.watches[wd] = path

    @staticmethod
    def stamp(path: Path) -> tuple:
        stat = path.lstat()
        return (stat.st_ino, stat.st_mode, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)

    def refresh_file(self, path: Path):
        try:
            if path not in self.files and len(self.files) >= MAX_FILES:
                self.healthy = False
                return
            self.files[path] = self.stamp(path)
        except FileNotFoundError:
            self.files.pop(path, None)
        except OSError:
            self.healthy = False

    def audit_files(self):
        for path, previous in list(self.files.items()):
            try:
                current = self.stamp(path)
            except FileNotFoundError:
                self.files.pop(path, None)
                self.revision += 1
                continue
            except OSError:
                self.healthy = False
                return
            if current != previous:
                self.files[path] = current
                self.revision += 1

    def drain(self):
        if not self.healthy:
            return
        consumed = 0
        while True:
            try:
                events = os.read(self.fd, 65536)
            except BlockingIOError:
                return
            except OSError:
                self.healthy = False
                return
            if not events:
                self.healthy = False
                return
            consumed += len(events)
            if consumed > MAX_JSON:
                self.healthy = False
                return
            offset = 0
            while offset < len(events):
                wd, mask, _cookie, length = struct.unpack_from("iIII", events, offset)
                name = os.fsdecode(events[offset + 16:offset + 16 + length].split(b"\0", 1)[0])
                offset += 16 + length
                if mask & self.OVERFLOW:
                    self.healthy = False
                    return
                directory = self.watches.get(wd)
                if directory is None:
                    self.healthy = False
                    return
                path = directory / name if name else directory
                if mask & self.IGNORED:
                    self.watches.pop(wd, None)
                    if directory == self.root:
                        self.healthy = False
                    continue
                if directory == self.root and mask & (self.DELETE_SELF | self.MOVE_SELF):
                    self.healthy = False
                    return
                if not self.included(path, directory=bool(mask & self.ISDIR) or not name):
                    continue
                self.revision += 1
                if mask & self.ISDIR:
                    if mask & (self.DELETE | self.MOVED_FROM):
                        self.files = {file: stamp for file, stamp in self.files.items() if not file.is_relative_to(path)}
                    if mask & (self.CREATE | self.MOVED_TO) and path.is_dir():
                        self.add_tree(path)
                elif name:
                    self.refresh_file(path)
                if not self.healthy:
                    return

    def snapshot(self) -> int | None:
        with self.lock:
            self.drain()
            return self.revision if self.healthy else None

    def changed_since(self, revision: int | None) -> bool:
        with self.lock:
            self.drain()
            if revision is not None and self.healthy and self.revision == revision:
                self.audit_files()
                self.drain()
            return revision is None or not self.healthy or self.revision != revision

    def close(self):
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1


class IdempotencyConflict(ValueError):
    def __init__(self):
        super().__init__("operationId was already used for different arguments")


class ComputerHTTPServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer normally resolves the host's FQDN for metadata. Cloudflare
        # container hostnames can be 64-character IDs, exceeding IDNA's 63-byte
        # label limit. Binding this private port does not require DNS discovery.
        TCPServer.server_bind(self)
        self.server_name = "timber-computer"
        self.server_port = self.server_address[1]


class ExecutionSession:
    def __init__(self, process_id: str):
        self.id = process_id
        self.process: subprocess.Popen | None = None
        self.output = bytearray()
        self.truncated = False
        self.cancelled = threading.Event()
        self.done = threading.Event()
        self.thread: threading.Thread | None = None
        self.workspace_revision: int | None = None
        self.background_writers = False


def workspace_prefix() -> list[str]:
    """Drop model-controlled tools to the fixed workspace UID in production."""
    try:
        import pwd
        shell = pwd.getpwnam("timber-shell").pw_uid
        deploy = pwd.getpwnam("timber-deploy").pw_uid
    except (KeyError, ImportError):
        return []
    if shell != 10001 or deploy != 10002 or os.geteuid() != 0:
        return []
    return ["/usr/bin/setpriv", "--reuid=10001", "--regid=10001", "--clear-groups",
            "--bounding-set=-all", "--inh-caps=-all", "--no-new-privs", "--"]



def migrate_workspace_permissions(workspace: Path) -> None:
    """Migrate legacy root-owned regular workspace entries without path races."""
    try:
        import pwd
        if pwd.getpwnam("timber-shell").pw_uid != 10001 or os.geteuid() != 0:
            return
    except (KeyError, ImportError):
        return

    def migrate_dir(fd: int) -> None:
        for name in os.listdir(fd):
            try:
                before = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISDIR(before.st_mode):
                try:
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        actual = os.fstat(child)
                        if (actual.st_dev, actual.st_ino) != (before.st_dev, before.st_ino):
                            continue
                        if actual.st_uid == 0:
                            os.fchown(child, 10001, 10001)
                            os.fchmod(child, stat.S_IMODE(actual.st_mode) | 0o070 | stat.S_ISGID)
                        migrate_dir(child)
                    finally:
                        os.close(child)
                except OSError:
                    continue
            elif stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1:
                try:
                    file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        actual = os.fstat(file_fd)
                        if (actual.st_dev, actual.st_ino, actual.st_nlink) != (before.st_dev, before.st_ino, 1):
                            continue
                        os.fchown(file_fd, 10001, 10001)
                        os.fchmod(file_fd, stat.S_IMODE(actual.st_mode) | 0o060)
                    finally:
                        os.close(file_fd)
                except OSError:
                    continue

    root_fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        migrate_dir(root_fd)
        os.fchown(root_fd, 10001, 10001)
        os.fchmod(root_fd, 0o2770)
    finally:
        os.close(root_fd)



def open_workspace_fd(workspace: Path, relative: str, *, directory: bool = False) -> int:
    """Open a workspace entry using only no-follow dirfd traversal."""
    if directory and relative in {"", "."}:
        return os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    pure = PurePosixPath(relative)
    if pure.is_absolute() or not pure.parts or any(part in {"", ".", ".."} for part in pure.parts):
        raise ValueError("Invalid workspace path")
    root_fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    current_fd = root_fd
    try:
        parts = pure.parts if directory else pure.parts[:-1]
        for part in parts:
            try:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current_fd)
            except OSError as exc:
                if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise ValueError("Symbolic links and non-directory path components are not allowed") from exc
                raise
            if current_fd != root_fd:
                os.close(current_fd)
            current_fd = nxt
        if directory:
            result = current_fd
            current_fd = root_fd
            return result
        try:
            result = os.open(pure.parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current_fd)
        except OSError as exc:
            if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                raise ValueError("Symbolic links and non-file path components are not allowed") from exc
            raise
        return result
    finally:
        if current_fd != root_fd:
            os.close(current_fd)
        os.close(root_fd)

def ensure_workspace_directory(workspace: Path, relative: str, mode: int = 0o2770) -> int:
    pure = PurePosixPath(relative)
    if pure.is_absolute() or not pure.parts or any(part in {"", ".", ".."} for part in pure.parts):
        raise ValueError("Invalid workspace path")
    root_fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    current_fd = root_fd
    try:
        for part in pure.parts:
            try:
                os.mkdir(part, mode=mode, dir_fd=current_fd)
            except FileExistsError:
                pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current_fd)
            if workspace_prefix():
                os.fchown(next_fd, 10001, 10001)
            os.fchmod(next_fd, mode)
            if current_fd != root_fd:
                os.close(current_fd)
            current_fd = next_fd
        result = current_fd
        current_fd = root_fd
        return result
    finally:
        if current_fd != root_fd:
            os.close(current_fd)
        os.close(root_fd)


def write_workspace_file(workspace: Path, relative: str, content: bytes) -> None:
    """Atomic root-controller write via no-follow dirfds; never follows user symlinks."""
    pure = PurePosixPath(relative)
    if pure.is_absolute() or not pure.parts or any(part in {"", ".", ".."} for part in pure.parts):
        raise ValueError("Invalid workspace path")
    root_fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    current_fd = root_fd
    try:
        for part in pure.parts[:-1]:
            try:
                os.mkdir(part, mode=0o2770, dir_fd=current_fd)
            except FileExistsError:
                pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current_fd)
            os.fchown(next_fd, 10001, 10001)
            os.fchmod(next_fd, 0o2770)
            if current_fd != root_fd:
                os.close(current_fd)
            current_fd = next_fd
        temporary = ".timber-write-" + str(uuid.uuid4())
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=current_fd)
        try:
            if workspace_prefix():
                os.fchown(fd, 10001, 10001)
            os.fchmod(fd, 0o660)
            view = memoryview(content)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, pure.parts[-1], src_dir_fd=current_fd, dst_dir_fd=current_fd)
    finally:
        if current_fd != root_fd:
            os.close(current_fd)
        os.close(root_fd)


class Computer:
    def __init__(self, workspace: Path, state: Path):
        self.workspace = workspace.resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)
        migrate_workspace_permissions(self.workspace)
        self.state = state.resolve()
        self.state.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.journal_lock = threading.RLock()
        self.sessions: dict[str, ExecutionSession] = {}
        self.snapshot_in_progress = False
        self.db = sqlite3.connect(self.state / "operations.sqlite", check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS execution_sessions (id TEXT PRIMARY KEY, pid INTEGER, identity TEXT, result TEXT NOT NULL)")
        # A process restart does not prove that an external side effect failed.
        interrupted = json.dumps({"status": "interrupted", "error": "Computer restarted during this operation; inspect its effects before creating another operation."})
        self.db.execute("UPDATE operations SET result=? WHERE result IS NULL", (interrupted,))
        for process_id, pid, identity, encoded in self.db.execute("SELECT id,pid,identity,result FROM execution_sessions WHERE json_extract(result,'$.status')='running'").fetchall():
            # A server restart does not turn a saved command into a new command.
            # Only kill an orphan if Linux confirms it is the exact old process.
            if pid and identity and self.process_identity(pid) == identity:
                self.kill_process_group(pid)
            result = {**json.loads(encoded), "status": "interrupted", "error": "Computer restarted during this execution; inspect its effects before creating another operation."}
            self.db.execute("UPDATE execution_sessions SET result=? WHERE id=?", (json.dumps(result), process_id))
            self.db.execute("UPDATE operations SET result=? WHERE id=?", (json.dumps(result), process_id))
        self.db.commit()
        boot_file = self.state / "boot-id"
        if not boot_file.exists():
            boot_file.write_text(str(uuid.uuid4()))
        self.boot_id = boot_file.read_text()
        self.browser: subprocess.Popen | None = None
        self.browser_checkpoint_profile = self.workspace / ".browser-profile-baseline"
        self.workspace_changes = WorkspaceChanges(self.workspace)

    def path(self, relative: str, *, allow_root: bool = False) -> Path:
        if not isinstance(relative, str) or "\x00" in relative:
            raise ValueError("Invalid workspace path")
        # API paths are always relative. Absolute paths are never rewritten.
        pure = PurePosixPath(relative)
        if pure.is_absolute() or ".." in pure.parts:
            raise ValueError("Path must remain inside the workspace")
        candidate = self.workspace.joinpath(*pure.parts).resolve()
        if not candidate.is_relative_to(self.workspace) or (candidate == self.workspace and not allow_root):
            raise ValueError("Path must remain inside the workspace")
        return candidate

    def execute(self, operation_id: str, action: dict, git_transport: dict | None = None) -> dict:
        if not isinstance(operation_id, str) or not re.fullmatch(r"[A-Za-z0-9:_.-]{1,160}", operation_id):
            raise ValueError("Invalid operationId")
        if not isinstance(action, dict):
            raise ValueError("Invalid action")
        if action.get("type") in {"exec", "execPoll", "execCancel"}:
            return self.execute_session(operation_id, action)
        digest = hashlib.sha256(json.dumps(action, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        with self.lock:
            with self.journal_lock:
                row = self.db.execute("SELECT digest,result FROM operations WHERE id=?", (operation_id,)).fetchone()
                if row:
                    if row[0] != digest:
                        raise IdempotencyConflict()
                    return {"operationId": operation_id, **json.loads(row[1])}
                self.db.execute("INSERT INTO operations(id,digest) VALUES(?,?)", (operation_id, digest))
                self.db.commit()
            try:
                result = self.action(action, git_transport)
            except (ValueError, OSError, subprocess.SubprocessError) as exc:
                result = {"status": "failed", "error": str(exc)[:1000]}
            with self.journal_lock:
                self.db.execute("UPDATE operations SET result=? WHERE id=?", (json.dumps(result), operation_id))
                self.db.commit()
            return {"operationId": operation_id, **result}

    @staticmethod
    def process_identity(pid: int) -> str | None:
        try:
            # Linux's boot identity plus process start ticks protect against PID
            # reuse before a restarted server attempts orphan cleanup.
            boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            return f"{boot}:{fields[19]}"
        except (OSError, IndexError):
            return None

    @staticmethod
    def kill_process_group(pid: int):
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    @staticmethod
    def execution_yield(action: dict) -> int:
        value = action.get("yieldMs", DEFAULT_EXEC_YIELD_MS)
        if type(value) is not int or not 0 <= value <= 30000:
            raise ValueError("yieldMs must be an integer between 0 and 30000")
        return value

    def execute_session(self, operation_id: str, action: dict) -> dict:
        kind = action["type"]
        process_id = operation_id if kind == "exec" else action.get("processId")
        if not isinstance(process_id, str) or not re.fullmatch(r"[A-Za-z0-9:_.-]{1,160}", process_id):
            raise ValueError("Invalid processId")
        yield_ms = self.execution_yield(action) if kind != "execCancel" else 1000
        if kind == "exec":
            command = action.get("command")
            timeout_ms = action.get("timeoutMs")
            if not isinstance(command, str) or not command or len(command) > 32768:
                raise ValueError("command must contain 1 to 32768 characters")
            if "timeoutMs" in action and (type(timeout_ms) is not int or not 1 <= timeout_ms <= MAX_SAFE_INTEGER):
                raise ValueError("timeoutMs must be a positive safe integer when provided")
            # Waiting only selects when this HTTP request returns a snapshot.
            # Command and timeout still identify the admitted execution effect.
            effect = {key: value for key, value in action.items() if key != "yieldMs"}
            digest = hashlib.sha256(json.dumps(effect, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            with self.journal_lock:
                row = self.db.execute("SELECT digest,result FROM operations WHERE id=?", (process_id,)).fetchone()
                if row:
                    if row[0] != digest:
                        raise IdempotencyConflict()
                    if not self.db.execute("SELECT id FROM execution_sessions WHERE id=?", (process_id,)).fetchone():
                        # Results written by older images retain their exact
                        # journal semantics and never execute again.
                        return {"operationId": operation_id, **json.loads(row[1])}
                else:
                    cancelled = self.db.execute("SELECT result FROM execution_sessions WHERE id=?", (process_id,)).fetchone()
                    if cancelled:
                        result = json.loads(cancelled[0])
                    else:
                        if self.snapshot_in_progress:
                            raise ValueError("A workspace checkpoint or restore is in progress")
                        result = {"processId": process_id, "status": "running", "output": ""}
                        self.db.execute("INSERT INTO execution_sessions(id,result) VALUES(?,?)", (process_id, json.dumps(result)))
                    self.db.execute("INSERT INTO operations(id,digest,result) VALUES(?,?,?)", (process_id, digest, json.dumps(result)))
                    self.db.commit()
                    if result["status"] == "running":
                        session = ExecutionSession(process_id)
                        self.sessions[process_id] = session
                        session.thread = threading.Thread(target=self.run_session, args=(session, command, timeout_ms), daemon=True)
                        session.thread.start()
        elif kind == "execCancel":
            digest = hashlib.sha256(json.dumps(action, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            with self.journal_lock:
                receipt = self.db.execute("SELECT digest,result FROM operations WHERE id=?", (operation_id,)).fetchone()
                if receipt:
                    if receipt[0] != digest:
                        raise IdempotencyConflict()
                    if receipt[1] is not None:
                        return {"operationId": operation_id, **json.loads(receipt[1])}
                else:
                    self.db.execute("INSERT INTO operations(id,digest) VALUES(?,?)", (operation_id, digest))
                row = self.db.execute("SELECT result FROM execution_sessions WHERE id=?", (process_id,)).fetchone()
                if not row:
                    # Stop may arrive before the start request. This tombstone
                    # prevents that delayed request from creating any process.
                    result = {"processId": process_id, "status": "cancelled", "output": ""}
                    self.db.execute("INSERT INTO execution_sessions(id,result) VALUES(?,?)", (process_id, json.dumps(result)))
                self.db.commit()
                session = self.sessions.get(process_id) if row and json.loads(row[0])["status"] == "running" else None
                if session and not receipt:
                    session.cancelled.set()
                    process = session.process
                else:
                    process = None
            if process:
                self.kill_process_group(process.pid)
        # Polling is a read: it never adds operation journal rows, starts a
        # computer process or replays an effect after a missing receipt.
        with self.journal_lock:
            session = self.sessions.get(process_id)
        if session and yield_ms:
            session.done.wait(yield_ms / 1000)
        with self.journal_lock:
            row = self.db.execute("SELECT result FROM execution_sessions WHERE id=?", (process_id,)).fetchone()
            result = json.loads(row[0]) if row else {"processId": process_id, "status": "interrupted", "output": "", "error": "Execution session is unavailable; inspect its effects before creating another operation."}
            if kind == "execCancel":
                self.db.execute("UPDATE operations SET result=? WHERE id=? AND result IS NULL", (json.dumps(result), operation_id))
                self.db.commit()
                result = json.loads(self.db.execute("SELECT result FROM operations WHERE id=?", (operation_id,)).fetchone()[0])
        return {"operationId": operation_id, **result}

    @staticmethod
    def execution_output(session: ExecutionSession) -> str:
        encoded = session.output.decode(errors="replace").encode("utf-8")
        if session.truncated or len(encoded) > MAX_OUTPUT:
            suffix = b"\n[output truncated at 128 KiB]"
            return encoded[:MAX_OUTPUT - len(suffix)].decode("utf-8", errors="ignore") + suffix.decode()
        return encoded.decode()

    def persist_session(self, session: ExecutionSession, status: str, *, exit_code: int | None = None, error: str | None = None):
        result = {"processId": session.id, "status": status, "output": self.execution_output(session)}
        if status != "running":
            result["workspaceChanged"] = session.background_writers or self.workspace_changes.changed_since(session.workspace_revision)
        if exit_code is not None:
            result["exitCode"] = exit_code
        if error:
            result["error"] = error
        with self.journal_lock:
            # A restarted server may have fenced this exact session. Its old
            # reader cannot overwrite that interruption with a later success.
            changed = self.db.execute("UPDATE execution_sessions SET result=? WHERE id=? AND json_extract(result,'$.status')='running'", (json.dumps(result), session.id)).rowcount
            if changed:
                self.db.execute("UPDATE operations SET result=? WHERE id=?", (json.dumps(result), session.id))
                self.db.commit()

    def run_session(self, session: ExecutionSession, command: str, timeout_ms: int | None):
        selector = selectors.DefaultSelector()
        proc = None
        try:
            session.workspace_revision = self.workspace_changes.snapshot()
            if session.cancelled.is_set():
                self.persist_session(session, "cancelled")
                return
            # The wrapper cannot execute the command until its process identity
            # is durable. If this server dies in the fork/journal window, stdin
            # closes and the wrapper exits without executing any command effect.
            gate = 'IFS= read -r _timber_exec_gate && [ "$_timber_exec_gate" = execute ] || exit 0; exec /bin/bash -lc "$1" </dev/null'
            proc = subprocess.Popen([*workspace_prefix(), "/bin/bash", "-c", gate, "timber-exec-launch", command], cwd=self.workspace, env=self.child_env(),
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
            session.process = proc
            identity = self.process_identity(proc.pid)
            if identity is None:
                raise OSError("Execution process identity is unavailable")
            with self.journal_lock:
                self.db.execute("UPDATE execution_sessions SET pid=?,identity=? WHERE id=?", (proc.pid, identity, session.id))
                self.db.commit()
            if session.cancelled.is_set():
                self.kill_process_group(proc.pid)
            else:
                proc.stdin.write(b"execute\n")
                proc.stdin.flush()
            proc.stdin.close()
            selector.register(proc.stdout, selectors.EVENT_READ)
            os.set_blocking(proc.stdout.fileno(), False)
            started = time.monotonic()
            deadline = None if timeout_ms is None else started + timeout_ms / 1000
            timed_out = False
            exited_at = None
            last_publish = started
            dirty = False
            while True:
                now = time.monotonic()
                if not timed_out and deadline is not None and now >= deadline:
                    timed_out = True
                    self.kill_process_group(proc.pid)
                if session.cancelled.is_set():
                    self.kill_process_group(proc.pid)
                for key, _ in selector.select(0.05):
                    try:
                        data = os.read(key.fd, 16384)
                    except BlockingIOError:
                        continue
                    if not data:
                        selector.unregister(key.fileobj)
                    else:
                        remaining = MAX_OUTPUT - len(session.output)
                        session.output.extend(data[:remaining])
                        was_truncated = session.truncated
                        session.truncated = session.truncated or len(data) > remaining
                        dirty = dirty or remaining > 0 or session.truncated != was_truncated
                        if exited_at is not None:
                            exited_at = now
                code = proc.poll()
                if code is not None:
                    if exited_at is None:
                        exited_at = now
                    if not selector.get_map() or now - exited_at >= 0.1:
                        break
                if dirty and now - last_publish >= 0.1:
                    self.persist_session(session, "running")
                    last_publish = now
                    dirty = False
            code = proc.wait()
            # A background child can write after its parent shell has exited.
            # Such commands remain conservative even with no event yet.
            try:
                os.killpg(proc.pid, 0)
                session.background_writers = True
            except ProcessLookupError:
                pass
            status = "cancelled" if session.cancelled.is_set() else "failed" if code or timed_out else "completed"
            error = "Command timed out; its process group was terminated. External effects may have occurred." if timed_out else None
            self.persist_session(session, status, exit_code=code, error=error)
        except (OSError, ValueError, subprocess.SubprocessError, sqlite3.Error):
            if proc:
                self.kill_process_group(proc.pid)
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            try:
                if session.cancelled.is_set():
                    self.persist_session(session, "cancelled", exit_code=proc.returncode if proc else None)
                else:
                    self.persist_session(session, "interrupted" if proc else "failed", error="Execution was interrupted; inspect its effects before creating another operation." if proc else "The computer could not start this command.")
            except sqlite3.Error:
                pass  # Durable running intent is interrupted on the next startup.
        finally:
            selector.close()
            if proc and proc.stdin:
                try:
                    proc.stdin.close()
                except OSError:
                    pass
            if proc and proc.stdout:
                proc.stdout.close()
            with self.journal_lock:
                self.sessions.pop(session.id, None)
            session.done.set()

    def close(self):
        with self.journal_lock:
            sessions = list(self.sessions.values())
            for session in sessions:
                session.cancelled.set()
                if session.process:
                    self.kill_process_group(session.process.pid)
        for session in sessions:
            session.done.wait(5)
        self.close_browser()
        self.workspace_changes.close()
        with self.journal_lock:
            self.db.close()

    @contextmanager
    def workspace_snapshot(self):
        with self.lock:
            with self.journal_lock:
                if self.db.execute("SELECT id FROM execution_sessions WHERE json_extract(result,'$.status')='running' LIMIT 1").fetchone():
                    raise ValueError("Execution sessions are still running; wait for completion before checkpoint or restore")
                self.snapshot_in_progress = True
            try:
                yield
            finally:
                with self.journal_lock:
                    self.snapshot_in_progress = False

    def action(self, action: dict, git_transport: dict | None = None) -> dict:
        kind = action.get("type")
        if kind in {"gitClone", "gitPush"}:
            return self.git_action(action, git_transport)
        if kind == "writeFile":
            relative = action.get("path")
            destination = self.path(relative)
            content = action.get("content")
            if not isinstance(content, str) or len(content.encode()) > MAX_JSON:
                raise ValueError("File content must be UTF-8 text up to 2 MiB")
            write_workspace_file(self.workspace, relative, content.encode())
            return {"status": "completed", "output": f"Wrote {destination.relative_to(self.workspace)}"}
        if kind == "readFile":
            relative = action.get("path")
            path = self.path(relative)
            fd = open_workspace_fd(self.workspace, relative)
            try:
                file_stat = os.fstat(fd)
                if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_nlink > 1 or file_stat.st_size > MAX_READ:
                    raise ValueError("File exceeds the 256 KiB text-read limit")
                data = bytearray()
                while len(data) <= MAX_READ:
                    block = os.read(fd, min(65536, MAX_READ + 1 - len(data)))
                    if not block:
                        break
                    data.extend(block)
                if len(data) > MAX_READ:
                    raise ValueError("File exceeds the 256 KiB text-read limit")
                output = bytes(data).decode("utf-8")
            finally:
                os.close(fd)
            return {"status": "completed", "output": output}
        if kind == "listFiles":
            relative = action.get("path", ".")
            directory = self.path(relative, allow_root=True)
            dirfd = open_workspace_fd(self.workspace, relative, directory=True)
            entries = []
            try:
                for index, name in enumerate(sorted(os.listdir(dirfd))):
                    if index >= MAX_FILES:
                        raise ValueError("Directory has too many entries")
                    st = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
                    entries.append({"name": name, "kind": "symlink" if stat.S_ISLNK(st.st_mode) else "directory" if stat.S_ISDIR(st.st_mode) else "file"})
            finally:
                os.close(dirfd)
            output = json.dumps(entries)
            if len(output.encode()) > MAX_READ:
                raise ValueError("Directory listing exceeds 256 KiB; list a smaller directory")
            return {"status": "completed", "output": output}
        if kind == "screenshot":
            name = ".timber-screenshot-" + str(uuid.uuid4()) + ".png"
            relative = name
            temporary = self.workspace / name
            target = self.state / (str(uuid.uuid4()) + ".png")
            try:
                self.run(["scrot", "--overwrite", str(temporary)])
                fd = open_workspace_fd(self.workspace, relative)
                try:
                    image_stat = os.fstat(fd)
                    if not stat.S_ISREG(image_stat.st_mode) or image_stat.st_nlink != 1 or not 0 < image_stat.st_size <= 8 * 1024 * 1024:
                        raise ValueError("Screenshot is invalid or exceeds its size limit")
                    payload = bytearray()
                    while len(payload) <= 8 * 1024 * 1024:
                        block = os.read(fd, min(65536, 8 * 1024 * 1024 + 1 - len(payload)))
                        if not block:
                            break
                        payload.extend(block)
                    if len(payload) != image_stat.st_size or not payload.startswith(b"\x89PNG\r\n\x1a\n"):
                        raise ValueError("Screenshot is invalid or exceeds its size limit")
                    artifact_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    try:
                        view = memoryview(payload)
                        while view:
                            written = os.write(artifact_fd, view)
                            view = view[written:]
                        os.fsync(artifact_fd)
                    finally:
                        os.close(artifact_fd)
                finally:
                    os.close(fd)
                return {"status": "completed", "artifactName": target.name, "mimeType": "image/png"}
            except Exception:
                target.unlink(missing_ok=True)
                raise
            finally:
                root_fd = os.open(self.workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    try:
                        os.unlink(name, dir_fd=root_fd)
                    except FileNotFoundError:
                        pass
                finally:
                    os.close(root_fd)
        if kind == "move":
            x, y = self.mouse_point(action)
            # --sync waits for motion on older xdotool builds and can hang if
            # already at this pixel. Querying the pointer completes an X11
            # round-trip without requiring movement, also ordering later input.
            self.run(["xdotool", "mousemove", str(x), str(y), "getmouselocation"])
            return {"status": "completed", "output": f"Moved pointer to ({x}, {y})"}
        elif kind in {"click", "doubleClick"}:
            x, y = self.mouse_point(action)
            button = self.mouse_button(action)
            repeat = ["--repeat", "2", "--delay", "100"] if kind == "doubleClick" else []
            self.run(["xdotool", "mousemove", str(x), str(y), "click", *repeat, button, "getmouselocation"])
        elif kind == "drag":
            from_x, from_y = self.mouse_point(action, "fromX", "fromY")
            to_x, to_y = self.mouse_point(action, "toX", "toY")
            button = self.mouse_button(action)
            duration = action.get("durationMs", 500)
            if type(duration) is not int or not 100 <= duration <= 2000:
                raise ValueError("Drag duration must be 100 to 2000 milliseconds")
            # Validate the entire gesture before touching input. Intermediate
            # movement lets native controls observe dragging rather than a jump.
            steps = max(2, duration // 50)
            movement = ["xdotool"]
            for step in range(1, steps + 1):
                x = round(from_x + (to_x - from_x) * step / steps)
                y = round(from_y + (to_y - from_y) * step / steps)
                movement.extend(["sleep", str(duration / steps / 1000), "mousemove", str(x), str(y)])
            movement.append("getmouselocation")
            self.run(["xdotool", "mousemove", str(from_x), str(from_y), "getmouselocation"])
            try:
                # Even a failed/timeout press may have reached X11. Always try
                # to release it, including when the movement subprocess fails.
                self.run(["xdotool", "mousedown", button, "getmouselocation"])
                self.run(movement)
            finally:
                self.run(["xdotool", "mouseup", button, "getmouselocation"])
            return {"status": "completed", "output": f"Dragged from ({from_x}, {from_y}) to ({to_x}, {to_y})"}
        elif kind == "type":
            value = action.get("text")
            if not isinstance(value, str) or len(value) > 10000:
                raise ValueError("Text must have at most 10000 characters")
            # Clipboard paste supports Unicode; clear it immediately afterwards.
            self.run(["xclip", "-selection", "clipboard"], input=value.encode())
            try:
                self.run(["xdotool", "key", "--clearmodifiers", "ctrl+v"])
                time.sleep(0.15)
            finally:
                self.run(["xclip", "-selection", "clipboard"], input=b"")
        elif kind == "key":
            key = action.get("key")
            if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_+]{1,100}", key):
                raise ValueError("Invalid key combination")
            self.run(["xdotool", "key", "--clearmodifiers", key])
        elif kind == "scroll":
            amount = action.get("amount", 3)
            if type(amount) is not int or not 1 <= amount <= 30 or action.get("direction") not in {"up", "down"}:
                raise ValueError("Invalid scroll arguments")
            self.run(["xdotool", "click", "--repeat", str(amount), "--delay", "50", "4" if action["direction"] == "up" else "5"])
        elif kind == "navigate":
            url = action.get("url")
            if not isinstance(url, str) or len(url) > 8192 or urlparse(url).scheme not in {"http", "https"} or not urlparse(url).hostname:
                raise ValueError("Navigation requires an http or https URL")
            self.ensure_browser()
            self.run(["xdotool", "key", "--clearmodifiers", "ctrl+l"])
            self.run(["xclip", "-selection", "clipboard"], input=url.encode())
            self.run(["xdotool", "key", "--clearmodifiers", "ctrl+v"])
            time.sleep(0.1)
            self.run(["xdotool", "key", "Return"])
            self.run(["xclip", "-selection", "clipboard"], input=b"")
        else:
            raise ValueError(f"Unsupported action: {kind}")
        return {"status": "completed", "output": f"{kind} submitted to desktop"}

    @staticmethod
    def mouse_point(action: dict, x_name="x", y_name="y") -> tuple[int, int]:
        x, y = action.get(x_name), action.get(y_name)
        if type(x) is not int or type(y) is not int or not 0 <= x < 1280 or not 0 <= y < 800:
            raise ValueError("Coordinates must be within the 1280x800 desktop")
        return x, y

    @staticmethod
    def mouse_button(action: dict) -> str:
        button = action.get("button", "left")
        if not isinstance(button, str) or button not in {"left", "middle", "right"}:
            raise ValueError("Unknown mouse button")
        return {"left": "1", "middle": "2", "right": "3"}[button]

    def run(self, argv: list[str], **kwargs):
        # xclip forks an owner process which retains stderr. A PIPE here would
        # make communicate() wait for clipboard ownership to end before paste.
        stderr = subprocess.DEVNULL if argv[0] == "xclip" else subprocess.PIPE
        kwargs.setdefault("env", self.child_env())
        return subprocess.run([*workspace_prefix(), *argv], check=True, stdout=subprocess.DEVNULL, stderr=stderr, timeout=15, **kwargs)

    def ensure_browser(self):
        if self.browser and self.browser.poll() is None:
            self.activate_browser()
            return
        profile = self.workspace / ".browser-profile"
        if not profile.resolve().is_relative_to(self.workspace):
            raise ValueError("Browser profile must remain inside the workspace")
        profile_fd = ensure_workspace_directory(self.workspace, ".browser-profile")
        os.close(profile_fd)
        # Snapshot only while Chromium is closed. Production copying runs as the
        # workspace UID with no controller environment; local test mode remains
        # disabled for secure deployment and uses the same workspace-only data.
        if workspace_prefix():
            code = "import os,shutil,sys,tempfile; src,dst,root=sys.argv[1:]; stage=tempfile.mkdtemp(prefix='.browser-baseline-',dir=root); target=os.path.join(stage,'profile'); shutil.copytree(src,target,symlinks=True,ignore=shutil.ignore_patterns('Singleton*','Cache','Code Cache','GPUCache','ShaderCache','GrShaderCache')); old=os.path.lexists(dst); shutil.rmtree(dst,ignore_errors=True) if old and os.path.isdir(dst) and not os.path.islink(dst) else (os.unlink(dst) if old else None); os.replace(target,dst); shutil.rmtree(stage,ignore_errors=True)"
            proc = subprocess.run([*workspace_prefix(), "/usr/bin/python3", "-c", code,
                                   str(profile), str(self.browser_checkpoint_profile), str(self.workspace)],
                                  cwd=self.workspace, env=self.child_env(), stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            if proc.returncode != 0:
                raise ValueError("A consistent browser profile is unavailable; use an explicit checkpoint")
        else:
            # Unconfigured developer/test images do not enable secure deployment.
            stage = Path(tempfile.mkdtemp(prefix="browser-profile-", dir=self.workspace))
            try:
                shutil.copytree(profile, stage / "profile", symlinks=True,
                                ignore=shutil.ignore_patterns("Singleton*", "Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache", *EXCLUDED))
                shutil.rmtree(self.browser_checkpoint_profile, ignore_errors=True)
                os.replace(stage / "profile", self.browser_checkpoint_profile)
            finally:
                shutil.rmtree(stage, ignore_errors=True)
        log = open(self.state / "chromium.log", "ab")
        self.browser = subprocess.Popen([
            *workspace_prefix(), "chromium", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run",
            "--disable-session-crashed-bubble", "--restore-last-session", "--window-size=1280,800", f"--user-data-dir={profile}",
        ], stdout=log, stderr=log, start_new_session=True, env=self.child_env())
        log.close()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                self.activate_browser()
                return
            except (subprocess.SubprocessError, IndexError):
                time.sleep(0.2)
        raise ValueError("Chromium did not become ready")

    def activate_browser(self):
        window = subprocess.check_output([*workspace_prefix(), "xdotool", "search", "--onlyvisible", "--class", "chromium"], env=self.child_env(), timeout=1).splitlines()[0]
        self.run(["xdotool", "windowactivate", "--sync", window.decode()])

    @staticmethod
    def child_env():
        # Never propagate controller credentials or arbitrary container env to
        # model-controlled shell, browser, PTY or workspace build processes.
        return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/workspace", "DISPLAY": os.environ.get("DISPLAY", ":99"), "LANG": "C.UTF-8", "PYTHONUNBUFFERED": "1"}

    def run_process(self, argv: list[str], timeout: float, cwd: Path, env: dict) -> dict:
        safe_env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(cwd), "LANG": "C.UTF-8", **env}
        prefix = workspace_prefix()
        proc = subprocess.Popen([*prefix, *argv], cwd=cwd, env=safe_env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        output = bytearray()
        deadline = time.monotonic() + timeout
        timed_out = False
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                break
            for key, _ in selector.select(min(remaining, 0.1)):
                data = os.read(key.fd, 16384)
                if not data:
                    selector.unregister(key.fileobj)
                elif len(output) < MAX_OUTPUT:
                    output.extend(data[:MAX_OUTPUT - len(output)])
        selector.close()
        try:
            code = proc.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(proc.pid, signal.SIGKILL)
            code = proc.wait(timeout=5)
        if timed_out:
            # A busy host can deschedule this reader across the deadline while
            # output is already buffered. Retain those bytes after killing the
            # process group; never wait on a detached child that kept the pipe.
            os.set_blocking(proc.stdout.fileno(), False)
            while len(output) < MAX_OUTPUT:
                try:
                    data = os.read(proc.stdout.fileno(), min(16384, MAX_OUTPUT - len(output)))
                except BlockingIOError:
                    break
                if not data:
                    break
                output.extend(data)
        proc.stdout.close()
        text = output.decode(errors="replace")
        if len(output) == MAX_OUTPUT:
            text += "\n[output truncated at 128 KiB]"
        result = {"status": "failed" if code or timed_out else "completed", "output": text, "exitCode": code}
        if timed_out:
            result["error"] = "Command timed out; its process group was terminated. External effects may have occurred."
        return result

    def git_action(self, action: dict, transport: dict | None) -> dict:
        """The short-lived transport capability is never journaled or written to Git config.

        It is scoped to one repository by the host. A process with arbitrary access
        to this VM can inspect another process's environment, so it is deliberately
        not an account credential. The host revokes it after this operation.
        """
        repository = action.get("repository")
        if not isinstance(repository, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}", repository) or repository.split("/")[1] in {".", ".."}:
            raise ValueError("Invalid GitHub repository")
        branch = action.get("branch")
        if branch is not None and (not isinstance(branch, str) or len(branch) > 200 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", branch) or ".." in branch or "//" in branch or branch.endswith(("/", ".", ".lock")) or any(part.startswith(".") or part.endswith(".lock") for part in branch.split("/"))):
            raise ValueError("Invalid Git branch")
        if action["type"] == "gitPush" and not branch:
            raise ValueError("A branch is required for Git push")
        if not isinstance(transport, dict):
            raise ValueError("GitHub connection is required")
        url, token = transport.get("url"), transport.get("token")
        parsed = urlparse(url) if isinstance(url, str) else None
        if not parsed or parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.path.endswith(".git"):
            raise ValueError("Invalid private Git transport")
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9._~-]{20,512}", token):
            raise ValueError("Invalid private Git capability")
        destination = self.path(action.get("path"))
        canonical = f"https://github.com/{repository}.git"
        # Ignore inherited Git configuration and all global helpers. Credentials
        # are scoped to the exact proxy URL; redirects and other protocols are off.
        env = {key: value for key, value in self.child_env().items() if not key.startswith("GIT_")}
        # A deployment may supply a private trust store; this does not disable
        # certificate or hostname verification and is not repository controlled.
        if os.environ.get("GIT_SSL_CAINFO"):
            env["GIT_SSL_CAINFO"] = os.environ["GIT_SSL_CAINFO"]
        env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/bin/false", "SSH_ASKPASS": "/bin/false"})
        settings = [("credential.helper", ""), ("http.extraHeader", ""), ("http.followRedirects", "false"), ("http.sslVerify", "true"), ("core.hooksPath", "/dev/null"), ("core.fsmonitor", "false"), ("core.sshCommand", "/bin/false"), ("protocol.allow", "never"), ("protocol.https.allow", "always"), ("submodule.recurse", "false"), ("maintenance.auto", "false"), ("gc.auto", "0"), ("init.templateDir", "")]

        def git(args: list[str], cwd: Path, authenticated: bool = False) -> dict:
            config = settings + ([(f"http.{url}.extraHeader", f"Authorization: Bearer {token}")] if authenticated else [])
            call_env = dict(env, GIT_CONFIG_COUNT=str(len(config)))
            for index, (key, value) in enumerate(config):
                call_env[f"GIT_CONFIG_KEY_{index}"] = key
                call_env[f"GIT_CONFIG_VALUE_{index}"] = value
            result = self.run_process(["git", *args], 120, cwd, call_env)
            for key in ("output", "error"):
                if key in result:
                    result[key] = result[key].replace(token, "[redacted]").replace(url, canonical).replace(f"{parsed.scheme}://{parsed.netloc}", "https://github.com")
            return result

        try:
            if action["type"] == "gitClone":
                if destination.exists():
                    raise ValueError("Clone destination already exists; inspect it before choosing another path")
                parent_relative = PurePosixPath(action["path"]).parent.as_posix()
                parent_fd = ensure_workspace_directory(self.workspace, parent_relative) if parent_relative not in {"", "."} else os.open(self.workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                os.close(parent_fd)
                result = git(["clone", "--no-local", "--no-checkout", "--depth", "1", "--single-branch", *(["--branch", branch] if branch else []), "--", url, str(destination)], self.workspace, True)
                if (destination / ".git").is_dir():
                    clean = git(["remote", "set-url", "origin", canonical], destination)
                    if clean["status"] != "completed":
                        return {"status": "failed", "error": "Clone transport finished, but its remote could not be normalized. Inspect the destination before retrying."}
                if result["status"] == "completed":
                    checked = git(["reset", "--hard", "HEAD"], destination)
                    if checked["status"] != "completed":
                        return checked
                    result["output"] = f"Cloned {repository} into {action['path']} (depth 1)."
                return result

            git_dir = destination / ".git"
            if not git_dir.is_dir() or git_dir.is_symlink() or not git_dir.resolve().is_relative_to(self.workspace):
                raise ValueError("Push requires a regular repository inside the workspace")
            for name in ("config", "config.worktree", "commondir", "objects/info/alternates"):
                candidate = git_dir / name
                if candidate.is_symlink() or (name != "config" and candidate.exists()):
                    raise ValueError("Repository uses unsupported shared or external Git configuration")
            configured = git(["config", "--local", "--no-includes", "--name-only", "--list"], destination)
            if configured["status"] != "completed":
                raise ValueError("Cannot inspect repository configuration")
            safe_keys = re.compile(r"(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.[A-Za-z0-9_-]+\.(?:url|fetch|pushurl)|branch\..+\.(?:remote|merge)|user\.(?:name|email))", re.IGNORECASE)
            if any(not safe_keys.fullmatch(key) for key in configured.get("output", "").splitlines()):
                raise ValueError("Repository has unsupported Git configuration; remove custom includes, helpers, filters or hooks before managed push")
            # Explicit refspec and transport prevent push.default, pushurl, force,
            # tags or a malicious origin from broadening this operation.
            return git(["push", "--porcelain", "--no-verify", "--", url, f"refs/heads/{branch}:refs/heads/{branch}"], destination, True)
        except (OSError, subprocess.SubprocessError):
            return {"status": "failed", "error": "Git transport failed; inspect repository and remote state before retrying."}

    def _archive_helper(self, mode: str, descriptors: list[int], *, profile_fd: int | None = None) -> dict:
        args = ["/usr/bin/python3", "-m", "workspace_archive", mode, *(str(fd) for fd in descriptors)]
        pass_fds = tuple(descriptors)
        if profile_fd is not None:
            args.append(str(profile_fd))
            pass_fds += (profile_fd,)
        if not workspace_prefix():
            if mode == "create":
                result = workspace_archive.create_archive(descriptors[0], descriptors[1], profile_fd=profile_fd)
            else:
                result = workspace_archive.extract_archive(descriptors[0], descriptors[1])
        else:
            proc = subprocess.run([*workspace_prefix(), *args], cwd=self.workspace,
                                  env={"PATH": "/usr/bin:/bin", "HOME": "/workspace",
                                       "PYTHONPATH": str(Path(__file__).parent), "PYTHONUNBUFFERED": "1"},
                                  stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, pass_fds=pass_fds, check=False)
            if proc.returncode != 0:
                raise ValueError("Workspace archive operation failed safely")
            try:
                result = json.loads(proc.stdout)
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise ValueError("Workspace archive operation failed safely")
        if not isinstance(result, dict) or type(result.get("entries")) is not int or type(result.get("bytes")) is not int:
            raise ValueError("Workspace archive operation failed safely")
        if result["entries"] > MAX_FILES or result["bytes"] > MAX_ARCHIVE:
            raise ValueError("Workspace exceeds checkpoint limit (256 MiB, 10000 entries)")
        return result

    def checkpoint(self, resume_browser: bool = True, preserve_browser: bool = False) -> Path:
        """Create a dirfd-only portable archive in a protected state tempfile."""
        with self.workspace_snapshot():
            browser_was_running = self.browser is not None and self.browser.poll() is None
            live_browser = preserve_browser and resume_browser and browser_was_running
            profile_fd = None
            if live_browser:
                try:
                    profile_fd = open_workspace_fd(self.workspace, ".browser-profile-baseline", directory=True)
                except (OSError, ValueError) as exc:
                    raise ValueError("A consistent browser profile is unavailable; use an explicit checkpoint") from exc
            else:
                self.close_browser()
            fd, name = tempfile.mkstemp(suffix=".tar.gz", dir=self.state)
            target = Path(name)
            try:
                workspace_fd = os.open(self.workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.ftruncate(fd, 0)
                    os.lseek(fd, 0, os.SEEK_SET)
                    self._archive_helper("create", [workspace_fd, fd], profile_fd=profile_fd)
                    os.fsync(fd)
                finally:
                    os.close(workspace_fd)
                if target.stat().st_size > MAX_ARCHIVE:
                    raise ValueError("Compressed checkpoint exceeds limit")
                return target
            except Exception:
                target.unlink(missing_ok=True)
                raise
            finally:
                os.close(fd)
                if profile_fd is not None:
                    os.close(profile_fd)
                if resume_browser and browser_was_running and not live_browser:
                    self.ensure_browser()

    def close_browser(self):
        if self.browser and self.browser.poll() is None:
            os.killpg(self.browser.pid, signal.SIGTERM)
            try:
                self.browser.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(self.browser.pid, signal.SIGKILL)
                self.browser.wait(timeout=5)
        self.browser = None

    def restore(self, archive_path: Path):
        with self.workspace_snapshot():
            self.close_browser()
            archive_fd = os.open(archive_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            archive_stat = os.fstat(archive_fd)
            if not stat.S_ISREG(archive_stat.st_mode) or archive_stat.st_nlink > 1 or archive_stat.st_size > MAX_ARCHIVE:
                os.close(archive_fd)
                raise ValueError("Invalid checkpoint archive")
            stage = Path(tempfile.mkdtemp(prefix="restore-", dir=self.state))
            if workspace_prefix():
                os.chown(stage, 10001, 10001)
            os.chmod(stage, 0o700)
            stage_fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            old = self.workspace.parent / ("previous-" + str(uuid.uuid4()))
            try:
                self._archive_helper("extract", [archive_fd, stage_fd])
                os.replace(self.workspace, old)
                try:
                    os.replace(stage, self.workspace)
                except Exception:
                    os.replace(old, self.workspace)
                    raise
                shutil.rmtree(old)
            finally:
                os.close(archive_fd)
                os.close(stage_fd)
                if stage.exists():
                    shutil.rmtree(stage, ignore_errors=True)


def desktop_ready():
    try:
        for port in (6080, 6081):
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                pass
        return True
    except OSError:
        return False


def secure_deploy_capabilities() -> dict:
    """Probe pinned image, UID separation, no-root escalation and a synthetic env canary."""
    result = {"secureDeploy": False, "isolationVersion": "uid-ptrace-v1",
              "privateCredentialChannel": False, "noShellEnv": False,
              "noBuildCredentialInheritance": False, "outputRedaction": True,
              "canaryVersion": "cross-uid-proc-env-v1"}
    try:
        import pwd
        shell_uid = pwd.getpwnam("timber-shell").pw_uid
        deploy_uid = pwd.getpwnam("timber-deploy").pw_uid
        if shell_uid != 10001 or deploy_uid != 10002 or shell_uid == deploy_uid or os.geteuid() != 0:
            return result
        runner = Path("/opt/botspace/secure_deploy_runner.py")
        wrangler = Path("/usr/local/bin/wrangler")
        if not runner.is_file() or runner.stat().st_uid != 0 or runner.stat().st_mode & 0o022 or not Path("/usr/bin/setpriv").is_file():
            return result
        try:
            cli_metadata = verify_installed_cli(wrangler)
        except (OSError, WranglerVerificationError):
            return result
        log_alias = Path("/opt/timber-secure/wrangler.log")
        try:
            alias_stat = log_alias.lstat()
            parent_stat = log_alias.parent.stat()
            if (not stat.S_ISLNK(alias_stat.st_mode) or os.readlink(log_alias) != "/dev/null"
                    or alias_stat.st_uid != 0 or parent_stat.st_uid != 0 or parent_stat.st_mode & 0o022):
                return result
        except OSError:
            return result
        version = subprocess.run(["/usr/local/bin/wrangler", "--version"],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, env={"PATH": "/usr/local/bin:/usr/bin:/bin",
                                                              "WRANGLER_SEND_METRICS": "false",
                                                              "WRANGLER_LOG_PATH": str(log_alias)},
                                 timeout=5, check=False)
        if (version.returncode != 0 or version.stdout.strip() not in (b"4.147.0", b"wrangler 4.147.0")
                or version.stderr.strip()):
            return result
        # The same non-root identity used by shell/PTY/browser must not setuid to root.
        escalator = subprocess.run(["/usr/bin/setpriv", f"--reuid={shell_uid}",
                                    f"--regid={shell_uid}", "--clear-groups",
                                    "--bounding-set=-all", "--inh-caps=-all", "--no-new-privs", "--",
                                    "/usr/bin/setpriv", "--reuid=0", "--", "/usr/bin/id", "-u"],
                                   env={"PATH": "/usr/bin:/bin"}, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3, check=False)
        if escalator.returncode == 0 and escalator.stdout.strip() == b"0":
            return result
        canary = b"timber-synthetic-isolation-check-only"
        read_fd, write_fd = os.pipe()
        os.write(write_fd, canary)
        os.close(write_fd)
        probe_env = {"PATH": "/usr/bin:/bin", "TIMBER_SYNTHETIC_CANARY": canary.decode()}
        code = "import ctypes,sys,time; r=ctypes.CDLL(None).prctl(4,0,0,0,0); sys.exit(91) if r else time.sleep(3)"
        child = subprocess.Popen(["/usr/bin/setpriv", f"--reuid={deploy_uid}",
                                  f"--regid={deploy_uid}", "--clear-groups",
                                  "--bounding-set=-all", "--inh-caps=-all", "--no-new-privs", "--",
                                  "/usr/bin/python3", "-c", code, str(read_fd)],
                                 env=probe_env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True, pass_fds=(read_fd,))
        os.close(read_fd)
        try:
            deadline = time.monotonic() + 1
            hidden = None
            probe = """import sys\ntry:\n open('/proc/'+sys.argv[1]+'/environ','rb').read()\nexcept PermissionError: pass\nexcept FileNotFoundError: sys.exit(2)\nelse: sys.exit(3)\ntry:\n open('/proc/'+sys.argv[1]+'/fd/'+sys.argv[2],'rb').read()\nexcept PermissionError: pass\nexcept FileNotFoundError: sys.exit(2)\nelse: sys.exit(3)\nsys.exit(0)"""
            while time.monotonic() < deadline:
                check = subprocess.run(["/usr/bin/setpriv", f"--reuid={shell_uid}",
                                        f"--regid={shell_uid}", "--clear-groups",
                                        "--bounding-set=-all", "--inh-caps=-all", "--no-new-privs", "--",
                                        "/usr/bin/python3", "-c", probe, str(child.pid), str(read_fd)],
                                       env={"PATH": "/usr/bin:/bin"}, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2, check=False)
                if check.returncode in (0, 3):
                    hidden = check.returncode == 0
                    break
                time.sleep(0.02)
            if hidden is not True or child.poll() is not None:
                return result
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=3)
        result.update(cli_metadata)
        if cli_metadata.get("noAutomaticRetry") is not True:
            return result
        result.update({"secureDeploy": True, "privateCredentialChannel": True,
                       "noShellEnv": True, "noBuildCredentialInheritance": True})
        return result
    except (KeyError, OSError, subprocess.SubprocessError, ImportError):
        return result


def create_handler(computer: Computer, token: str):
    inspector = WorkspaceInspector(computer.workspace)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Never log request bodies, auth headers or screen contents.

        def authorized(self):
            return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token)

        def respond(self, status: int, value: dict):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-SHA256", hashlib.sha256(data).hexdigest())
            self.end_headers()
            self.wfile.write(data)

        def respond_bytes(self, data: bytes, content_type: str):
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-SHA256", hashlib.sha256(data).hexdigest())
            self.end_headers()
            self.wfile.write(data)

        def stream(self, path: Path, content_type: str):
            digest = hashlib.sha256()
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(65536), b""):
                    digest.update(chunk)
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(path.stat().st_size))
            self.send_header("X-Content-SHA256", digest.hexdigest())
            self.end_headers()
            with path.open("rb") as source:
                shutil.copyfileobj(source, self.wfile, length=65536)

        def do_GET(self):
            if not self.authorized():
                return self.respond(401, {"error": "Unauthorized"})
            if self.path == "/secure-deploy/capabilities":
                return self.respond(200, secure_deploy_capabilities())
            if self.path == "/health":
                desktop = all(shutil.which(tool) for tool in ["scrot", "xdotool", "chromium", "xclip"])
                if desktop:
                    desktop = subprocess.run([*workspace_prefix(), "xdotool", "getdisplaygeometry"], env=computer.child_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2).returncode == 0
                return self.respond(200, {"ok": True, "bootId": computer.boot_id, "desktop": desktop, "capabilities": ["gitClone", "gitPush", "workspace", "execSessions", "preserveBrowserCheckpoint", "workspaceChangeTracking"] + (["move", "doubleClick", "drag"] if desktop else []) + (["liveDesktop"] if desktop and desktop_ready() else [])})
            parsed = urlparse(self.path)
            if parsed.path.startswith("/workspace/"):
                try:
                    params = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=8)
                    arg = lambda name, default=".": params.get(name, [default])[0]
                    kind = parsed.path.removeprefix("/workspace/")
                    if kind == "download":
                        data, mime = inspector.download(arg("path"))
                        return self.respond_bytes(data, mime)
                    if kind == "tree": value = inspector.tree(arg("path"))
                    elif kind == "file": value = inspector.file(arg("path"))
                    elif kind == "projects": value = inspector.projects()
                    elif kind == "changes": value = inspector.changes(arg("project"))
                    elif kind == "diff": value = inspector.diff(arg("project"), arg("path"), arg("mode", "unstaged"))
                    else: return self.respond(404, {"error": {"code": "not_found", "message": "Workspace view not found."}})
                    return self.respond(200, value)
                except FileNotFoundError:
                    return self.respond(404, {"error": {"code": "file_not_found", "message": "This file no longer exists. Refresh the workspace."}})
                except (ValueError, OSError, RuntimeError, subprocess.SubprocessError):
                    return self.respond(400, {"error": {"code": "workspace_read_failed", "message": "This path cannot be inspected safely, or the workspace changed. Refresh and try again."}})
            if self.path.startswith("/artifacts/"):
                name = self.path.removeprefix("/artifacts/")
                if re.fullmatch(r"[a-f0-9-]{36}\.png", name) and (computer.state / name).is_file():
                    return self.stream(computer.state / name, "image/png")
            self.respond(404, {"error": "Not found"})

        def do_POST(self):
            if not self.authorized():
                return self.respond(401, {"error": "Unauthorized"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if self.path == "/restore":
                    if not 0 < length <= MAX_ARCHIVE:
                        raise ValueError("Invalid archive length")
                    with tempfile.NamedTemporaryFile(dir=computer.state) as temporary:
                        remaining = length
                        digest = hashlib.sha256()
                        while remaining:
                            chunk = self.rfile.read(min(remaining, 65536))
                            if not chunk:
                                raise ValueError("Incomplete archive")
                            temporary.write(chunk)
                            digest.update(chunk)
                            remaining -= len(chunk)
                        temporary.flush()
                        if not hmac.compare_digest(digest.hexdigest(), self.headers.get("X-Content-SHA256", "")):
                            raise ValueError("Checkpoint checksum mismatch")
                        computer.restore(Path(temporary.name))
                    return self.respond(200, {"ok": True})
                if length > MAX_JSON or length < 0:
                    return self.respond(413, {"error": "Request too large"})
                body = json.loads(self.rfile.read(length)) if length else {}
                if self.path == "/secure-deploy/cancel":
                    operation = body.get("operationId")
                    return self.respond(200, secure_deploy_cancel(operation))
                if self.path == "/secure-deploy":
                    if not secure_deploy_capabilities()["secureDeploy"]:
                        return self.respond(503, {"operationId": body.get("operationId"), "status": "unavailable", "code": "runner_unavailable"})
                    receipt = secure_deploy_dispatch(computer.workspace, body)
                    return self.respond(200, receipt)
                if self.path == "/actions":
                    return self.respond(200, computer.execute(body["operationId"], body["action"], body.get("gitTransport")))
                if self.path == "/checkpoint":
                    path = computer.checkpoint(resume_browser=not body.get("quiesce", False), preserve_browser=body.get("preserveBrowser", False))
                    try:
                        return self.stream(path, "application/gzip")
                    finally:
                        path.unlink(missing_ok=True)
                return self.respond(404, {"error": "Not found"})
            except IdempotencyConflict:
                return self.respond(409, {"error": {"code": "computer_idempotency_conflict", "message": "operationId was already used with different arguments."}})
            except (ValueError, KeyError, TypeError, OSError, tarfile.TarError) as exc:
                return self.respond(400, {"error": str(exc)[:1000]})
    return Handler


if __name__ == "__main__":
    token = os.environ.get("BOTSPACE_COMPUTER_TOKEN", "")
    if not token:
        raise SystemExit("BOTSPACE_COMPUTER_TOKEN must be configured")
    machine = Computer(Path(os.environ.get("BOTSPACE_WORKSPACE", "/workspace")), Path(os.environ.get("BOTSPACE_STATE", "/state")))
    ComputerHTTPServer(("0.0.0.0", 8080), create_handler(machine, token)).serve_forever()
