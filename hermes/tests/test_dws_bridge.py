import asyncio
import os
from pathlib import Path
import sys
import tempfile
import textwrap
import unittest

from dws_personal.bridge import JsonLineDwsBridge


class DwsBridgeTest(unittest.IsolatedAsyncioTestCase):
    async def test_json_line_sidecar_delivers_events_and_receipts(self):
        with tempfile.TemporaryDirectory() as root:
            script = Path(root, "fake_sidecar.py")
            script.write_text(textwrap.dedent("""
                import json, sys
                print(json.dumps({"type": "ready"}), flush=True)
                print(json.dumps({"type": "event", "record": {
                    "id": "message-1", "senderUserId": "trusted-user"
                }}), flush=True)
                for line in sys.stdin:
                    frame = json.loads(line)
                    result = {"success": True}
                    if frame.get("action") == "send":
                        result["messageId"] = "sent-1"
                    print(json.dumps({
                        "type": "response", "id": frame["id"], "result": result
                    }), flush=True)
                    if frame.get("action") == "shutdown":
                        break
            """), encoding="utf-8")
            bridge = JsonLineDwsBridge(
                node_path=sys.executable,
                sidecar_path=str(script),
                environment={"PATH": "/usr/bin:/bin"},
            )
            events = []

            async def on_event(record):
                events.append(record)

            await bridge.start(on_event)
            for _ in range(20):
                if events:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(events[0]["id"], "message-1")
            receipt = await bridge.send({"content": "done"})
            self.assertEqual(receipt["messageId"], "sent-1")
            await bridge.stop()

    def test_environment_factory_passes_only_bridge_configuration(self):
        with tempfile.TemporaryDirectory() as root:
            sidecar = Path(root, "sidecar.mjs")
            sidecar.write_text("", encoding="utf-8")
            previous = dict(os.environ)
            try:
                os.environ.update({
                    "FOURSDAY_NODE_PATH": sys.executable,
                    "FOURSDAY_DWS_SIDECAR": str(sidecar),
                    "DWS_PATH": "/absolute/dws",
                    "DWS_PERSONAL_ALLOWED_USERS": "trusted",
                    "DATABASE_URL": "must-not-cross",
                    "AI_EMPLOYEE_DATA_KEY": "must-not-cross",
                })
                bridge = JsonLineDwsBridge.from_environment()
            finally:
                os.environ.clear()
                os.environ.update(previous)
            self.assertEqual(bridge.environment["DWS_PATH"], "/absolute/dws")
            self.assertNotIn("DATABASE_URL", bridge.environment)
            self.assertNotIn("AI_EMPLOYEE_DATA_KEY", bridge.environment)


if __name__ == "__main__":
    unittest.main()
