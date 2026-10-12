"""Single-purpose private Wrangler process; invoked by trusted server via stdin.

Credentials are transported in memory on stdin and placed only in this process's
minimal environment for the pinned Wrangler child. The process runs under its own
UID, is nondumpable, never reads the workspace, and has no generic command API.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import sys
import tempfile

WRANGLER = "/usr/local/bin/wrangler"
MAX_REQUEST = 8 * 1024 * 1024
MAX_ARTIFACT = 4 * 1024 * 1024
ID = re.compile(r"[A-Za-z0-9:_.-]{1,160}\Z")
HEX = re.compile(r"sha256:[a-f0-9]{64}\Z")
ACCOUNT = re.compile(r"[a-f0-9]{32}\Z")
WORKER = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


def _non_dumpable() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
        raise OSError("cannot disable process dumps")


def _validate(request: object) -> tuple[dict, bytes, dict[str, str]]:
    if not isinstance(request, dict) or set(request) != {"protocolVersion", "operationId", "authorization", "pin", "artifact", "credentials"}:
        raise ValueError("invalid_request")
    if request["protocolVersion"] != 1 or not isinstance(request["operationId"], str) or not ID.fullmatch(request["operationId"]):
        raise ValueError("invalid_request")
    auth, pin, artifact = request["authorization"], request["pin"], request["artifact"]
    if not isinstance(auth, dict) or auth.get("operationId") != request["operationId"] or not isinstance(auth.get("signature"), str):
        raise ValueError("invalid_authorization")
    signed_pin = auth.get("pin")
    required_pin = ("repository", "commit", "artifactDigest", "artifactPath", "accountId", "workerName", "destination")
    if not isinstance(pin, dict) or not isinstance(signed_pin, dict) or any(signed_pin.get(k) != pin.get(k) for k in required_pin):
        # Backend signs all effective target/path fields. Optional plan metadata
        # may also be present in the signed pin.
        raise ValueError("invalid_authorization")
    if not ACCOUNT.fullmatch(pin.get("accountId", "")) or not WORKER.fullmatch(pin.get("workerName", "")):
        raise ValueError("invalid_target")
    if not isinstance(artifact, dict) or set(artifact) != {"sha256", "javascript"}:
        raise ValueError("invalid_artifact")
    js = artifact["javascript"]
    if not isinstance(js, str) or not js or len(js.encode("utf-8")) > MAX_ARTIFACT:
        raise ValueError("invalid_artifact")
    raw = js.encode("utf-8")
    digest = "sha256:" + hashlib.sha256(raw).hexdigest()
    if artifact["sha256"] != digest or pin.get("artifactDigest") != digest:
        raise ValueError("artifact_digest_mismatch")
    refs, creds = auth.get("refs"), request["credentials"]
    if not isinstance(refs, list) or len(refs) not in (1, 2) or not isinstance(creds, list) or len(creds) != len(refs):
        raise ValueError("invalid_credentials")
    indexed = {ref.get("id"): ref for ref in refs if isinstance(ref, dict)}
    if len(indexed) != len(refs):
        raise ValueError("invalid_credentials")
    env: dict[str, str] = {}
    for credential in creds:
        if not isinstance(credential, dict) or set(credential) != {"refId", "revision", "header", "prefix", "value"}:
            raise ValueError("invalid_credentials")
        ref = indexed.get(credential["refId"])
        if not ref or credential["revision"] != ref.get("revision"):
            raise ValueError("credential_reference_mismatch")
        value = credential["value"]
        if not isinstance(value, str) or not value or len(value) > 16000 or any(c in value for c in "\r\n\x00"):
            raise ValueError("invalid_credentials")
        header, prefix = credential["header"].lower(), credential["prefix"]
        if header == "authorization" and prefix == "Bearer " and len(creds) == 1:
            env["CLOUDFLARE_API_TOKEN"] = value
        elif header in {"x-auth-key", "x-auth-email"} and prefix == "" and len(creds) == 2:
            key = "CLOUDFLARE_API_KEY" if header == "x-auth-key" else "CLOUDFLARE_EMAIL"
            if key in env:
                raise ValueError("invalid_credentials")
            env[key] = value
        else:
            raise ValueError("unsupported_credential_format")
    if len(env) == 2 and set(env) != {"CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL"}:
        raise ValueError("invalid_credentials")
    return pin, raw, env


def main() -> int:
    try:
        _non_dumpable()
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if not raw or len(raw) > MAX_REQUEST:
            raise ValueError("invalid_request")
        request = json.loads(raw)
        pin, artifact, credentials_env = _validate(request)
    except Exception:
        print('{"status":"rejected","code":"invalid_request"}')
        return 0
    # Drop every inherited environment variable before adding the approved
    # Cloudflare auth vars. Neither shell nor build processes inherit this env.
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.environ.clear()
    os.environ.update({
        "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp",
        "CI": "1", "CLOUDFLARE_ACCOUNT_ID": pin["accountId"], **credentials_env,
    })
    credentials_env.clear()
    try:
        with tempfile.TemporaryDirectory(prefix="timber-deploy-") as folder:
            root = Path(folder)
            os.environ.update({"HOME": str(root), "XDG_CONFIG_HOME": str(root),
                               "XDG_CACHE_HOME": str(root / "cache"),
                               "WRANGLER_SEND_METRICS": "false",
                               "WRANGLER_LOG_PATH": "/opt/timber-secure/wrangler.log"})
            os.chmod(root, 0o700)
            (root / "worker.js").write_bytes(artifact)
            os.chmod(root / "worker.js", 0o600)
            (root / "wrangler.json").write_text(json.dumps({
                "name": pin["workerName"], "main": "worker.js",
                "compatibility_date": "2025-01-01", "workers_dev": False,
            }, separators=(",", ":")))
            os.chmod(root / "wrangler.json", 0o600)
            try:
                child = subprocess.Popen(
                    [WRANGLER, "deploy", "--config", str(root / "wrangler.json"), "--no-bundle"],
                    cwd=root, env=dict(os.environ), stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                try:
                    return_code = child.wait(timeout=180)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
                    print('{"status":"interrupted","code":"runner_outcome_unknown"}')
                    return 0
            except OSError:
                print('{"status":"interrupted","code":"runner_outcome_unknown"}')
                return 0
            if return_code == 0:
                print('{"status":"completed","code":"deploy_accepted"}')
            else:
                print('{"status":"failed","code":"provider_failed"}')
            return 0
    except OSError:
        print('{"status":"failed","code":"runner_failed"}')
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
