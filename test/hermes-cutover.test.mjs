import assert from "node:assert/strict";
import test from "node:test";
import {
  assertHermesShadowReady,
  assertHermesShadowAcceptance,
  assertLegacyCutoverReady,
  executeHermesCutover,
  hermesCutoverConfirmation,
} from "../src/hermes-cutover.mjs";

const drainedLegacy = {
  database: true,
  paused: false,
  pendingMessages: 0,
  expiredExecutionLeases: 0,
  tasks: { completed: 3, cancelled_manual: 1 },
  workPlans: { completed: 1, cancelled: 1 },
};

const healthyShadow = {
  mode: "shadow",
  running: true,
  sendEnabled: false,
  checkpointHealthy: true,
};

test("Hermes 切换前拒绝任何活动任务、未知发送或活动计划", () => {
  assert.deepEqual(assertLegacyCutoverReady(drainedLegacy), {
    ready: true,
    activeTasks: 0,
    activeWorkPlans: 0,
  });
  for (const patch of [
    { pendingMessages: 1 },
    { tasks: { ...drainedLegacy.tasks, queued: 1 } },
    { tasks: { ...drainedLegacy.tasks, send_unknown: 1 } },
    { workPlans: { approved: 1 } },
    { workPlans: { failed: 1 } },
    { expiredExecutionLeases: 1 },
  ]) assert.throws(
    () => assertLegacyCutoverReady({ ...drainedLegacy, ...patch }),
    /cutover|block/u,
  );
  assert.deepEqual(assertHermesShadowReady(healthyShadow), { ready: true });
  assert.throws(
    () => assertHermesShadowReady({ ...healthyShadow, sendEnabled: true }),
    /not ready/u,
  );
});

test("Hermes active 只在旧写入者全部停止后启动并写回执", async () => {
  const events = [];
  const result = await executeHermesCutover({
    async inspectLegacy() { events.push("inspect-legacy"); return drainedLegacy; },
    async inspectShadow() { events.push("inspect-shadow"); return healthyShadow; },
    async stopLegacyWriters() {
      events.push("stop-legacy");
      return { states: {
        listener: "stopped",
        worker: "stopped",
        executor: "stopped",
        proactive: "stopped",
      } };
    },
    async startActiveHermes() { events.push("start-active"); },
    async inspectActive() {
      events.push("inspect-active");
      return { mode: "active", running: true, sendEnabled: true, checkpointHealthy: true };
    },
    async stopHermes() { events.push("stop-hermes"); },
    async restoreLegacyWriters() { events.push("restore-legacy"); },
    async verifyLegacyRestored() { events.push("verify-legacy"); return true; },
    async writeReceipt() { events.push("receipt"); return { id: "cutover-1" }; },
  });
  assert.equal(result.activated, true);
  assert.deepEqual(events, [
    "inspect-legacy",
    "inspect-shadow",
    "stop-legacy",
    "start-active",
    "inspect-active",
    "receipt",
  ]);
});

test("Hermes active 验证失败时先停 Hermes 再恢复旧写入者", async () => {
  const events = [];
  await assert.rejects(
    executeHermesCutover({
      async inspectLegacy() { return drainedLegacy; },
      async inspectShadow() { return healthyShadow; },
      async stopLegacyWriters() {
        events.push("stop-legacy");
        return { states: {
          listener: "stopped",
          worker: "stopped",
          executor: "stopped",
          proactive: "stopped",
        } };
      },
      async startActiveHermes() { events.push("start-active"); },
      async inspectActive() {
        events.push("inspect-active");
        return { mode: "active", running: false, sendEnabled: true, checkpointHealthy: false };
      },
      async stopHermes() { events.push("stop-hermes"); },
      async restoreLegacyWriters() { events.push("restore-legacy"); },
      async verifyLegacyRestored() { events.push("verify-legacy"); return true; },
      async writeReceipt() { events.push("receipt"); },
    }),
    (error) => error.code === "hermes_cutover_rolled_back" && error.rollbackComplete === true,
  );
  assert.deepEqual(events, [
    "stop-legacy",
    "start-active",
    "inspect-active",
    "stop-hermes",
    "restore-legacy",
    "verify-legacy",
  ]);
});

test("旧服务尚未开始停止时的失败不能误停健康 shadow", async () => {
  const events = [];
  await assert.rejects(
    executeHermesCutover({
      async inspectLegacy() { return drainedLegacy; },
      async inspectShadow() { return healthyShadow; },
      async stopLegacyWriters() { throw new Error("snapshot failed"); },
      async startActiveHermes() { events.push("start-active"); },
      async inspectActive() { events.push("inspect-active"); },
      async stopHermes() { events.push("stop-hermes"); },
      async restoreLegacyWriters() { events.push("restore-legacy"); },
      async verifyLegacyRestored() { events.push("verify-legacy"); return true; },
      async writeReceipt() { events.push("receipt"); },
    }),
    (error) => error.code === "hermes_cutover_rolled_back",
  );
  assert.deepEqual(events, ["verify-legacy"]);
});

test("旧服务部分停止时恢复旧服务但不能误停 shadow", async () => {
  const events = [];
  await assert.rejects(
    executeHermesCutover({
      async inspectLegacy() { return drainedLegacy; },
      async inspectShadow() { return healthyShadow; },
      async stopLegacyWriters() {
        events.push("stop-legacy");
        return { states: {
          listener: "stopped",
          worker: "running",
          executor: "stopped",
          proactive: "stopped",
        } };
      },
      async startActiveHermes() { events.push("start-active"); },
      async inspectActive() { events.push("inspect-active"); },
      async stopHermes() { events.push("stop-hermes"); },
      async restoreLegacyWriters() { events.push("restore-legacy"); },
      async verifyLegacyRestored() { events.push("verify-legacy"); return true; },
      async writeReceipt() { events.push("receipt"); },
    }),
    (error) => error.code === "hermes_cutover_rolled_back",
  );
  assert.deepEqual(events, ["stop-legacy", "restore-legacy", "verify-legacy"]);
});

test("Hermes active 必须绑定十项真实 shadow 证据和精确提交", () => {
  const releaseSha = "a".repeat(40);
  const evidenceDigest = "b".repeat(64);
  const scenarios = Object.fromEntries([
    "allowlistedMessage",
    "projectRoute",
    "personalMemory",
    "naturalReply",
    "followup",
    "codeWork",
    "humanTakeover",
    "restartRecovery",
    "sendDisabled",
    "noDuplicate",
  ].map((name) => [name, true]));
  const receipt = {
    schema: "foursday-hermes-shadow-acceptance/v1",
    releaseSha,
    evidenceDigest,
    createdAt: "2026-08-18T12:00:00.000Z",
    scenarios,
  };
  assert.equal(assertHermesShadowAcceptance(receipt, {
    releaseSha,
    now: new Date("2026-08-19T12:00:00.000Z"),
  }).scenarioCount, 10);
  assert.equal(
    hermesCutoverConfirmation({ releaseSha, evidenceDigest }),
    `ACTIVATE-HERMES:${releaseSha}:${"b".repeat(16)}`,
  );
  assert.throws(
    () => assertHermesShadowAcceptance({
      ...receipt,
      scenarios: { ...scenarios, codeWork: false },
    }, { releaseSha, now: new Date("2026-08-19T12:00:00.000Z") }),
    /incomplete/u,
  );
  assert.throws(
    () => assertHermesShadowAcceptance(receipt, {
      releaseSha: "c".repeat(40),
      now: new Date("2026-08-19T12:00:00.000Z"),
    }),
    /invalid/u,
  );
  assert.throws(
    () => assertHermesShadowAcceptance(receipt, {
      releaseSha,
      now: new Date("2026-09-01T12:00:00.000Z"),
    }),
    /stale/u,
  );
});
