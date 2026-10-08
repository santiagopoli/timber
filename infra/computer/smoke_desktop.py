"""Run inside the built image: real WS/RFB, desktop cursor and X11 input.

No third-party test client is needed. This is only a bounded protocol smoke
client, not an implementation used by the product (which uses noVNC).
"""
import base64
import ctypes as C
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import time
import urllib.request
import uuid


class Desktop:
    def __init__(self, port, token):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.sock.settimeout(15)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET / HTTP/1.1\r\nHost: localhost:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\nAuthorization: Bearer {token}\r\n\r\n").encode())
        response = bytearray()
        while not response.endswith(b"\r\n\r\n"):
            chunk = self.sock.recv(1)
            if not chunk: raise EOFError("Desktop rejected the websocket handshake")
            response.extend(chunk)
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


def command(*args): return subprocess.check_output(args, text=True, timeout=15).strip()
def pointer():
    values = dict(line.split("=", 1) for line in command("xdotool", "getmouselocation", "--shell").splitlines())
    return int(values["X"]), int(values["Y"])


def native_mouse_smoke(token):
    """Observe real X11 events in a native window, not an xdotool exit code."""
    def action(value, operation_id=None):
        request = urllib.request.Request("http://127.0.0.1:8080/actions", data=json.dumps({"operationId": operation_id or str(uuid.uuid4()), "action": value}).encode(), headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.load(response)
        assert result["status"] == "completed", result
        return result

    # XButtonEvent and XMotionEvent have the same fields through state. The
    # complete XEvent union is 24 longs; ctypes uses the platform's native ABI.
    class PointerEvent(C.Structure):
        _fields_ = [("type", C.c_int), ("serial", C.c_ulong), ("send_event", C.c_int), ("display", C.c_void_p),
                    ("window", C.c_ulong), ("root", C.c_ulong), ("subwindow", C.c_ulong), ("time", C.c_ulong),
                    ("x", C.c_int), ("y", C.c_int), ("x_root", C.c_int), ("y_root", C.c_int), ("state", C.c_uint), ("button", C.c_uint)]
    class Event(C.Union):
        _fields_ = [("type", C.c_int), ("pointer", PointerEvent), ("pad", C.c_long * 24)]

    x11 = C.CDLL("libX11.so.6")
    def bind(name, result, *arguments):
        fn = getattr(x11, name)
        fn.restype, fn.argtypes = result, arguments
        return fn
    open_display = bind("XOpenDisplay", C.c_void_p, C.c_char_p)
    root_window = bind("XDefaultRootWindow", C.c_ulong, C.c_void_p)
    create = bind("XCreateSimpleWindow", C.c_ulong, C.c_void_p, C.c_ulong, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_uint, C.c_ulong, C.c_ulong)
    store_name = bind("XStoreName", C.c_int, C.c_void_p, C.c_ulong, C.c_char_p)
    select = bind("XSelectInput", C.c_int, C.c_void_p, C.c_ulong, C.c_long)
    map_window = bind("XMapRaised", C.c_int, C.c_void_p, C.c_ulong)
    sync = bind("XSync", C.c_int, C.c_void_p, C.c_int)
    pending = bind("XPending", C.c_int, C.c_void_p)
    next_event = bind("XNextEvent", C.c_int, C.c_void_p, C.POINTER(Event))
    translate = bind("XTranslateCoordinates", C.c_int, C.c_void_p, C.c_ulong, C.c_ulong, C.c_int, C.c_int, C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_ulong))
    query = bind("XQueryPointer", C.c_int, C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_uint))
    destroy = bind("XDestroyWindow", C.c_int, C.c_void_p, C.c_ulong)
    close = bind("XCloseDisplay", C.c_int, C.c_void_p)
    display = open_display(None)
    assert display, "Could not open the actual X11 desktop"
    window = create(display, root_window(display), 100, 100, 600, 400, 0, 0, 0x334455)
    try:
        store_name(display, window, b"Timber native mouse smoke")
        select(display, window, (1 << 2) | (1 << 3) | (1 << 6))  # press, release, motion
        map_window(display, window)
        sync(display, 0)
        command("xdotool", "windowactivate", "--sync", str(window))
        command("xdotool", "windowmove", "--sync", str(window), "100", "100")
        x, y, child = C.c_int(), C.c_int(), C.c_ulong()
        assert translate(display, window, root_window(display), 0, 0, C.byref(x), C.byref(y), C.byref(child))
        start, end = (x.value + 80, y.value + 100), (x.value + 380, y.value + 260)
        assert 0 <= start[0] < end[0] < 1280 and 0 <= start[1] < end[1] < 800
        def events():
            sync(display, 0)
            observed = []
            while pending(display):
                event = Event()
                next_event(display, C.byref(event))
                if event.type in (4, 5, 6):
                    point = event.pointer
                    observed.append((event.type, point.x_root, point.y_root, point.state, point.time, point.button))
            return observed
        events()
        action({"type": "move", "x": start[0], "y": start[1]})
        moved = events()
        assert pointer() == start, "Agent move did not position the native pointer"
        assert any(item[:3] == (6, *start) for item in moved), "Native window did not receive hover movement"
        assert not any(item[0] in (4, 5) for item in moved), "Hover unexpectedly pressed a button"

        operation_id = str(uuid.uuid4())
        double_click = {"type": "doubleClick", "x": start[0], "y": start[1]}
        first = action(double_click, operation_id)
        clicked = [item for item in events() if item[0] in (4, 5)]
        assert [item[0] for item in clicked] == [4, 5, 4, 5], "Double-click must deliver two press/release pairs"
        assert all(item[1:3] == start and item[5] == 1 for item in clicked)
        assert 0 < clicked[2][4] - clicked[0][4] < 500, "Clicks were too far apart for a double-click"
        assert action(double_click, operation_id) == first
        assert not any(item[0] in (4, 5) for item in events()), "A repeated operation replayed the double-click"

        action({"type": "drag", "fromX": start[0], "fromY": start[1], "toX": end[0], "toY": end[1], "durationMs": 500})
        dragged = events()
        assert [item[0] for item in dragged if item[0] in (4, 5)] == [4, 5]
        assert len([item for item in dragged if item[0] == 6 and item[3] & (1 << 8)]) >= 2, "Native controls did not receive held-button movement"
        assert any(item[:3] == (5, *end) for item in dragged), "Drag did not release at its destination"
        root, child, rx, ry, wx, wy, mask = C.c_ulong(), C.c_ulong(), C.c_int(), C.c_int(), C.c_int(), C.c_int(), C.c_uint()
        assert query(display, window, C.byref(root), C.byref(child), C.byref(rx), C.byref(ry), C.byref(wx), C.byref(wy), C.byref(mask))
        assert not mask.value & (1 << 8), "Drag left the mouse button held"
        assert pointer() == end
    finally:
        destroy(display, window)
        close(display)


def main():
    token = os.environ["BOTSPACE_COMPUTER_TOKEN"]
    for port in (6080, 6081):
        try: Desktop(port, "incorrect-token")
        except (AssertionError, ConnectionResetError, EOFError): pass
        else: raise AssertionError("Desktop accepted invalid authentication")
    view = Desktop(6080, token)
    assert (view.width, view.height) == (1280, 800)
    command("xdotool", "mousemove", "200", "200")
    time.sleep(1)
    first = view.image()
    command("xdotool", "mousemove", "400", "400")
    def patch(pixels, x, y):
        return b"".join(pixels[((y + row) * view.width + x) * 4:((y + row) * view.width + x + 40) * 4] for row in range(40))
    # X11 polling and the VNC update request are asynchronous. Require changed
    # pixels at BOTH old and new cursor positions, not unrelated desktop motion.
    moved = False
    for _ in range(25):
        time.sleep(.2)
        second = view.image()
        if patch(first, 195, 195) != patch(second, 195, 195) and patch(first, 395, 395) != patch(second, 395, 395):
            moved = True
            break
    assert moved, "Observers must see the agent's real cursor at its updated position"
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
    native_mouse_smoke(token)
    print("PASS desktop: authenticated live framebuffer, visible cursor, enforced observation, native pointer and keyboard, agent hover, double-click deduplication and drag/release")


if __name__ == "__main__": main()
