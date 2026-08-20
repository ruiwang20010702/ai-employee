import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from gbrain_memory import _handle
from project_router.runtime_context import routed_project_scope


class _Process:
    returncode = 0
    stderr = ""

    def __init__(self, stdout):
        self.stdout = stdout


class GbrainMemoryPluginTest(unittest.TestCase):
    def test_candidate_is_sent_to_host_sidecar_with_session_hash_and_minimal_env(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            for name in ["node", "sidecar.mjs", "production.json", "projects.json"]:
                (base / name).write_text("fixture", encoding="utf-8")
            captured = {}

            def run(command, **kwargs):
                captured["command"] = command
                captured["kwargs"] = kwargs
                return _Process(json.dumps({
                    "success": True,
                    "result": {
                        "accepted": True,
                        "status": "proposed",
                        "projectId": "project",
                        "automaticPromotionQueued": True,
                    },
                }) + "\n")

            environment = {
                "FOURSDAY_NODE_PATH": str((base / "node").resolve()),
                "FOURSDAY_MEMORY_CANDIDATE_SIDECAR": str((base / "sidecar.mjs").resolve()),
                "FOURSDAY_PRODUCTION_CONFIG": str((base / "production.json").resolve()),
                "FOURSDAY_PROJECT_REGISTRY": str((base / "projects.json").resolve()),
                "FOURSDAY_MEMORY_HOME": str(base.resolve()),
                "DATABASE_URL": "must-not-leak",
            }
            with patch.dict(os.environ, environment, clear=True), patch(
                "gbrain_memory.subprocess.run", side_effect=run,
            ):
                with routed_project_scope(object(), principal_id="trusted-user"):
                    result = json.loads(_handle({
                        "type": "atom",
                        "projectId": "project",
                        "factKey": "project.stable_fact",
                        "title": "Stable fact",
                        "statement": "Verified stable fact.",
                        "sensitivity": "internal",
                        "confidence": 0.99,
                        "evidence": [{
                            "relativePath": "summary.json",
                            "contentSha256": "a" * 64,
                            "description": "summary",
                        }],
                    }, session_id="session-1"))
            self.assertTrue(result["accepted"])
            payload = json.loads(captured["kwargs"]["input"])
            self.assertRegex(payload["sourceSessionHash"], r"^[a-f0-9]{64}$")
            self.assertEqual(payload["sourcePrincipalId"], "trusted-user")
            self.assertNotIn("session-1", captured["kwargs"]["input"])
            self.assertNotIn("DATABASE_URL", captured["kwargs"]["env"])
            self.assertNotIn("must-not-leak", json.dumps(captured))

    def test_sidecar_rejection_is_not_exposed_to_the_model(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            for name in ["node", "sidecar.mjs", "production.json", "projects.json"]:
                (base / name).write_text("fixture", encoding="utf-8")
            environment = {
                "FOURSDAY_NODE_PATH": str((base / "node").resolve()),
                "FOURSDAY_MEMORY_CANDIDATE_SIDECAR": str((base / "sidecar.mjs").resolve()),
                "FOURSDAY_PRODUCTION_CONFIG": str((base / "production.json").resolve()),
                "FOURSDAY_PROJECT_REGISTRY": str((base / "projects.json").resolve()),
                "FOURSDAY_MEMORY_HOME": str(base.resolve()),
            }
            with patch.dict(os.environ, environment, clear=True), patch(
                "gbrain_memory.subprocess.run",
                return_value=_Process('{"success":false,"error":"database_secret_value"}\n'),
            ):
                with routed_project_scope(object(), principal_id="trusted-user"):
                    result = _handle({}, session_id="session-1")
            self.assertIn("rejected", result)
            self.assertNotIn("database_secret_value", result)

    def test_candidate_requires_a_bound_session(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            for name in ["node", "sidecar.mjs", "production.json", "projects.json"]:
                (base / name).write_text("fixture", encoding="utf-8")
            environment = {
                "FOURSDAY_NODE_PATH": str((base / "node").resolve()),
                "FOURSDAY_MEMORY_CANDIDATE_SIDECAR": str((base / "sidecar.mjs").resolve()),
                "FOURSDAY_PRODUCTION_CONFIG": str((base / "production.json").resolve()),
                "FOURSDAY_PROJECT_REGISTRY": str((base / "projects.json").resolve()),
                "FOURSDAY_MEMORY_HOME": str(base.resolve()),
            }
            with patch.dict(os.environ, environment, clear=True), patch(
                "gbrain_memory.subprocess.run",
            ) as run:
                result = _handle({})
            self.assertIn("bound Hermes session", result)
            run.assert_not_called()

    def test_candidate_requires_a_bound_requester_identity(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            for name in ["node", "sidecar.mjs", "production.json", "projects.json"]:
                (base / name).write_text("fixture", encoding="utf-8")
            environment = {
                "FOURSDAY_NODE_PATH": str((base / "node").resolve()),
                "FOURSDAY_MEMORY_CANDIDATE_SIDECAR": str((base / "sidecar.mjs").resolve()),
                "FOURSDAY_PRODUCTION_CONFIG": str((base / "production.json").resolve()),
                "FOURSDAY_PROJECT_REGISTRY": str((base / "projects.json").resolve()),
                "FOURSDAY_MEMORY_HOME": str(base.resolve()),
            }
            with patch.dict(os.environ, environment, clear=True), patch(
                "gbrain_memory.subprocess.run",
            ) as run:
                result = _handle({}, session_id="session-1")
            self.assertIn("requester identity", result)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
