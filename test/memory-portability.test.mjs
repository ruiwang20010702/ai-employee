import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createMemoryExport,
  memoryDeletionConfirmation,
  validateMemoryExportMode,
  writeMemoryExport,
} from "../src/memory-portability.mjs";

const memory = {
  id: "memory_example",
  type: "project",
  project_id: "project_1",
  status: "confirmed",
  sensitivity: "internal",
  confidence: 1,
  source_type: "document",
  source_version: "2",
  valid_from: "2026-08-05T00:00:00.000Z",
  expires_at: null,
  supersedes_id: null,
  created_at: "2026-08-04T00:00:00.000Z",
  updated_at: "2026-08-05T00:00:00.000Z",
  subject: "发布口径",
  statement: "上线前需要复核。",
  source_id: "doc-1",
  scope: { factKey: "release-rule" },
  created_by: "owner",
  updated_by: "owner",
  deleted_at: null,
};

test("记忆删除确认值稳定绑定具体记忆编号", () => {
  const first = memoryDeletionConfirmation("memory_one");
  assert.match(first, /^DELETE-[A-F0-9]{8}$/u);
  assert.equal(first, memoryDeletionConfirmation("memory_one"));
  assert.notEqual(first, memoryDeletionConfirmation("memory_two"));
});

test("记忆导出默认不包含正文，完整导出必须显式选择", () => {
  assert.equal(validateMemoryExportMode("metadata"), false);
  assert.throws(
    () => validateMemoryExportMode("content"),
    /EXPORT-CONTENT/u,
  );
  assert.equal(validateMemoryExportMode("content", "EXPORT-CONTENT"), true);
  const metadata = createMemoryExport([memory], {
    projectId: "project_1",
    exportedAt: "2026-08-05T01:00:00.000Z",
  });
  assert.equal(metadata.contentIncluded, false);
  assert.equal(metadata.items[0].statement, undefined);
  assert.equal(metadata.items[0].sourceId, undefined);
  const content = createMemoryExport([memory], {
    projectId: "project_1",
    includeContent: true,
    exportedAt: "2026-08-05T01:00:00.000Z",
  });
  assert.equal(content.items[0].statement, "上线前需要复核。");
  assert.throws(
    () => createMemoryExport([memory], { projectId: "other" }),
    /outside the requested project/u,
  );
  assert.throws(
    () => createMemoryExport(Array.from({ length: 10_001 }, () => memory)),
    /at most 10000 items/u,
  );
});

test("记忆导出文件使用 600 权限且不覆盖已有文件", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-memory-export-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "memory-export.json");
  const payload = createMemoryExport([memory]);
  await writeMemoryExport(path, payload);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, "utf8")).itemCount, 1);
  await assert.rejects(writeMemoryExport(path, payload), { code: "EEXIST" });
  await assert.rejects(
    writeMemoryExport(join(directory, "memory.txt"), payload),
    /absolute .json/u,
  );
});
