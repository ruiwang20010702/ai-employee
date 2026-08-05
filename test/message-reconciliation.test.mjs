import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeMessageCoverage,
  reconcileMessageCoverage,
} from "../src/message-reconciliation.mjs";

function message(id, createTime) {
  return {
    id,
    senderUserId: "user-1",
    senderName: "测试用户",
    conversationId: "conversation-1",
    createTime,
    content: "仅用于测试",
  };
}

test("独立消息对账发现漏项、回补并只保存脱敏汇总", async () => {
  const known = new Set(["m1"]);
  const checkpoints = new Map();
  const store = {
    async knownMessageIds(ids) {
      return new Set(ids.filter((id) => known.has(id)));
    },
    async ingestMessages(messages) {
      for (const item of messages) known.add(item.id);
      return messages.length;
    },
    async setCheckpoint(key, value) {
      checkpoints.set(key, value);
    },
  };
  const dws = {
    async fetchBySender() {
      return [
        message("m1", "2026-08-05T00:00:00Z"),
        message("m2", "2026-08-05T00:01:00Z"),
      ];
    },
    async fetchGroupMentions() {
      return [message("m2", "2026-08-05T00:01:00Z")];
    },
  };
  const report = await reconcileMessageCoverage({
    config: {
      targetUserIds: ["user-1"],
      targetGroupIds: ["group-1"],
      reconciliationWindowMs: 86_400_000,
      reconciliationGraceMs: 120_000,
      reconciliationLimit: 10_000,
    },
    store,
    dws,
    now: new Date("2026-08-06T00:02:00Z"),
  });
  assert.deepEqual(
    {
      sourceMessages: report.sourceMessages,
      missedBeforeRepair: report.missedBeforeRepair,
      repairedMessages: report.repairedMessages,
      remainingMissing: report.remainingMissing,
      observedMissRate: report.observedMissRate,
      finalMissRate: report.finalMissRate,
    },
    {
      sourceMessages: 2,
      missedBeforeRepair: 1,
      repairedMessages: 1,
      remainingMissing: 0,
      observedMissRate: 0.5,
      finalMissRate: 0,
    },
  );
  const saved = [...checkpoints.values()].join("\n");
  assert.doesNotMatch(saved, /仅用于测试|conversation-1|user-1/u);
});

test("对账窗口被截断或没有样本时不伪造达标结论", () => {
  assert.equal(normalizeMessageCoverage({
    checkedAt: "2026-08-06T00:00:00Z",
    windowStart: "2026-08-05T00:00:00Z",
    windowEnd: "2026-08-06T00:00:00Z",
    dataComplete: false,
    sourceMessages: 10,
    missedBeforeRepair: 0,
    repairedMessages: 0,
    remainingMissing: 0,
  }).targetMet, null);
  assert.equal(normalizeMessageCoverage({
    checkedAt: "2026-08-06T00:00:00Z",
    windowStart: "2026-08-05T00:00:00Z",
    windowEnd: "2026-08-06T00:00:00Z",
    dataComplete: true,
    sourceMessages: 0,
    missedBeforeRepair: 0,
    repairedMessages: 0,
    remainingMissing: 0,
  }).targetMet, null);
});

test("DWS 对账读取失败只记录稳定失败分类", async () => {
  const checkpoints = new Map();
  await assert.rejects(reconcileMessageCoverage({
    config: {
      targetUserIds: ["user-1"],
      targetGroupIds: [],
      reconciliationWindowMs: 86_400_000,
      reconciliationGraceMs: 120_000,
      reconciliationLimit: 10_000,
    },
    store: {
      async setCheckpoint(key, value) { checkpoints.set(key, value); },
    },
    dws: {
      async fetchBySender() { throw new Error("sensitive upstream details"); },
    },
    now: new Date("2026-08-06T00:02:00Z"),
  }), /sensitive upstream details/u);
  assert.deepEqual([...checkpoints.values()], ["source_read_failed"]);
});
