"""Private single-computer server. The Worker owns user auth and R2 credentials.

The VM is the isolation boundary, not this HTTP process. The operation journal
prevents an HTTP retry from repeating an effect after a connection is lost.
"""
from __future__ import annotations

import hashlib
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
import tarfile
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

MAX_JSON = 2 * 1024 * 1024
MAX_OUTPUT = 128 * 1024
MAX_READ = 256 * 1024
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_FILES = 10000
EXCLUDED = {"node_modules", ".cache", "__pycache__", ".venv"}


class Computer:
    def __init__(self, workspace: Path, state: Path):
        self.workspace = workspace.resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.state = state.resolve()
        self.state.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.state / "operations.sqlite", check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT)")
        # A process restart does not prove that an external side effect failed.
        interrupted = json.dumps({"status": "interrupted", "error": "Computer restarted during this operation; inspect its effects before creating another operation."})
        self.db.execute("UPDATE operations SET result=? WHERE result IS NULL", (interrupted,))
        self.db.commit()
        boot_file = self.state / "boot-id"
        if not boot_file.exists():
            boot_file.write_text(str(uuid.uuid4()))
        self.boot_id = boot_file.read_text()
        self.browser: subprocess.Popen | None = None

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

    def execute(self, operation_id: str, action: dict) -> dict:
        if not re.fullmatch(r"[A-Za-z0-9:_.-]{1,160}", operation_id):
            raise ValueError("Invalid operationId")
        digest = hashlib.sha256(json.dumps(action, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        with self.lock:
            row = self.db.execute("SELECT digest,result FROM operations WHERE id=?", (operation_id,)).fetchone()
            if row:
                if row[0] != digest:
                    raise ValueError("operationId was already used for different arguments")
                return {"operationId": operation_id, **json.loads(row[1])}
            self.db.execute("INSERT INTO operations(id,digest) VALUES(?,?)", (operation_id, digest))
            self.db.commit()
            try:
                result = self.action(action)
            except (ValueError, OSError, subprocess.SubprocessError) as exc:
                result = {"status": "failed", "error": str(exc)[:1000]}
            self.db.execute("UPDATE operations SET result=? WHERE id=?", (json.dumps(result), operation_id))
            self.db.commit()
            return {"operationId": operation_id, **result}

    def action(self, action: dict) -> dict:
        kind = action.get("type")
        if kind == "exec":
            command = action.get("command")
            if not isinstance(command, str) or not command or len(command) > 32768:
                raise ValueError("command must contain 1 to 32768 characters")
            timeout = action.get("timeoutMs", 30000)
            if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 120000:
                raise ValueError("timeoutMs must be between 1 and 120000")
            return self.run_shell(command, timeout / 1000)
        if kind == "writeFile":
            destination = self.path(action.get("path"))
            content = action.get("content")
            if not isinstance(content, str) or len(content.encode()) > MAX_JSON:
                raise ValueError("File content must be UTF-8 text up to 2 MiB")
            destination.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as tmp:
                name = tmp.name
                tmp.write(content.encode())
                tmp.flush()
                os.fsync(tmp.fileno())
            os.replace(name, destination)
            return {"status": "completed", "output": f"Wrote {destination.relative_to(self.workspace)}"}
        if kind == "readFile":
            path = self.path(action.get("path"))
            if path.stat().st_size > MAX_READ:
                raise ValueError("File exceeds the 256 KiB text-read limit")
            return {"status": "completed", "output": path.read_text(encoding="utf-8")}
        if kind == "listFiles":
            directory = self.path(action.get("path", "."), allow_root=True)
            entries = []
            for index, child in enumerate(sorted(directory.iterdir())):
                if index >= MAX_FILES:
                    raise ValueError("Directory has too many entries")
                entries.append({"name": child.name, "kind": "symlink" if child.is_symlink() else "directory" if child.is_dir() else "file"})
            output = json.dumps(entries)
            if len(output.encode()) > MAX_READ:
                raise ValueError("Directory listing exceeds 256 KiB; list a smaller directory")
            return {"status": "completed", "output": output}
        if kind == "screenshot":
            target = self.state / (str(uuid.uuid4()) + ".png")
            self.run(["scrot", "--overwrite", str(target)])
            return {"status": "completed", "artifactName": target.name, "mimeType": "image/png"}
        if kind == "click":
            x, y = action.get("x"), action.get("y")
            if type(x) is not int or type(y) is not int or not 0 <= x < 1280 or not 0 <= y < 800:
                raise ValueError("Coordinates must be within the 1280x800 desktop")
            button = {"left": "1", "middle": "2", "right": "3"}.get(action.get("button", "left"))
            if not button:
                raise ValueError("Unknown mouse button")
            self.run(["xdotool", "mousemove", "--sync", str(x), str(y), "click", button])
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

    def run(self, argv: list[str], **kwargs):
        # xclip forks an owner process which retains stderr. A PIPE here would
        # make communicate() wait for clipboard ownership to end before paste.
        stderr = subprocess.DEVNULL if argv[0] == "xclip" else subprocess.PIPE
        return subprocess.run(argv, check=True, stdout=subprocess.DEVNULL, stderr=stderr, timeout=15, **kwargs)

    def ensure_browser(self):
        if self.browser and self.browser.poll() is None:
            self.activate_browser()
            return
        profile = self.workspace / ".browser-profile"
        profile.mkdir(exist_ok=True)
        log = open(self.state / "chromium.log", "ab")
        self.browser = subprocess.Popen([
            "chromium", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run",
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
        window = subprocess.check_output(["xdotool", "search", "--onlyvisible", "--class", "chromium"], timeout=1).splitlines()[0]
        self.run(["xdotool", "windowactivate", "--sync", window.decode()])

    @staticmethod
    def child_env():
        return {key: value for key, value in os.environ.items() if key != "BOTSPACE_COMPUTER_TOKEN"}

    def run_shell(self, command: str, timeout: float) -> dict:
        proc = subprocess.Popen(["/bin/bash", "-lc", command], cwd=self.workspace, env=self.child_env(),
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
        proc.stdout.close()
        try:
            code = proc.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(proc.pid, signal.SIGKILL)
            code = proc.wait(timeout=5)
        text = output.decode(errors="replace")
        if len(output) == MAX_OUTPUT:
            text += "\n[output truncated at 128 KiB]"
        result = {"status": "failed" if code or timed_out else "completed", "output": text, "exitCode": code}
        if timed_out:
            result["error"] = "Command timed out; its process group was terminated. External effects may have occurred."
        return result

    def checkpoint(self, resume_browser: bool = True) -> Path:
        """Quiesce Chromium, archive only portable filesystem contents, detect races.

        Managed calls are serialized. External/background writers can still exist;
        metadata checks reject detectable races rather than claim a live disk image.
        """
        with self.lock:
            browser_was_running = self.browser is not None and self.browser.poll() is None
            self.close_browser()
            fd, name = tempfile.mkstemp(suffix=".tar.gz", dir=self.state)
            os.close(fd)
            target = Path(name)
            total = 0
            root_stat = self.workspace.stat()
            before = {".": (root_stat.st_size, root_stat.st_mtime_ns)}
            try:
                with tarfile.open(target, "w:gz", dereference=False) as archive:
                    for base, dirs, files in os.walk(self.workspace, followlinks=False):
                        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED)
                        if Path(base).relative_to(self.workspace).parts[:1] == (".browser-profile",):
                            dirs[:] = [d for d in dirs if d not in {"Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache"}]
                        for entry in sorted(dirs + files):
                            path = Path(base) / entry
                            rel = path.relative_to(self.workspace).as_posix()
                            if path.is_symlink():
                                resolved = path.resolve()
                                if not resolved.is_relative_to(self.workspace):
                                    # Browser singleton sockets/locks are process-local.
                                    if rel.startswith(".browser-profile/") and path.name.startswith("Singleton"):
                                        continue
                                    raise ValueError(f"Checkpoint contains an escaping symlink: {rel}")
                            stat = path.lstat()
                            if not (path.is_file() or path.is_dir() or path.is_symlink()):
                                raise ValueError(f"Checkpoint contains a nonportable special file: {rel}")
                            total += stat.st_size
                            if total > MAX_ARCHIVE or len(before) >= MAX_FILES:
                                raise ValueError("Workspace exceeds checkpoint limit (256 MiB, 10000 entries)")
                            before[rel] = (stat.st_size, stat.st_mtime_ns)
                            # Store hardlinked files as independent regular files;
                            # the portable restore deliberately rejects hardlinks.
                            archive.inodes.clear()
                            archive.add(path, arcname=rel, recursive=False)
                for rel, stamp in before.items():
                    stat = (self.workspace / rel).lstat()
                    if (stat.st_size, stat.st_mtime_ns) != stamp:
                        raise ValueError("Workspace changed during checkpoint; stop background writers and retry")
                if target.stat().st_size > MAX_ARCHIVE:
                    raise ValueError("Compressed checkpoint exceeds limit")
                return target
            except Exception:
                target.unlink(missing_ok=True)
                raise
            finally:
                if resume_browser and browser_was_running:
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
        with self.lock:
            self.close_browser()
            stage = Path(tempfile.mkdtemp(prefix="restore-", dir=self.workspace.parent))
            old = self.workspace.parent / ("previous-" + str(uuid.uuid4()))
            try:
                safe_extract(archive_path, stage)
                os.replace(self.workspace, old)
                try:
                    os.replace(stage, self.workspace)
                except Exception:
                    os.replace(old, self.workspace)
                    raise
                shutil.rmtree(old)
            finally:
                shutil.rmtree(stage, ignore_errors=True)


def safe_extract(archive_path: Path, destination: Path):
    """Extract validated regular files, directories and contained relative symlinks."""
    with tarfile.open(archive_path, "r:gz") as archive:
        members = []
        total = 0
        for member in archive:
            total += member.size
            if len(members) >= MAX_FILES or total > MAX_ARCHIVE or member.size < 0:
                raise ValueError("Archive exceeds extraction limits")
            members.append(member)
        links = set()
        seen = set()
        for item in members:
            path = PurePosixPath(item.name)
            if path.is_absolute() or ".." in path.parts or not path.parts or item.name in seen:
                raise ValueError("Invalid or duplicate archive member")
            seen.add(item.name)
            if not (item.isfile() or item.isdir() or item.issym()):
                raise ValueError("Archive hardlinks and special files are forbidden")
            if item.issym():
                link = PurePosixPath(item.linkname)
                target = (destination / item.name).parent / item.linkname
                if link.is_absolute() or not target.resolve().is_relative_to(destination.resolve()):
                    raise ValueError("Archive symlink escapes workspace")
                links.add(path)
        for item in members:
            path = PurePosixPath(item.name)
            if any(parent in links for parent in path.parents):
                raise ValueError("Archive member traverses a symlink")
        for item in sorted(members, key=lambda m: m.issym()):
            target = destination / item.name
            target.parent.mkdir(parents=True, exist_ok=True)
            if item.isdir():
                target.mkdir(exist_ok=True)
            elif item.issym():
                target.symlink_to(item.linkname)
            else:
                source = archive.extractfile(item)
                if source is None:
                    raise ValueError("Missing archive data")
                with source, open(target, "xb") as output:
                    shutil.copyfileobj(source, output, length=65536)
                target.chmod(0o700 if item.mode & 0o111 else 0o600)
        for link in links:
            try:
                if not (destination / link).resolve().is_relative_to(destination.resolve()):
                    raise ValueError("Archive symlink chain escapes workspace")
            except RuntimeError as exc:
                raise ValueError("Archive contains a symlink cycle") from exc


def create_handler(computer: Computer, token: str):
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
            if self.path == "/health":
                desktop = all(shutil.which(tool) for tool in ["scrot", "xdotool", "chromium", "xclip"])
                if desktop:
                    desktop = subprocess.run(["xdotool", "getdisplaygeometry"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2).returncode == 0
                return self.respond(200, {"ok": True, "bootId": computer.boot_id, "desktop": desktop})
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
                if self.path == "/actions":
                    return self.respond(200, computer.execute(body["operationId"], body["action"]))
                if self.path == "/checkpoint":
                    path = computer.checkpoint(resume_browser=not body.get("quiesce", False))
                    try:
                        return self.stream(path, "application/gzip")
                    finally:
                        path.unlink(missing_ok=True)
                return self.respond(404, {"error": "Not found"})
            except (ValueError, KeyError, OSError, tarfile.TarError) as exc:
                return self.respond(400, {"error": str(exc)[:1000]})
    return Handler


if __name__ == "__main__":
    token = os.environ.get("BOTSPACE_COMPUTER_TOKEN", "")
    if not token:
        raise SystemExit("BOTSPACE_COMPUTER_TOKEN must be configured")
    machine = Computer(Path(os.environ.get("BOTSPACE_WORKSPACE", "/workspace")), Path(os.environ.get("BOTSPACE_STATE", "/state")))
    ThreadingHTTPServer(("0.0.0.0", 8080), create_handler(machine, token)).serve_forever()
