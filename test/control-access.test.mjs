import assert from "node:assert/strict";
import test from "node:test";
import { controlStoreOptions } from "../src/control-access.mjs";

test("质量报告使用数据库强制只读会话", () => {
  assert.deepEqual(controlStoreOptions("review-report"), { readOnly: true });
});

test("会修改状态的控制命令不伪装成只读", () => {
  for (const command of ["approve", "retry", "pause", "review-label"]) {
    assert.deepEqual(controlStoreOptions(command), { readOnly: false });
  }
});
