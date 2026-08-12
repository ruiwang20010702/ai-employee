import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { validateProjectManifest } from "./capability-policy.mjs";
import { validateProjectProfile } from "./project-profile.mjs";

const projectIdPattern = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
const execFileAsync = promisify(execFile);

async function gitRoot(rootDirectory) {
  const { stdout } = await execFileAsync(
    "/usr/bin/git",
    ["-C", rootDirectory, "rev-parse", "--show-toplevel"],
    { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
  );
  return stdout.trim();
}

function text(value, name, maximum = 200) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function textList(value, name, maximum = 20) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${name} must be an array with at most ${maximum} items`);
  }
  return [...new Set(value.map((item) => text(item, name)))];
}

export async function buildProjectOnboardingDraft({
  projectId,
  name,
  rootDirectory,
  requesterIds,
  profile,
  realpathFn = realpath,
  gitRootFn = gitRoot,
}) {
  const normalizedProjectId = text(projectId, "projectId", 64);
  if (!projectIdPattern.test(normalizedProjectId)) {
    throw new Error("projectId must use lowercase letters, numbers, _ or -");
  }
  const requestedRoot = text(rootDirectory, "rootDirectory", 4_096);
  if (!isAbsolute(requestedRoot)) throw new Error("rootDirectory must be absolute");
  const canonicalRoot = await realpathFn(requestedRoot);
  const canonicalGitRoot = await realpathFn(await gitRootFn(canonicalRoot));
  if (canonicalGitRoot !== canonicalRoot) {
    throw new Error("Project root must be the Git repository root");
  }
  const requesters = textList(requesterIds, "requesterIds", 20);
  if (requesters.length === 0) throw new Error("At least one requester is required");
  const normalizedProfile = validateProjectProfile(profile);
  const manifest = validateProjectManifest({
    version: 1,
    projectId: normalizedProjectId,
    name: text(name, "name", 200),
    rootDirectory: canonicalRoot,
    requesters,
    profile: normalizedProfile,
    capabilities: {
      knowledge_read: { mode: "disabled" },
      research: { mode: "automatic", timeoutMs: 120_000 },
      document_draft: { mode: "automatic", timeoutMs: 120_000 },
      project_memory_proposal: { mode: "disabled" },
      shared_document_write: { mode: "disabled" },
      dingtalk_todo_create: { mode: "disabled" },
      dingtalk_calendar_create: { mode: "disabled" },
      dingtalk_report_submit: { mode: "disabled" },
      code_patch: { mode: "approval_required", timeoutMs: 600_000 },
      local_branch: { mode: "approval_required", maxRuns: 1 },
      local_test: { mode: "disabled" },
      git_push: { mode: "disabled" },
      github_pr_draft: { mode: "disabled" },
      production_deploy: { mode: "disabled" },
    },
  });
  return {
    manifest,
    checklist: [
      { id: "identity", status: "ready", label: "项目身份与负责人" },
      { id: "scope", status: "ready", label: "项目目录与记忆范围" },
      { id: "capabilities", status: "review", label: "逐项确认能力和风险预算" },
      { id: "recipes", status: "review", label: "选择并演练工作配方" },
      { id: "shadow", status: "blocked", label: "通过影子运行后再开放副作用" },
    ],
    externalSideEffectsEnabled: false,
  };
}
