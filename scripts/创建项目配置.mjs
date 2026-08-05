import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { validateProjectManifest } from "../src/capability-policy.mjs";
import { loadConfig } from "../src/config.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const write = args.includes("--write");
const projectId = value("--project-id");
const name = value("--name");
const rootInput = value("--root");
const requester = value("--requester");
if (!projectId || !name || !rootInput || !requester) {
  throw new Error(
    "Usage: 创建项目配置.mjs --project-id <id> --name <中文名> --root <绝对路径> --requester <钉钉用户ID> [--write]",
  );
}
const rootDirectory = await realpath(rootInput);
const repository = (
  await execFileAsync("/usr/bin/git", ["-C", rootDirectory, "rev-parse", "--show-toplevel"])
).stdout.trim();
if ((await realpath(repository)) !== rootDirectory) {
  throw new Error("Project root must be the Git repository root");
}
const manifest = validateProjectManifest({
  version: 1,
  projectId,
  name,
  rootDirectory,
  requesters: [requester],
  capabilities: {
    knowledge_read: { mode: "disabled" },
    research: { mode: "automatic", timeoutMs: 120_000 },
    document_draft: { mode: "automatic", timeoutMs: 120_000 },
    shared_document_write: { mode: "disabled" },
    dingtalk_todo_create: { mode: "disabled" },
    dingtalk_calendar_create: { mode: "disabled" },
    dingtalk_report_submit: { mode: "disabled" },
    code_patch: { mode: "approval_required", timeoutMs: 600_000 },
    local_branch: { mode: "approval_required", maxRuns: 1 },
    local_test: { mode: "disabled" },
    git_push: { mode: "disabled" },
    production_deploy: { mode: "disabled" },
  },
});
const output = `${JSON.stringify(manifest, null, 2)}\n`;
if (!write) {
  process.stdout.write(output);
} else {
  if (process.env.AI_EMPLOYEE_CONFIG_FILE) await applyProductionConfigFile();
  const config = loadConfig({ requireTargets: false });
  await mkdir(config.projectsDirectory, { recursive: true, mode: 0o700 });
  const destination = join(config.projectsDirectory, `${projectId}.json`);
  await writeFile(destination, output, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ created: true, projectId, file: basename(destination) }));
}
