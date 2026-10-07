"""Small policy tests; websockify itself is supplied by the image's OS package."""
import email.message
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("desktop_bridge", Path(__file__).with_name("desktop_bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class DesktopAuthenticationTests(unittest.TestCase):
    def test_denies_missing_wrong_and_duplicate_credentials(self):
        validator = bridge.ComputerAuthentication("test-only-desktop-token-00000000")
        for value in (None, "Bearer wrong", "Basic test-only-desktop-token-00000000"):
            headers = email.message.Message()
            if value: headers["Authorization"] = value
            with self.assertRaises(bridge.AuthenticationError): validator.authenticate(headers)
        headers["Authorization"] = "Bearer test-only-desktop-token-00000000"
        with self.assertRaises(bridge.AuthenticationError): validator.authenticate(headers)

    def test_accepts_exact_internal_authorization(self):
        validator = bridge.ComputerAuthentication("test-only-desktop-token-00000000")
        validator.authenticate({"Authorization": "Bearer test-only-desktop-token-00000000"})

    def test_fails_closed_without_configured_token(self):
        for value in ("", "short", None):
            with self.assertRaises(ValueError): bridge.ComputerAuthentication(value)


if __name__ == "__main__": unittest.main()
