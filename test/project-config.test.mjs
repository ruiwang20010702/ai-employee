import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("新项目生成器默认关闭外部副作用能力", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-project-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("/usr/bin/git", ["-C", root, "init"]);
  const script = new URL("../scripts/创建项目配置.mjs", import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    fileURLToPath(script),
    "--project-id", "new_project",
    "--name", "新项目",
    "--root", root,
    "--requester", "user-1",
  ]);
  const manifest = JSON.parse(stdout);
  assert.equal(manifest.capabilities.research.mode, "automatic");
  assert.equal(manifest.capabilities.code_patch.mode, "approval_required");
  assert.equal(manifest.capabilities.local_test.mode, "disabled");
  assert.equal(manifest.capabilities.dingtalk_todo_create.mode, "disabled");
  assert.equal(manifest.capabilities.dingtalk_calendar_create.mode, "disabled");
  assert.equal(manifest.capabilities.dingtalk_report_submit.mode, "disabled");
  assert.equal(manifest.capabilities.git_push.mode, "disabled");
  assert.equal(manifest.capabilities.production_deploy.mode, "disabled");
});
