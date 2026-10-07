"""Run inside the built image: real WS/RFB, desktop cursor and X11 input.

No third-party test client is needed. This is only a bounded protocol smoke
client, not an implementation used by the product (which uses noVNC).
"""
import base64
import os
from pathlib import Path
import socket
import struct
import subprocess
import time


class Desktop:
    def __init__(self, port, token):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.sock.settimeout(15)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET / HTTP/1.1\r\nHost: localhost:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\nAuthorization: Bearer {token}\r\n\r\n").encode())
        response = bytearray()
        while not response.endswith(b"\r\n\r\n"):
            response.extend(self.sock.recv(1))
            assert len(response) < 16384
        assert b" 101 " in response, "Desktop websocket handshake failed"
        self.buffer = bytearray()
        assert self.read(12).startswith(b"RFB 003.")
        self.send(b"RFB 003.008\n")
        count = self.read(1)[0]
        assert 1 in self.read(count), "Expected private transport's no-password RFB security"
        self.send(b"\x01")
        assert self.read(4) == bytes(4)
        self.send(b"\x01")
        init = self.read(24)
        self.width, self.height = struct.unpack(">HH", init[:4])
        self.read(struct.unpack(">I", init[20:24])[0])
        # Explicit 32bpp little-endian true color; raw encoding makes assertions exact.
        self.send(bytes([0, 0, 0, 0, 32, 24, 0, 1]) + struct.pack(">HHH", 255, 255, 255) + bytes([16, 8, 0, 0, 0, 0]))
        self.send(struct.pack(">BBHi", 2, 0, 1, 0))

    def exact(self, count):
        data = bytearray()
        while len(data) < count:
            part = self.sock.recv(count - len(data))
            if not part: raise EOFError("Desktop closed")
            data.extend(part)
        return bytes(data)

    def read(self, count):
        while len(self.buffer) < count:
            head = self.exact(2)
            opcode, length = head[0] & 15, head[1] & 127
            if length == 126: length = struct.unpack(">H", self.exact(2))[0]
            elif length == 127: length = struct.unpack(">Q", self.exact(8))[0]
            assert length < 16 * 1024 * 1024
            payload = self.exact(length)
            if opcode == 9: self.send(payload, opcode=10)
            elif opcode in (0, 2): self.buffer.extend(payload)
            elif opcode == 8: raise EOFError("Desktop closed")
        result = bytes(self.buffer[:count])
        del self.buffer[:count]
        return result

    def send(self, payload, opcode=2):
        mask = os.urandom(4)
        size = len(payload)
        header = bytes([128 | opcode, 128 | size]) if size < 126 else bytes([128 | opcode, 254]) + struct.pack(">H", size)
        self.sock.sendall(header + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))

    def image(self):
        self.send(struct.pack(">BBHHHH", 3, 0, 0, 0, self.width, self.height))
        pixels = bytearray(self.width * self.height * 4)
        assert self.read(1) == b"\x00"
        count = struct.unpack(">xH", self.read(3))[0]
        for _ in range(count):
            x, y, width, height, encoding = struct.unpack(">HHHHi", self.read(12))
            assert encoding == 0
            raw = self.read(width * height * 4)
            for row in range(height):
                offset = ((y + row) * self.width + x) * 4
                pixels[offset:offset + width * 4] = raw[row * width * 4:(row + 1) * width * 4]
        return bytes(pixels)

    def pointer(self, x, y): self.send(struct.pack(">BBHH", 5, 0, x, y))
    def key(self, code):
        for down in (1, 0): self.send(struct.pack(">BBHI", 4, down, 0, code))
    def close(self): self.sock.close()


def command(*args): return subprocess.check_output(args, text=True).strip()
def pointer():
    values = dict(line.split("=", 1) for line in command("xdotool", "getmouselocation", "--shell").splitlines())
    return int(values["X"]), int(values["Y"])


def main():
    token = os.environ["BOTSPACE_COMPUTER_TOKEN"]
    for port in (6080, 6081):
        try: Desktop(port, "incorrect-token")
        except AssertionError: pass
        else: raise AssertionError("Desktop accepted invalid authentication")
    view = Desktop(6080, token)
    assert (view.width, view.height) == (1280, 800)
    command("xdotool", "mousemove", "200", "200")
    time.sleep(.2)
    first = view.image()
    command("xdotool", "mousemove", "400", "400")
    time.sleep(.2)
    second = view.image()
    assert first != second, "Observers must see the agent's real cursor movement"
    view.pointer(320, 240)
    time.sleep(.2)
    assert pointer() == (400, 400), "Observation must reject even directly injected pointer events"
    control = Desktop(6081, token)
    control.pointer(320, 240)
    time.sleep(.2)
    assert pointer() == (320, 240), "Control should move the actual desktop pointer"
    # Use a native terminal, proving the stream/input are not browser-only.
    marker = Path("/workspace/desktop-smoke-input.txt")
    marker.unlink(missing_ok=True)
    terminal = subprocess.Popen(["xterm", "-title", "Timber desktop smoke", "-geometry", "80x24+0+0"])
    try:
        for _ in range(30):
            found = subprocess.run(["xdotool", "search", "--name", "Timber desktop smoke"], capture_output=True, text=True)
            if found.returncode == 0: break
            time.sleep(.1)
        assert found.returncode == 0, "Native terminal did not open"
        command("xdotool", "windowfocus", found.stdout.splitlines()[0])
        for character in "printf desktop-live-ok > /workspace/desktop-smoke-input.txt": control.key(ord(character))
        control.key(0xff0d)
        for _ in range(30):
            if marker.exists(): break
            time.sleep(.1)
        assert marker.read_text() == "desktop-live-ok", "Keyboard input did not reach the native desktop app"
    finally:
        terminal.terminate()
        terminal.wait(timeout=5)
        marker.unlink(missing_ok=True)
        view.close()
        control.close()
    print("PASS desktop: authenticated live framebuffer, visible cursor, enforced observation, native pointer and keyboard")


if __name__ == "__main__": main()
