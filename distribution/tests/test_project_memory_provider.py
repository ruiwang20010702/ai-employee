from pathlib import Path
import os
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

from dws_personal.memory import NodeProjectMemoryProvider


class FakeProject:
    gbrain_slugs = ("projects/51t-word-2-2",)


class FakeRoute:
    project = FakeProject()


class ProjectMemoryProviderTest(unittest.IsolatedAsyncioTestCase):
    async def test_exact_project_slugs_are_sent_to_read_only_sidecar(self):
        with tempfile.TemporaryDirectory() as root:
            sidecar = Path(root, "memory_sidecar.py")
            config = Path(root, "production.json")
            config.write_text("{}", encoding="utf-8")
            sidecar.write_text(textwrap.dedent("""
                import json, os, sys
                assert os.environ["HOME"] == sys.argv[1]
                request = json.loads(sys.stdin.readline())
                assert request["slugs"] == ["projects/51t-word-2-2"]
                print(json.dumps({
                    "success": True,
                    "result": {"context": "Source: gbrain:projects/51t-word-2-2"}
                }))
            """), encoding="utf-8")
            provider = NodeProjectMemoryProvider(
                node_path=sys.executable,
                sidecar_path=str(sidecar),
                config_path=str(config),
            )
            wrapper = Path(root, "wrapper.py")
            wrapper.write_text(
                f"import runpy, sys\nsys.argv = [{str(sidecar)!r}, {root!r}]\nrunpy.run_path({str(sidecar)!r}, run_name='__main__')\n",
                encoding="utf-8",
            )
            provider.sidecar_path = str(wrapper)
            with patch.dict(os.environ, {"FOURSDAY_MEMORY_HOME": root}):
                context = await provider.context_for_route(FakeRoute())
            self.assertEqual(context, "Source: gbrain:projects/51t-word-2-2")


if __name__ == "__main__":
    unittest.main()
