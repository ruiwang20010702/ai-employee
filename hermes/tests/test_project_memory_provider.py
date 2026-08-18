from pathlib import Path
import sys
import tempfile
import textwrap
import unittest

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
                import json, sys
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
            context = await provider.context_for_route(FakeRoute())
            self.assertEqual(context, "Source: gbrain:projects/51t-word-2-2")


if __name__ == "__main__":
    unittest.main()
