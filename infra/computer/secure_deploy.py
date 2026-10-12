"""Private secure-deploy controller path; deliberately separate from /actions."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import stat
import signal
import threading
import time

OP = re.compile(r"[A-Za-z0-9:_.-]{1,160}\Z")
REPO = re.compile(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}\Z")
COMMIT = re.compile(r"(?:[a-f0-9]{40}|[a-f0-9]{64})\Z")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
ACCOUNT = re.compile(r"[a-f0-9]{32}\Z")
WORKER = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
REF = re.compile(r"[A-Za-z0-9:_.-]{1,160}\Z")
MAX_ARTIFACT = 4 * 1024 * 1024
_ACTIVE_LOCK = threading.Lock()
_ACTIVE: dict[str, dict] = {}
_SEEN: set[str] = set()

# Public, non-secret response codes only. Never forward subprocess output.
CODES = {
    "invalid_request", "invalid_authorization", "invalid_pin", "invalid_refs",
    "artifact_not_found", "artifact_invalid", "artifact_digest_mismatch",
    "runner_unavailable", "runner_interrupted", "runner_failed",
    "deploy_accepted", "dispatch_already_seen",
}


def _need(condition: bool, code: str) -> None:
    if not condition:
        raise ValueError(code)


def _read_pinned_file(workspace: Path, relative: str) -> bytes:
    _need(isinstance(relative, str) and 1 <= len(relative) <= 512 and "\\" not in relative and "\x00" not in relative, "invalid_pin")
    parts = relative.split("/")
    _need(all(part not in {"", ".", ".."} and not part.startswith(".") for part in parts), "invalid_pin")
    root_fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY)
    current_fd = root_fd
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current_fd)
            if current_fd != root_fd:
                os.close(current_fd)
            current_fd = next_fd
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current_fd)
        try:
            file_stat = os.fstat(fd)
            _need(stat.S_ISREG(file_stat.st_mode) and file_stat.st_nlink == 1 and file_stat.st_size <= MAX_ARTIFACT and file_stat.st_size > 0, "artifact_invalid")
            chunks = []
            remaining = MAX_ARTIFACT + 1
            while remaining:
                block = os.read(fd, min(65536, remaining))
                if not block:
                    break
                chunks.append(block)
                remaining -= len(block)
            data = b"".join(chunks)
            _need(len(data) <= MAX_ARTIFACT and len(data) == file_stat.st_size, "artifact_invalid")
            return data
        finally:
            os.close(fd)
    except FileNotFoundError as exc:
        raise ValueError("artifact_not_found") from exc
    except OSError as exc:
        raise ValueError("artifact_invalid") from exc
    finally:
        if current_fd != root_fd:
            os.close(current_fd)
        os.close(root_fd)


def _validate_request(request: object) -> tuple[dict, dict, list[dict]]:
    _need(isinstance(request, dict) and set(request) == {"operationId", "authorization", "pin", "refs", "credentials"}, "invalid_request")
    operation_id = request["operationId"]
    _need(isinstance(operation_id, str) and OP.fullmatch(operation_id), "invalid_request")
    pin = request["pin"]
    pin_keys = {"repository", "commit", "artifactDigest", "artifactPath", "accountId", "workerName", "destination"}
    _need(isinstance(pin, dict) and set(pin) == pin_keys, "invalid_pin")
    _need(isinstance(pin["repository"], str) and REPO.fullmatch(pin["repository"]) and all(x not in {".", ".."} for x in pin["repository"].split("/")), "invalid_pin")
    _need(isinstance(pin["commit"], str) and COMMIT.fullmatch(pin["commit"]), "invalid_pin")
    _need(isinstance(pin["artifactDigest"], str) and DIGEST.fullmatch(pin["artifactDigest"]), "invalid_pin")
    _need(isinstance(pin["accountId"], str) and ACCOUNT.fullmatch(pin["accountId"]), "invalid_pin")
    _need(isinstance(pin["workerName"], str) and WORKER.fullmatch(pin["workerName"]), "invalid_pin")
    expected_url = f"https://api.cloudflare.com/client/v4/accounts/{pin['accountId']}/workers/scripts/{pin['workerName']}"
    _need(pin["destination"] == expected_url, "invalid_pin")
    auth = request["authorization"]
    auth_fields = {"version", "ownerId", "botId", "runId", "nativeOperationId", "operationId", "pin", "planId", "planRevision", "refs", "expiresAt", "signature"}
    _need(isinstance(auth, dict) and (set(auth) == auth_fields or set(auth) == auth_fields | {"taskId"}) and isinstance(auth.get("signature"), str) and 32 <= len(auth["signature"]) <= 4096, "invalid_authorization")
    _need(auth.get("version") == 1 and auth.get("operationId") == operation_id, "invalid_authorization")
    _need(isinstance(auth["ownerId"], str) and (auth["ownerId"] == "owner" or re.fullmatch(r"[0-9a-fA-F-]{36}", auth["ownerId"])) and isinstance(auth["botId"], str) and re.fullmatch(r"[0-9a-fA-F-]{36}", auth["botId"]) and isinstance(auth["runId"], str) and re.fullmatch(r"[0-9a-fA-F-]{36}", auth["runId"]), "invalid_authorization")
    _need(isinstance(auth["nativeOperationId"], str) and OP.fullmatch(auth["nativeOperationId"]), "invalid_authorization")
    if "taskId" in auth:
        _need(isinstance(auth["taskId"], str) and re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89ab][0-9a-fA-F]{3}-[0-9a-fA-F]{12}", auth["taskId"]), "invalid_authorization")
    _need(isinstance(auth["planId"], str) and re.fullmatch(r"[0-9a-fA-F-]{36}", auth["planId"]) and type(auth["planRevision"]) is int and auth["planRevision"] > 0, "invalid_authorization")
    _need(type(auth["expiresAt"]) is int and auth["expiresAt"] > int(time.time() * 1000), "invalid_authorization")
    signed_pin = auth.get("pin")
    _need(isinstance(signed_pin, dict), "invalid_authorization")
    for key in ("repository", "commit", "artifactDigest", "artifactPath", "accountId", "workerName", "destination"):
        _need(signed_pin.get(key) == pin[key], "invalid_authorization")
    _need(signed_pin.get("planId") == auth["planId"] and signed_pin.get("planRevision") == auth["planRevision"], "invalid_authorization")
    refs = request["refs"]
    credentials = request["credentials"]
    _need(isinstance(refs, list) and len(refs) in (1, 2) and isinstance(credentials, list) and len(credentials) == len(refs), "invalid_refs")
    ref_map = {}
    for ref in refs:
        _need(isinstance(ref, dict) and set(ref) == {"id", "revision", "permissionEpoch", "binding"}, "invalid_refs")
        _need(isinstance(ref["id"], str) and REF.fullmatch(ref["id"]) and type(ref["revision"]) is int and ref["revision"] > 0, "invalid_refs")
        _need(isinstance(ref["permissionEpoch"], str) and 1 <= len(ref["permissionEpoch"]) <= 256 and isinstance(ref["binding"], str) and 16 <= len(ref["binding"]) <= 4096, "invalid_refs")
        _need(ref["id"] not in ref_map, "invalid_refs")
        ref_map[ref["id"]] = ref
    signed_refs = auth.get("refs")
    _need(isinstance(signed_refs, list) and len(signed_refs) == len(refs), "invalid_authorization")
    for ref, signed in zip(refs, signed_refs):
        _need(isinstance(signed, dict) and all(signed.get(k) == ref[k] for k in ("id", "revision", "permissionEpoch", "binding")), "invalid_authorization")
    values = []
    for credential in credentials:
        _need(isinstance(credential, dict) and set(credential) == {"refId", "revision", "header", "prefix", "value"}, "invalid_refs")
        ref = ref_map.get(credential["refId"])
        _need(ref is not None and type(credential["revision"]) is int and credential["revision"] == ref["revision"], "invalid_refs")
        _need(isinstance(credential["header"], str) and isinstance(credential["prefix"], str), "invalid_refs")
        value = credential["value"]
        _need(isinstance(value, str) and 0 < len(value) <= 16000 and not any(c in value for c in "\r\n\x00"), "invalid_refs")
        values.append(credential)
    formats = {(x["header"].lower(), x["prefix"]) for x in values}
    _need(formats == {("authorization", "Bearer ")} and len(values) == 1 or formats == {("x-auth-key", ""), ("x-auth-email", "")} and len(values) == 2, "invalid_refs")
    _need(len({x["header"].lower() for x in values}) == len(values), "invalid_refs")
    return auth, pin, values


def cancel(operation_id: object) -> dict:
    """Fence pre-launch work or kill the exact in-flight deploy process group."""
    if not isinstance(operation_id, str) or not OP.fullmatch(operation_id):
        return {"operationId": operation_id if isinstance(operation_id, str) else "", "result": "unknown"}
    with _ACTIVE_LOCK:
        state = _ACTIVE.get(operation_id)
        if state is None:
            return {"operationId": operation_id, "result": "unknown"}
        state["cancelled"] = True
        process = state.get("process")
        launched = bool(state.get("launched"))
    if process is not None and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    # Once the runner was launched the provider may already have accepted the
    # write. Report uncertainty rather than a falsely safe cancellation receipt.
    return {"operationId": operation_id, "result": "already_dispatched" if launched else "cancelled"}


def dispatch(workspace: Path, request: object, *, runner_path: str = "/opt/botspace/secure_deploy_runner.py", setpriv: str = "/usr/bin/setpriv") -> dict:
    """Snapshot pinned artifact, then pass secrets only on a private pipe to deploy UID."""
    operation = request.get("operationId") if isinstance(request, dict) else None
    if not isinstance(operation, str) or not OP.fullmatch(operation):
        return {"operationId": "", "status": "rejected", "code": "invalid_request"}
    with _ACTIVE_LOCK:
        if operation in _SEEN:
            return {"operationId": operation, "status": "interrupted", "code": "dispatch_already_seen"}
        _SEEN.add(operation)
        state = {"cancelled": False, "launched": False, "process": None}
        _ACTIVE[operation] = state
    try:
        auth, pin, credentials = _validate_request(request)
        artifact = _read_pinned_file(workspace.resolve(), pin["artifactPath"])
        digest = "sha256:" + hashlib.sha256(artifact).hexdigest()
        _need(digest == pin["artifactDigest"], "artifact_digest_mismatch")
        # Artifact IO can be slow; reject authority that expired while snapshotting.
        _need(type(auth["expiresAt"]) is int and auth["expiresAt"] > int(time.time() * 1000), "invalid_authorization")
        try:
            javascript = artifact.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ValueError("artifact_invalid") from exc
        runner_request = {
            "protocolVersion": 1,
            "operationId": operation,
            "authorization": auth,
            "pin": pin,
            "artifact": {"sha256": digest, "javascript": javascript},
            "credentials": credentials,
        }
        encoded = json.dumps(runner_request, separators=(",", ":"), ensure_ascii=True).encode()
        if len(encoded) > 8 * 1024 * 1024:
            return {"operationId": operation, "status": "rejected", "code": "invalid_request"}
        _need(type(auth["expiresAt"]) is int and auth["expiresAt"] > int(time.time() * 1000), "invalid_authorization")
        with _ACTIVE_LOCK:
            if state["cancelled"]:
                return {"operationId": operation, "status": "interrupted", "code": "runner_interrupted"}
        # Different UID, no supplementary groups/capabilities, no shell and no
        # inherited controller environment. This is the only secret-bearing child.
        process = subprocess.Popen(
            [setpriv, "--reuid=10002", "--regid=10002", "--clear-groups", "--bounding-set=-all", "--inh-caps=-all", "--no-new-privs", "--", "/usr/bin/python3", runner_path],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={"PATH": "/usr/bin:/bin", "PYTHONUNBUFFERED": "1"},
            start_new_session=True,
        )
        with _ACTIVE_LOCK:
            state["process"] = process
            state["launched"] = True
            cancelled = state["cancelled"]
        if cancelled:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            stdout, _ = process.communicate(input=encoded, timeout=240)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            return {"operationId": operation, "status": "interrupted", "code": "runner_interrupted"}
        try:
            receipt = json.loads(stdout)
            status, code = receipt.get("status"), receipt.get("code")
        except (json.JSONDecodeError, AttributeError):
            status, code = "interrupted", "runner_interrupted"
        if code == "runner_outcome_unknown":
            code = "runner_interrupted"
        allowed = {
            ("completed", "deploy_accepted"), ("failed", "runner_failed"),
            ("rejected", "invalid_request"),
            ("rejected", "invalid_authorization"),
            ("interrupted", "runner_interrupted"), ("interrupted", "dispatch_already_seen"),
        }
        if (status, code) not in allowed or process.returncode != 0:
            status, code = "interrupted", "runner_interrupted"
        return {"operationId": operation, "status": status, "code": code}
    except ValueError as exc:
        code = str(exc) if str(exc) in CODES else "invalid_request"
        return {"operationId": operation, "status": "rejected", "code": code}
    except OSError:
        launched = bool(state.get("launched"))
        return {"operationId": operation, "status": "interrupted" if launched else "unavailable", "code": "runner_interrupted" if launched else "runner_unavailable"}
    finally:
        with _ACTIVE_LOCK:
            process = state.get("process")
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.communicate()
            except (OSError, ValueError):
                try:
                    process.wait()
                except OSError:
                    pass
        with _ACTIVE_LOCK:
            _ACTIVE.pop(operation, None)
