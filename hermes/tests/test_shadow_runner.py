from argparse import Namespace
import json
import os
from pathlib import Path
import tempfile
import unittest

from hermes.shadow_runner import (
    _parse_output,
    _prompt,
    _safe_environment,
    _sandbox_profile,
    run,
)
from project_router.registry import ProjectRegistry


class ShadowRunnerTest(unittest.IsolatedAsyncioTestCase):
    def test_prompt_is_generic_agent_contract_not_a_business_metric_template(self):
        with tempfile.TemporaryDirectory() as root:
            registry_path = Path(root, "projects.json")
            registry_path.write_text(json.dumps({
                "schemaVersion": 1,
                "projects": [{
                    "id": "vocab",
                    "name": "单词 2.2",
                    "aliases": ["2.2"],
                    "root": root,
                    "gbrainSlugs": ["projects/51t-word-2-2"],
                }],
            }), encoding="utf-8")
            route = ProjectRegistry.load(
                str(registry_path), fallback_workspace=root
            ).route(text="2.2目前怎么样？", session_key="session")
            prompt = _prompt(route, "gbrain context", "目前生产了多少？", True)
            self.assertIn("general Agent Loop", prompt)
            self.assertIn("gbrain context", prompt)
            self.assertNotIn("produced_questions", prompt)
            self.assertNotIn("68,786", prompt)
            self.assertNotIn("81,088", prompt)
            self.assertIn("Do not inspect Codex's own memory folder", prompt)

    def test_read_only_sandbox_blocks_codex_memory_and_project_writes(self):
        profile = _sandbox_profile("/tmp/project", "/tmp/hermes-home")
        self.assertIn('(deny file-write* (subpath "/tmp/project"))', profile)
        self.assertIn('/.codex/memories', profile)
        self.assertIn('(deny process-exec (literal "/usr/bin/security"))', profile)

    def test_agent_process_environment_excludes_business_and_dws_secrets(self):
        previous = dict(os.environ)
        try:
            os.environ.update({
                "DATABASE_URL": "must-not-cross",
                "AI_EMPLOYEE_DATA_KEY": "must-not-cross",
                "DWS_PATH": "/must/not/cross",
                "GH_TOKEN": "must-not-cross",
            })
            environment = _safe_environment("/tmp/hermes", "/tmp/projects.json")
        finally:
            os.environ.clear()
            os.environ.update(previous)
        for key in ["DATABASE_URL", "AI_EMPLOYEE_DATA_KEY", "DWS_PATH", "GH_TOKEN"]:
            self.assertNotIn(key, environment)
        self.assertEqual(environment["FOURSDAY_PROJECT_REGISTRY"], "/tmp/projects.json")

    def test_quiet_output_parser_keeps_natural_multiline_answer(self):
        session_id, response = _parse_output(
            "warning\n\nsession_id: test-session\n第一行\n第二行\n"
        )
        self.assertEqual(session_id, "test-session")
        self.assertEqual(response, "第一行\n第二行")

    async def test_multiple_questions_reuse_project_binding_and_hermes_session(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            project = root_path / "project"
            fallback = root_path / "fallback"
            hermes_home = root_path / "hermes-home"
            for directory in [project, fallback, hermes_home]:
                directory.mkdir()
            registry = root_path / "projects.json"
            registry.write_text(json.dumps({
                "schemaVersion": 1,
                "projects": [{
                    "id": "vocab",
                    "name": "单词 2.2",
                    "aliases": ["2.2"],
                    "root": str(project),
                }],
            }), encoding="utf-8")
            fake = root_path / "fake-hermes"
            fake.write_text(
                "#!/bin/sh\nprintf 'session_id: shared-session\\n自然回复，证据来自项目文件。\\n'\n",
                encoding="utf-8",
            )
            fake.chmod(0o700)
            result = await run(Namespace(
                registry=str(registry),
                fallback_workspace=str(fallback),
                hermes_bin=str(fake),
                hermes_home=str(hermes_home),
                node_path="/usr/bin/false",
                memory_sidecar=None,
                production_config=None,
                session_key="direct-1:trusted-user",
                route_state_file=None,
                resume=None,
                question=["2.2目前生产了多少？", "已放行多少？"],
                max_turns=5,
                timeout=30,
                read_only=False,
            ))
            self.assertTrue(result["valid"])
            self.assertEqual([turn["projectId"] for turn in result["turns"]], ["vocab", "vocab"])
            self.assertEqual(result["turns"][1]["routeStatus"], "bound")
            self.assertEqual(result["turns"][1]["sessionId"], "shared-session")


if __name__ == "__main__":
    unittest.main()
