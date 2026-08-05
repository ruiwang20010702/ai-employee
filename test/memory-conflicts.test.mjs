import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeMemoryConflicts } from "../src/memory-conflicts.mjs";

test("正式记忆区分重复候选、冲突候选和历史多重冲突", () => {
  const report = analyzeMemoryConflicts([
    { id: "old", type: "project", project_id: "p", subject_key: "s", scope: { factKey: "release-rule" }, statement: "旧口径", status: "confirmed" },
    { id: "duplicate", type: "project", project_id: "p", subject_key: "s", scope: { factKey: "release-rule" }, statement: "旧口径", status: "proposed" },
    { id: "replacement", type: "project", project_id: "p", subject_key: "s", scope: { factKey: "release-rule" }, statement: "新口径", status: "proposed" },
    { id: "other", type: "project", project_id: "p", subject_key: "x", statement: "其他", status: "confirmed" },
  ]);
  assert.equal(report.candidates, 2);
  assert.equal(report.conflictCandidates, 1);
  assert.equal(report.duplicateCandidates, 1);
  assert.equal(report.conflictRate, 0.5);
  assert.deepEqual(report.items.find((item) => item.memoryId === "replacement").conflictIds, ["old"]);
  assert.equal(report.healthy, true);
});
