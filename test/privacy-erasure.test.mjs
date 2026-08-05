import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrivacyErasurePreview,
  jsonContainsAny,
  validatePrivacySelector,
} from "../src/privacy-erasure.mjs";

test("隐私擦除选择器只接受单一明确范围", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");
  assert.deepEqual(validatePrivacySelector({ personId: " user-1 " }, now), {
    type: "person",
    value: "user-1",
  });
  assert.deepEqual(validatePrivacySelector({ projectId: "project-1" }, now), {
    type: "project",
    value: "project-1",
  });
  assert.equal(
    validatePrivacySelector({ before: "2026-08-01T00:00:00.000Z" }, now).value.toISOString(),
    "2026-08-01T00:00:00.000Z",
  );
  assert.throws(
    () => validatePrivacySelector({ personId: "u", projectId: "p" }, now),
    /exactly one/u,
  );
  assert.throws(
    () => validatePrivacySelector({ before: "2026-08-05T12:00:01.000Z" }, now),
    /past/u,
  );
  assert.throws(
    () => validatePrivacySelector({ before: "2026-08-01" }, now),
    /ISO 8601/u,
  );
});

test("确认值绑定选择器和完整数据快照且阻塞时不生成", () => {
  const input = {
    selector: { type: "person", value: "hidden" },
    selectorFingerprint: "selector-fingerprint",
    eligible: { tasks: ["task:completed:1"], messages: ["message:bundled:1"] },
    blocked: { tasks: [], workPlans: [] },
  };
  const preview = buildPrivacyErasurePreview(input);
  assert.match(preview.confirmation, /^ERASE-[A-F0-9]{16}$/u);
  assert.equal(JSON.stringify(preview).includes("hidden"), false);
  assert.notEqual(
    buildPrivacyErasurePreview({
      ...input,
      eligible: { ...input.eligible, tasks: ["task:completed:2"] },
    }).confirmation,
    preview.confirmation,
  );
  assert.equal(buildPrivacyErasurePreview({
    ...input,
    blocked: { tasks: ["active"], workPlans: [] },
  }).confirmation, null);
});

test("审计详情匹配支持嵌套对象且不匹配键名", () => {
  const values = new Set(["project-1", "task-1"]);
  assert.equal(jsonContainsAny({ nested: [{ projectId: "project-1" }] }, values), true);
  assert.equal(jsonContainsAny({ task: "task-2" }, values), false);
  assert.equal(jsonContainsAny({ "project-1": "unrelated" }, values), false);
});
