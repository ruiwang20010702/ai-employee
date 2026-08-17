import assert from "node:assert/strict";
import test from "node:test";
import {
  mobileApprovalCode,
  mobileApprovalNotification,
  notifyPendingMobileApprovals,
  parseMobileApprovalCommand,
  processMobileApprovalCommands,
} from "../src/mobile-approval.mjs";

function approvalTask(overrides = {}) {
  return {
    id: "reply_approval_1",
    status: "awaiting_approval",
    approval_version: 1,
    draft_ready_at: "2026-08-17T10:00:00.000Z",
    updated_at: "2026-08-17T10:00:00.000Z",
    payload: { content: "请确认明天是否可以上线。" },
    result: { reply: "可以，明天按计划上线。", riskLevel: "medium" },
    ...overrides,
  };
}

function config() {
  return {
    mobileApprovalEnabled: true,
    selfUserId: "owner",
    draftApprovalTtlMs: 7_200_000,
  };
}

test("移动审批短码绑定任务版本和完整草稿哈希", () => {
  const task = approvalTask();
  assert.match(mobileApprovalCode(task), /^[0-9A-F]{8}$/u);
  assert.notEqual(
    mobileApprovalCode(task),
    mobileApprovalCode(approvalTask({ result: { ...task.result, reply: "草稿已改变" } })),
  );
  assert.notEqual(
    mobileApprovalCode(task),
    mobileApprovalCode(approvalTask({ approval_version: 2 })),
  );
  assert.deepEqual(parseMobileApprovalCommand(`批准 ${mobileApprovalCode(task)}`), {
    decision: "approved",
    code: mobileApprovalCode(task),
  });
  assert.equal(parseMobileApprovalCommand(`请批准 ${mobileApprovalCode(task)}`), null);
  assert.equal(parseMobileApprovalCommand("批准 1234"), null);
});

test("待审批草稿只在明确成功回执后记录一次通知", async () => {
  const checkpoints = new Map();
  const task = approvalTask();
  const sends = [];
  const store = {
    async listTasks() { return [task]; },
    async getCheckpoint(key) { return checkpoints.get(key) ?? null; },
    async setCheckpoint(key, value) { checkpoints.set(key, value); },
  };
  const dws = {
    async sendMobileApproval(input) {
      sends.push(input);
      return { success: true };
    },
    async verifySendReceipt(receipt) { assert.equal(receipt.success, true); },
  };
  const now = new Date("2026-08-17T10:30:00.000Z");
  assert.equal((await notifyPendingMobileApprovals({ store, dws, config: config(), now })).sent, 1);
  assert.equal((await notifyPendingMobileApprovals({ store, dws, config: config(), now })).sent, 0);
  assert.equal(sends.length, 1);
  const notice = mobileApprovalNotification(task, {
    expiresAt: new Date("2026-08-17T12:00:00.000Z"),
  });
  assert.match(sends[0].text, new RegExp(`批准 ${notice.code}`, "u"));
  assert.match(sends[0].text, new RegExp(`拒绝 ${notice.code}`, "u"));
});

test("失败的移动通知不写成功检查点并可安全重试", async () => {
  const checkpoints = new Map();
  const store = {
    async listTasks() { return [approvalTask()]; },
    async getCheckpoint(key) { return checkpoints.get(key) ?? null; },
    async setCheckpoint(key, value) { checkpoints.set(key, value); },
  };
  const dws = {
    async sendMobileApproval() { return {}; },
    async verifySendReceipt() { throw new Error("unknown receipt"); },
  };
  await assert.rejects(
    notifyPendingMobileApprovals({
      store, dws, config: config(), now: new Date("2026-08-17T10:30:00Z"),
    }),
    /unknown receipt/u,
  );
  assert.equal(checkpoints.size, 0);
});

test("本人移动指令只批准仍匹配的单个草稿且重放无效", async () => {
  const checkpoints = new Map();
  const task = approvalTask();
  checkpoints.set("mobile-approval:commands:last-success", "2026-08-17T10:00:00.000Z");
  let pending = [task];
  const decisions = [];
  const store = {
    async getCheckpoint(key) { return checkpoints.get(key) ?? null; },
    async setCheckpoint(key, value) { checkpoints.set(key, value); },
    async listTasks() { return pending; },
    async decideTask(id, decision) {
      decisions.push({ id, decision });
      pending = [];
    },
  };
  const dws = {
    async fetchMobileApprovalMessages() {
      return [{ id: "message-1", approvalOwnerVerified: true, content: `批准 ${mobileApprovalCode(task)}` }];
    },
  };
  const now = new Date("2026-08-17T10:30:00.000Z");
  assert.equal((await processMobileApprovalCommands({ store, dws, config: config(), now })).decided, 1);
  assert.equal(decisions[0].decision.decision, "approved");
  assert.match(decisions[0].decision.expectedDraftSha256, /^[a-f0-9]{64}$/u);
  assert.equal((await processMobileApprovalCommands({ store, dws, config: config(), now })).decided, 0);
  assert.equal(decisions.length, 1);
});

test("首次启用只建立检查点且旧指令或变化草稿不会被消费", async () => {
  const checkpoints = new Map();
  const oldTask = approvalTask();
  let fetches = 0;
  const store = {
    async getCheckpoint(key) { return checkpoints.get(key) ?? null; },
    async setCheckpoint(key, value) { checkpoints.set(key, value); },
    async listTasks() {
      return [approvalTask({ result: { ...oldTask.result, reply: "新草稿" } })];
    },
    async decideTask() { assert.fail("变化草稿不得批准"); },
  };
  const dws = {
    async fetchMobileApprovalMessages() {
      fetches += 1;
      return [{ approvalOwnerVerified: true, content: `批准 ${mobileApprovalCode(oldTask)}` }];
    },
  };
  const now = new Date("2026-08-17T10:30:00Z");
  const first = await processMobileApprovalCommands({ store, dws, config: config(), now });
  assert.equal(first.bootstrapped, true);
  assert.equal(fetches, 0);
  const second = await processMobileApprovalCommands({ store, dws, config: config(), now });
  assert.equal(second.decided, 0);
  assert.equal(fetches, 1);
});
