from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from gateway.config import Platform
from gateway.session import SessionSource
from project_router.runtime_context import (
    current_routed_principal_id,
    current_routed_project,
    routed_project_scope,
)
from agent.runtime_cwd import resolve_agent_cwd


class GatewayWorkspaceContractTest(unittest.TestCase):
    def test_native_session_source_remains_unpatched(self):
        source = SessionSource(
            platform=Platform.DINGTALK,
            chat_id="direct-1",
            chat_type="dm",
            user_id="trusted-user",
        )
        restored = SessionSource.from_dict(source.to_dict())
        self.assertEqual(restored.chat_id, "direct-1")
        self.assertEqual(restored.user_id, "trusted-user")
        self.assertFalse(hasattr(restored, "workspace_path"))

    def test_plugin_context_binds_project_and_principal_only_for_one_turn(self):
        with tempfile.TemporaryDirectory() as directory:
            project = SimpleNamespace(id="project", root=directory)
            route = SimpleNamespace(project=project, workspace_path=directory)
            before = resolve_agent_cwd()
            self.assertIsNone(current_routed_project())
            self.assertIsNone(current_routed_principal_id())
            with routed_project_scope(route, principal_id="trusted-user"):
                self.assertIs(current_routed_project(), project)
                self.assertEqual(current_routed_principal_id(), "trusted-user")
                self.assertEqual(resolve_agent_cwd(), Path(directory))
            self.assertIsNone(current_routed_project())
            self.assertIsNone(current_routed_principal_id())
            self.assertEqual(resolve_agent_cwd(), before)


if __name__ == "__main__":
    unittest.main()
