import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import foursday_boundary
from foursday_boundary import classify_high_risk, on_pre_tool_call
from project_router.registry import Project, RouteResult
from project_router.runtime_context import routed_project_scope


class FoursdayBoundaryTest(unittest.TestCase):
    def test_blocks_external_and_irreversible_actions(self):
        cases = [
            ("exec_command", {"command": "git push origin main"}, "git_push"),
            ("exec_command", {"command": "gh pr merge 42 --squash"}, "github_merge_or_release"),
            ("exec_command", {"command": "npm publish"}, "package_publish"),
            ("exec_command", {"command": "npm run release:local -- --apply"}, "production_deploy"),
            ("exec_command", {"command": "rm -rf build-cache"}, "irreversible_delete"),
            ("exec_command", {"command": "psql $DATABASE_URL -c 'DROP TABLE users'"}, "production_database_write"),
            ("exec_command", {"command": "security find-generic-password -s service -w"}, "secret_access"),
            ("exec_command", {"command": "launchctl kickstart gui/501/service"}, "system_control"),
        ]
        for tool, args, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(classify_high_risk(tool, args), expected)
                self.assertEqual(on_pre_tool_call(tool, args)["action"], "block")

    def test_allows_reversible_project_work(self):
        allowed = [
            ("exec_command", {"command": "rg -n 'todo' src test"}),
            ("exec_command", {"command": "npm test"}),
            ("exec_command", {"command": "git diff --check"}),
            ("write_file", {"path": "docs/analysis.md", "content": "draft"}),
            ("exec_command", {"command": "git switch -c codex/fix-docs"}),
        ]
        for tool, args in allowed:
            with self.subTest(args=args):
                self.assertIsNone(classify_high_risk(tool, args))
                self.assertIsNone(on_pre_tool_call(tool, args))

    def test_routed_project_rewrites_relative_tools_without_core_workspace_patch(self):
        with tempfile.TemporaryDirectory() as root:
            project_root = str(Path(root).resolve())
            hermes_home = str((Path(root) / "hermes").resolve())
            Path(hermes_home).mkdir()
            project = Project(
                id="fixture",
                name="Fixture",
                aliases=("fixture",),
                root=project_root,
                git_remote=None,
                gbrain_slugs=(),
                run_instructions="",
                isolation="workspace-write",
            )
            route = RouteResult("matched", project, project_root)
            with patch.dict(os.environ, {"HERMES_HOME": hermes_home}, clear=False):
                with routed_project_scope(route):
                    command = on_pre_tool_call("exec_command", {"command": "pwd"})
                    file_read = on_pre_tool_call("read_file", {"path": "README.md"})
                    escaped = on_pre_tool_call(
                        "exec_command",
                        {"command": "pwd", "cwd": "/private"},
                    )
            self.assertEqual(command["action"], "modify")
            self.assertEqual(command["args"]["cwd"], project_root)
            self.assertEqual(file_read["action"], "modify")
            self.assertEqual(file_read["args"]["path"], str(Path(project_root, "README.md")))
            self.assertEqual(escaped["action"], "block")

    @unittest.skipUnless(sys.platform == "darwin", "macOS sandbox contract")
    def test_registered_workspace_command_cannot_read_an_unmounted_sibling(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            project = base / "project"
            outside = base / "outside"
            hermes_home = base / "hermes"
            for directory in [project, outside, hermes_home]:
                directory.mkdir()
            (project / "visible.txt").write_text("visible", encoding="utf-8")
            (project / ".runtime").mkdir()
            (project / ".runtime" / "private.txt").write_text("secret", encoding="utf-8")
            (outside / "secret.txt").write_text("secret", encoding="utf-8")
            registry = base / "projects.json"
            registry.write_text(json.dumps({
                "schemaVersion": 1,
                "projects": [{
                    "id": "fixture",
                    "name": "Fixture",
                    "aliases": ["fixture"],
                    "root": str(project.resolve()),
                    "isolation": "workspace-write",
                }],
            }), encoding="utf-8")
            registry.chmod(0o600)
            foursday_boundary._PROJECT_CACHE = None
            with patch.dict(os.environ, {
                "FOURSDAY_PROJECT_REGISTRY": str(registry.resolve()),
                "HERMES_HOME": str(hermes_home.resolve()),
            }, clear=False):
                allowed = on_pre_tool_call(
                    "exec_command",
                    {"command": "cat visible.txt", "cwd": str(project.resolve())},
                )
                denied = on_pre_tool_call(
                    "exec_command",
                    {"command": f"cat {(outside / 'secret.txt').resolve()}", "cwd": str(project.resolve())},
                )
                network = on_pre_tool_call(
                    "exec_command",
                    {"command": "curl -I https://example.com", "cwd": str(project.resolve())},
                )
                web_secret = on_pre_tool_call(
                    "web_search",
                    {"query": "password=super-secret-value"},
                )
                runtime_secret = on_pre_tool_call(
                    "exec_command",
                    {"command": "cat .runtime/private.txt", "cwd": str(project.resolve())},
                )
                direct_runtime_read = on_pre_tool_call(
                    "read_file",
                    {"path": str((project / ".runtime" / "private.txt").resolve())},
                )
            self.assertEqual(allowed["action"], "modify")
            self.assertEqual(denied["action"], "modify")
            visible = subprocess.run(
                ["/bin/zsh", "-lc", allowed["args"]["command"]],
                cwd=project,
                text=True,
                capture_output=True,
                check=False,
            )
            secret = subprocess.run(
                ["/bin/zsh", "-lc", denied["args"]["command"]],
                cwd=project,
                text=True,
                capture_output=True,
                check=False,
            )
            network_result = subprocess.run(
                ["/bin/zsh", "-lc", network["args"]["command"]],
                cwd=project,
                text=True,
                capture_output=True,
                check=False,
            )
            runtime_result = subprocess.run(
                ["/bin/zsh", "-lc", runtime_secret["args"]["command"]],
                cwd=project,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(visible.returncode, 0)
            self.assertEqual(visible.stdout, "visible")
            self.assertNotEqual(secret.returncode, 0)
            self.assertNotIn("secret", secret.stdout)
            self.assertNotEqual(network_result.returncode, 0)
            self.assertEqual(web_secret["action"], "block")
            self.assertNotEqual(runtime_result.returncode, 0)
            self.assertNotIn("secret", runtime_result.stdout)
            self.assertEqual(direct_runtime_read["action"], "block")

    def test_boundary_configuration_errors_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            invalid = Path(root, "projects.json")
            invalid.write_text("not json", encoding="utf-8")
            invalid.chmod(0o600)
            foursday_boundary._PROJECT_CACHE = None
            with patch.dict(os.environ, {
                "FOURSDAY_PROJECT_REGISTRY": str(invalid.resolve()),
            }, clear=False):
                result = on_pre_tool_call(
                    "exec_command",
                    {"command": "pwd", "cwd": root},
                )
            self.assertEqual(result["action"], "block")
            self.assertIn("could not establish", result["message"])


if __name__ == "__main__":
    unittest.main()
