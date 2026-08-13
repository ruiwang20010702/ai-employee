import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
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
import {
  buildHistoricalProjectImportPreview,
  historicalMemoryProposals,
  loadHistoricalProjectSourceContents,
} from "../src/historical-project-import.mjs";
import {
  applyHistoricalProjectImport,
  previewHistoricalProjectImport,
} from "../src/historical-project-import-service.mjs";
import { Store } from "../src/store.mjs";

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "foursday-history-import-"));
  const root = await realpath(temporary);
  await execFileAsync("/usr/bin/git", ["init", "--quiet", root], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  await mkdir(join(root, "docs"));
  await writeFile(
    join(root, "docs", "history.md"),
    [
      "# 项目历史",
      "项目目标是每周返还一个完整工作日。",
      "发布前必须完成目标系统回读。",
      "数据库密码是 do-not-import。",
      "联系人手机号是 13800138000。",
    ].join("\n"),
  );
  const bundle = {
    schema: "foursday-historical-project-import/v1",
    project: {
      projectId: "legacy_project",
      name: "历史项目",
      rootDirectory: root,
      requesterIds: ["owner-1"],
      profile: {
        objective: "恢复可复用的历史项目上下文",
        successCriteria: ["历史决策可追溯"],
        milestones: ["完成首次导入"],
        collaborationObjects: ["repository"],
        selectedRecipeIds: ["project-follow-up"],
        memoryScope: { allowedTypes: ["project", "principle"], retentionDays: 180 },
      },
    },
    sources: [{ id: "history", path: "docs/history.md" }],
    memories: [
      {
        type: "project",
        statement: "项目目标是每周返还一个完整工作日。",
        factKey: "project.objective",
        sourceId: "history",
        sourceQuote: "项目目标是每周返还一个完整工作日。",
        sensitivity: "internal",
        confidence: 1,
      },
      {
        type: "principle",
        statement: "发布前必须完成目标系统回读。",
        factKey: "delivery.readback_rule",
        sourceId: "history",
        sourceQuote: "发布前必须完成目标系统回读。",
        retentionDays: 90,
      },
    ],
  };
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, bundle };
}

test("历史项目导入默认只生成来源绑定预览", async (t) => {
  const { root, bundle } = await fixture(t);
  const preview = await buildHistoricalProjectImportPreview(bundle);
  assert.equal(preview.projectAction, "create");
  assert.equal(preview.manifest.rootDirectory, root);
  assert.equal(preview.counts.sources, 1);
  assert.equal(preview.counts.candidates, 2);
  assert.equal(preview.confirmation, `IMPORT-${preview.digest.slice(0, 12).toUpperCase()}`);
  assert.equal(preview.databaseWrite, false);
  assert.equal(preview.memoriesConfirmed, 0);
  assert.equal(preview.candidates[0].source.path, "docs/history.md");
  assert.match(preview.candidates[0].source.sha256, /^[a-f0-9]{64}$/u);
  const proposals = historicalMemoryProposals(preview, {
    now: new Date("2026-08-13T00:00:00.000Z"),
    actor: "owner-1",
  });
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].sourceType, "historical_project_import");
  assert.equal(proposals[0].sourceId, preview.sources[0].sha256);
  assert.equal(proposals[0].scope.sourceQuoteSha256.length, 64);
});

test("projects:import 命令默认只读且不创建项目目录", async (t) => {
  const { root, bundle } = await fixture(t);
  const bundlePath = join(root, "history-import.json");
  const projectsDirectory = join(root, "isolated-projects");
  await writeFile(bundlePath, `${JSON.stringify(bundle)}\n`, { mode: 0o600 });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/导入历史项目.mjs",
    "--bundle",
    bundlePath,
  ], {
    cwd: new URL("../", import.meta.url),
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      AI_EMPLOYEE_PROJECTS_DIRECTORY: projectsDirectory,
    },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.databaseWrite, false);
  assert.equal(result.existingStateChecked, false);
  await assert.rejects(() => lstat(projectsDirectory));
});

test("历史项目导入跳过无来源引文、凭据和人员敏感材料", async (t) => {
  const { bundle } = await fixture(t);
  bundle.memories.push(
    {
      type: "project",
      statement: "不存在的旧决定。",
      factKey: "decision.missing",
      sourceId: "history",
      sourceQuote: "源文件里不存在这句话。",
    },
    {
      type: "project",
      statement: "数据库密码是 do-not-import。",
      factKey: "system.credential",
      sourceId: "history",
      sourceQuote: "数据库密码是 do-not-import。",
    },
    {
      type: "project",
      statement: "联系人手机号是 13800138000。",
      factKey: "contact.phone",
      sourceId: "history",
      sourceQuote: "联系人手机号是 13800138000。",
    },
  );
  const preview = await buildHistoricalProjectImportPreview(bundle);
  assert.equal(preview.counts.candidates, 2);
  assert.equal(preview.counts.skipped, 3);
  assert.deepEqual(preview.skipped.map((item) => item.reasons[0]), [
    "source_quote_not_found",
    "credential_material",
    "sensitive_person_material",
  ]);
});

test("历史项目导入拒绝越界路径和任一级符号链接", async (t) => {
  const { root, bundle } = await fixture(t);
  const traversal = structuredClone(bundle);
  traversal.sources[0].path = "../outside.md";
  await assert.rejects(
    () => buildHistoricalProjectImportPreview(traversal),
    /normalized relative path|outside the project root/u,
  );

  await mkdir(join(root, "outside"));
  await writeFile(join(root, "outside", "source.md"), "项目目标是每周返还一个完整工作日。\n");
  await symlink(join(root, "outside"), join(root, "linked"));
  const linked = structuredClone(bundle);
  linked.sources[0].path = "linked/source.md";
  await assert.rejects(
    () => buildHistoricalProjectImportPreview(linked),
    /must not traverse a symbolic link/u,
  );
});

test("来源在安全读取期间变化时不会进入模型材料", async (t) => {
  const { root, bundle } = await fixture(t);
  await assert.rejects(
    () => loadHistoricalProjectSourceContents({
      rootDirectory: root,
      sources: bundle.sources,
      readFileFn: async (path) => {
        const content = await readFile(path);
        await writeFile(path, "# replaced while reading\n");
        return content;
      },
    }),
    /changed while it was being read/u,
  );
});

test("显式确认后创建项目与候选，但不会自动确认", async (t) => {
  const { root, bundle } = await fixture(t);
  const projectsDirectory = join(root, ".runtime", "projects");
  const store = await new Store(join(root, ".runtime", "import.sqlite")).open();
  t.after(() => store.close());
  const preview = await previewHistoricalProjectImport({
    bundle,
    projectsDirectory,
    store,
    now: new Date("2026-08-13T00:00:00.000Z"),
  });
  await assert.rejects(
    () => applyHistoricalProjectImport({
      bundle,
      projectsDirectory,
      store,
      confirmation: "IMPORT-WRONG",
      actor: "owner-1",
      now: new Date("2026-08-13T00:00:00.000Z"),
    }),
    /confirmation does not match/u,
  );
  await assert.rejects(() => lstat(join(projectsDirectory, "legacy_project.json")));

  const result = await applyHistoricalProjectImport({
    bundle,
    projectsDirectory,
    store,
    confirmation: preview.confirmation,
    actor: "owner-1",
    now: new Date("2026-08-13T00:00:00.000Z"),
  });
  assert.equal(result.manifestCreated, true);
  assert.equal(result.candidatesCreated, 2);
  assert.equal(result.memoriesConfirmed, 0);
  assert.equal(result.externalSystemsTouched, false);
  const manifest = JSON.parse(await readFile(
    join(projectsDirectory, "legacy_project.json"),
    "utf8",
  ));
  assert.equal(manifest.projectId, "legacy_project");
  const proposed = store.listMemories({ projectId: "legacy_project", status: "proposed" });
  assert.equal(proposed.length, 2);
  assert.equal(proposed.every((memory) => memory.source_type === "historical_project_import"), true);
  assert.equal(store.searchMemories({ projectId: "legacy_project" }).length, 0);
  store.confirmMemory(proposed[0].id, "owner-1", new Date("2026-08-13T00:01:00.000Z"));
  assert.equal(store.searchMemories({ projectId: "legacy_project" }).length, 1);
});

test("历史候选重复导入幂等，冲突只进入待确认", async (t) => {
  const { root, bundle } = await fixture(t);
  const store = await new Store(join(root, "memory.sqlite")).open();
  t.after(() => store.close());
  const preview = await buildHistoricalProjectImportPreview(bundle, {
    now: new Date("2026-08-13T00:00:00.000Z"),
  });
  const proposals = historicalMemoryProposals(preview, {
    now: new Date("2026-08-13T00:00:00.000Z"),
    actor: "owner-1",
  });
  const first = store.proposeHistoricalProjectMemories(
    proposals,
    new Date("2026-08-13T00:00:00.000Z"),
  );
  assert.equal(first.every((item) => item.created), true);
  const repeated = store.proposeHistoricalProjectMemories(
    proposals,
    new Date("2026-08-13T00:00:01.000Z"),
  );
  assert.equal(repeated.every((item) => item.reason === "duplicate"), true);

  store.confirmMemory(first[0].id, "owner-1", new Date("2026-08-13T00:01:00.000Z"));
  const changed = {
    ...proposals[0],
    statement: "项目目标调整为每周返还两个工作日。",
    scope: { ...proposals[0].scope, importDigest: "b".repeat(64) },
  };
  const [conflict] = store.proposeHistoricalProjectMemories(
    [changed],
    new Date("2026-08-13T00:02:00.000Z"),
  );
  assert.equal(conflict.created, true);
  assert.equal(conflict.conflictCount, 1);
  assert.equal(store.getMemory(conflict.id).status, "proposed");
});

test("历史候选存储层拒绝越界来源和凭据且整批不落库", async (t) => {
  const { root, bundle } = await fixture(t);
  const store = await new Store(join(root, "defense.sqlite")).open();
  t.after(() => store.close());
  const preview = await buildHistoricalProjectImportPreview(bundle, {
    now: new Date("2026-08-13T00:00:00.000Z"),
  });
  const proposals = historicalMemoryProposals(preview, {
    now: new Date("2026-08-13T00:00:00.000Z"),
    actor: "owner-1",
  });
  await assert.rejects(
    async () => store.proposeHistoricalProjectMemories([
      proposals[0],
      {
        ...proposals[1],
        statement: "API key abcdef123456",
        scope: { ...proposals[1].scope, sourcePath: "../secret.md" },
      },
    ], new Date("2026-08-13T00:00:00.000Z")),
    /source binding is invalid|restricted material/u,
  );
  assert.equal(store.listMemories({ projectId: "legacy_project" }).length, 0);
});
