import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { validateProjectManifest } from "../src/capability-policy.mjs";
import {
  applyProjectMemorySettings,
  previewProjectMemorySettings,
} from "../src/project-memory-settings.mjs";
import { loadProjectManifests } from "../src/project-manifests.mjs";

const execFileAsync = promisify(execFile);
const now = new Date("2026-08-13T08:00:00.000Z");

function profile() {
  return {
    objective: "Keep durable project knowledge current",
    successCriteria: ["Every formal memory has source evidence"],
    milestones: [],
    collaborationObjects: ["repository"],
    selectedRecipeIds: [],
    memoryScope: { allowedTypes: ["project", "principle"], retentionDays: 180 },
  };
}

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "foursday-memory-settings-"));
  const root = await realpath(temporary);
  await execFileAsync("/usr/bin/git", ["init", "--quiet", root], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "decisions.md"), "# Decisions\nUse target-system read-back.\n");
  const projectsDirectory = join(root, ".foursday-projects");
  await mkdir(projectsDirectory, { mode: 0o700 });
  const manifest = validateProjectManifest({
    version: 1,
    projectId: "memory_settings_project",
    name: "Memory settings project",
    rootDirectory: root,
    requesters: ["owner-1"],
    profile: profile(),
    capabilities: {
      project_memory_proposal: { mode: "disabled" },
      research: { mode: "automatic", timeoutMs: 120_000 },
    },
  });
  const manifestPath = join(projectsDirectory, `${manifest.projectId}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, projectsDirectory, manifestPath };
}

function requestedSettings(overrides = {}) {
  return {
    mode: "approval_required",
    sourcePaths: ["docs/decisions.md"],
    allowedFactKeyPrefixes: ["decision.", "principle."],
    maxRetentionDays: 180,
    autoConfirm: false,
    expiresAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

test("项目记忆授权先绑定来源和当前清单，再以精确摘要原子应用", async (t) => {
  const { projectsDirectory, manifestPath } = await fixture(t);
  const before = await readFile(manifestPath, "utf8");
  const project = (await loadProjectManifests(projectsDirectory)).get(
    "memory_settings_project",
  );
  const settings = requestedSettings();
  const preview = await previewProjectMemorySettings({ project, settings, now });
  assert.equal(preview.databaseWrite, false);
  assert.equal(preview.externalSystemsTouched, false);
  assert.equal(preview.globalGateEnabled, false);
  assert.equal(preview.effectiveAutomaticSync, false);
  assert.equal(preview.changes.authorizationExpansion, true);
  assert.equal(preview.sources.length, 1);
  assert.equal(preview.sources[0].path, "docs/decisions.md");
  assert.match(preview.confirmation, /^MEMORY-AUTH-[A-F0-9]{12}$/u);
  assert.equal(await readFile(manifestPath, "utf8"), before);

  await assert.rejects(
    () => applyProjectMemorySettings({
      projectId: project.projectId,
      settings,
      digest: preview.digest,
      confirmation: "MEMORY-AUTH-WRONG",
      projectsDirectory,
      now,
    }),
    /review the current preview again/u,
  );
  assert.equal(await readFile(manifestPath, "utf8"), before);

  const result = await applyProjectMemorySettings({
    projectId: project.projectId,
    settings,
    digest: preview.digest,
    confirmation: preview.confirmation,
    projectsDirectory,
    now,
  });
  assert.equal(result.projectManifestWrite, true);
  assert.equal(result.databaseWrite, false);
  assert.equal(result.externalSystemsTouched, false);
  assert.equal(result.effectiveAutomaticSync, false);
  const updated = (await loadProjectManifests(projectsDirectory)).get(project.projectId);
  assert.equal(updated.capabilities.project_memory_proposal.mode, "approval_required");
  assert.deepEqual(
    updated.capabilities.project_memory_proposal.sourcePaths,
    ["docs/decisions.md"],
  );
  assert.equal(updated.capabilities.research.mode, "automatic");
  assert.equal((await lstat(manifestPath)).mode & 0o777, 0o600);
});

test("来源或项目清单在预览后变化都会要求重新审阅", async (t) => {
  const { root, projectsDirectory, manifestPath } = await fixture(t);
  const project = (await loadProjectManifests(projectsDirectory)).get(
    "memory_settings_project",
  );
  const settings = requestedSettings();
  const sourcePreview = await previewProjectMemorySettings({ project, settings, now });
  await writeFile(join(root, "docs", "decisions.md"), "# Decisions\nChanged.\n");
  await assert.rejects(
    () => applyProjectMemorySettings({
      projectId: project.projectId,
      settings,
      digest: sourcePreview.digest,
      confirmation: sourcePreview.confirmation,
      projectsDirectory,
      now,
    }),
    /review the current preview again/u,
  );

  const currentProject = (await loadProjectManifests(projectsDirectory)).get(project.projectId);
  const manifestPreview = await previewProjectMemorySettings({
    project: currentProject,
    settings,
    now,
  });
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  raw.name = "Changed by another writer";
  await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
  await assert.rejects(
    () => applyProjectMemorySettings({
      projectId: project.projectId,
      settings,
      digest: manifestPreview.digest,
      confirmation: manifestPreview.confirmation,
      projectsDirectory,
      now,
    }),
    /review the current preview again/u,
  );
});

test("自动确认必须显式选择、限期且仍受全局能力门禁", async (t) => {
  const { projectsDirectory } = await fixture(t);
  const project = (await loadProjectManifests(projectsDirectory)).get(
    "memory_settings_project",
  );
  const automatic = requestedSettings({ mode: "automatic", autoConfirm: true });
  const preview = await previewProjectMemorySettings({
    project,
    settings: automatic,
    globalCapabilities: new Set(["project_memory_proposal"]),
    now,
  });
  assert.equal(preview.effectiveAutomaticSync, true);
  assert.equal(preview.effectiveAutomaticConfirmation, true);
  assert.equal(preview.changes.authorizationExpansion, true);
  await assert.rejects(
    () => previewProjectMemorySettings({
      project,
      settings: requestedSettings({ expiresAt: "2028-01-01T00:00:00.000Z" }),
      now,
    }),
    /next 365 days/u,
  );
  await assert.rejects(
    () => previewProjectMemorySettings({
      project,
      settings: requestedSettings({ mode: "approval_required", autoConfirm: true }),
      now,
    }),
    /requires automatic mode/u,
  );
});

test("来源路径中的符号链接和超出项目记忆范围的保留期会失败关闭", async (t) => {
  const { root, projectsDirectory } = await fixture(t);
  const project = (await loadProjectManifests(projectsDirectory)).get(
    "memory_settings_project",
  );
  await symlink(join(root, "docs"), join(root, "linked-docs"));
  await assert.rejects(
    () => previewProjectMemorySettings({
      project,
      settings: requestedSettings({ sourcePaths: ["linked-docs/decisions.md"] }),
      now,
    }),
    /must not traverse a symbolic link/u,
  );
  await assert.rejects(
    () => previewProjectMemorySettings({
      project,
      settings: requestedSettings({ maxRetentionDays: 181 }),
      now,
    }),
    /fit the project memory retention scope/u,
  );
});

test("关闭授权不读取来源并保留其他项目能力", async (t) => {
  const { projectsDirectory } = await fixture(t);
  const project = (await loadProjectManifests(projectsDirectory)).get(
    "memory_settings_project",
  );
  const settings = { mode: "disabled" };
  const preview = await previewProjectMemorySettings({ project, settings, now });
  assert.equal(preview.sources.length, 0);
  assert.equal(preview.proposed.mode, "disabled");
  const result = await applyProjectMemorySettings({
    projectId: project.projectId,
    settings,
    digest: preview.digest,
    confirmation: preview.confirmation,
    projectsDirectory,
    now,
  });
  assert.equal(result.settings.mode, "disabled");
  const updated = (await loadProjectManifests(projectsDirectory)).get(project.projectId);
  assert.equal(updated.capabilities.project_memory_proposal.mode, "disabled");
  assert.equal(updated.capabilities.research.mode, "automatic");
});
