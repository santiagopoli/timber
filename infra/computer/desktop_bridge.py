"""Authenticated WebSocket transport for the workspace's existing X11 desktop.

The Worker owns browser sessions and scope. This bridge accepts only the private
computer token inserted by ComputerDO, never user-supplied URL credentials. The
view server itself rejects input: a client cannot turn observation into control.
"""
from __future__ import annotations

import hmac
import os
import socket
import sys


class AuthenticationError(Exception):
    pass


def desktop_available() -> bool:
    """A non-starting readiness probe used by the authenticated control server."""
    for port in (5900, 5901, 6080, 6081):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=.15):
                pass
        except OSError:
            return False
    return True


class ComputerAuthentication:
    def __init__(self, token: str):
        if not isinstance(token, str) or len(token) < 24:
            raise ValueError("Computer authentication is not configured")
        self.expected = ("Bearer " + token).encode("utf-8")

    def authenticate(self, headers, target_host=None, target_port=None):
        supplied = headers.get("Authorization", "")
        # Reject duplicate credentials rather than accepting a convenient first.
        if hasattr(headers, "get_all") and len(headers.get_all("Authorization", [])) != 1:
            supplied = ""
        if not isinstance(supplied, str) or not hmac.compare_digest(
            supplied.encode("utf-8"), self.expected
        ):
            raise AuthenticationError("Desktop access denied")


def main():
    from websockify.auth_plugins import AuthenticationError as WebsocketAuthenticationError
    from websockify.websocketproxy import WebSocketProxy

    class WebsocketAuthentication(ComputerAuthentication):
        def authenticate(self, *args, **kwargs):
            try:
                super().authenticate(*args, **kwargs)
            except AuthenticationError:
                raise WebsocketAuthenticationError(response_code=403, response_msg="Desktop access denied") from None

    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    if mode not in {"view", "control"}:
        raise SystemExit("Expected desktop mode: view or control")
    # A checkpoint restore atomically replaces /workspace. websockify inherits
    # SimpleHTTPRequestHandler, whose constructor resolves the process cwd on
    # every connection, including WebSocket upgrades. Keep it outside that
    # replaceable directory so a restore cannot break every subsequent handshake.
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    offset = 0 if mode == "view" else 1
    WebSocketProxy(
        listen_host="0.0.0.0", listen_port=6080 + offset,
        target_host="127.0.0.1", target_port=5900 + offset,
        auth_plugin=WebsocketAuthentication(os.environ.get("BOTSPACE_COMPUTER_TOKEN", "")),
        heartbeat=20, verbose=False,
    ).start_server()


if __name__ == "__main__":
    main()
