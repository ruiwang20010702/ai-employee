import os
import tempfile
import unittest

from agent.runtime_cwd import clear_session_cwd, resolve_agent_cwd
from gateway.config import Platform
from gateway.run import GatewayRunner
from gateway.session import SessionContext, SessionSource


class GatewayWorkspaceContractTest(unittest.TestCase):
    def test_session_source_roundtrip_preserves_project_workspace(self):
        with tempfile.TemporaryDirectory() as workspace:
            source = SessionSource(
                platform=Platform.DINGTALK,
                chat_id="direct-1",
                chat_type="dm",
                user_id="trusted-user",
                workspace_path=workspace,
            )
            restored = SessionSource.from_dict(source.to_dict())
            self.assertEqual(restored.workspace_path, os.path.realpath(workspace))

    def test_gateway_binds_project_workspace_to_runtime_cwd(self):
        with tempfile.TemporaryDirectory() as workspace:
            source = SessionSource(
                platform=Platform.DINGTALK,
                chat_id="direct-1",
                chat_type="dm",
                user_id="trusted-user",
                workspace_path=workspace,
            )
            runner = object.__new__(GatewayRunner)
            runner.adapters = {}
            tokens = runner._set_session_env(SessionContext(
                source=source,
                connected_platforms=[],
                home_channels={},
                session_key="agent:main:dws_personal:dm:direct-1",
            ))
            try:
                self.assertEqual(str(resolve_agent_cwd()), os.path.realpath(workspace))
            finally:
                runner._clear_session_env(tokens)
                clear_session_cwd()


if __name__ == "__main__":
    unittest.main()
