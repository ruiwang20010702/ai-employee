import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSidecarRuntime } from "../src/hermes-dws-sidecar.mjs";

class FakeDws {
  constructor() {
    this.sent = [];
    this.directCalls = 0;
    this.manualReply = false;
    this.withdrawn = false;
    this.receiptWithoutMessageId = false;
    this.readBackMessage = null;
  }

  async fetchBySender({ senderUserId }) {
    this.directCalls += 1;
    return [{
      id: "dws-1",
      senderUserId,
      senderOpenDingTalkId: "open-trusted",
      senderName: "娜娜老师",
      conversationId: "conversation-1",
      content: "2.2目前生产了多少试题？",
      createTime: "2026-08-18T14:00:00+08:00",
      isSelf: false,
      isWithdrawn: this.withdrawn,
      withdrawnAt: this.withdrawn ? "2026-08-18T14:00:30+08:00" : null,
    }];
  }

  async fetchGroupMentions() {
    return [];
  }

  async sendMessage(input) {
    this.sent.push(input);
    return this.receiptWithoutMessageId
      ? { status: "SENT" }
      : { status: "SENT", messageId: "server-message-1" };
  }

  verifySendReceipt(receipt) {
    assert.equal(receipt.status, "SENT");
  }

  async hasManualReply(input) {
    this.manualInput = input;
    return { known: true, replied: this.manualReply };
  }

  async fetchDirect() {
    return this.readBackMessage ? [this.readBackMessage] : [];
  }
}

test("Hermes DWS sidecar emits allowlisted records and persists a private checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-sidecar-"));
  const stateFile = join(root, "state.json");
  const frames = [];
  const dws = new FakeDws();
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  await runtime.check();
  await runtime.stop();

  assert.equal(frames[0].type, "ready");
  assert.equal(frames.filter((frame) => frame.type === "event").length, 1);
  assert.equal(frames[1].record.senderUserId, "trusted-user");
  assert.equal(frames[1].record.chatType, "direct");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.lastUsers["trusted-user"], "2026-08-18T06:01:00.000Z");
  assert.equal(state.lastFullSuccessAt, "2026-08-18T06:01:00.000Z");
  assert.equal(state.lastErrorCount, 0);
});

test("Hermes DWS sidecar 按源消息时间升序交给 Agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-order-"));
  const frames = [];
  const dws = {
    async fetchBySender({ senderUserId }) {
      return [
        { id: "later", senderUserId, conversationId: "conversation", content: "later", createTime: "2026-08-18T14:01:00+08:00" },
        { id: "earlier", senderUserId, conversationId: "conversation", content: "earlier", createTime: "2026-08-18T14:00:00+08:00" },
      ];
    },
    async fetchGroupMentions() { return []; },
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    now: () => new Date("2026-08-18T14:02:00+08:00"),
  });
  await runtime.start();
  await runtime.stop();
  assert.deepEqual(
    frames.filter((frame) => frame.type === "event").map((frame) => frame.record.id),
    ["earlier", "later"],
  );
});

test("Hermes DWS sidecar 并发抓取目标且部分失败不覆盖失败游标", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-concurrent-"));
  const stateFile = join(root, "state.json");
  let currentTime = new Date("2026-08-18T14:01:00+08:00");
  let active = 0;
  let maximumActive = 0;
  const failing = new Set();
  const dws = {
    async fetchBySender({ senderUserId }) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        if (failing.has(senderUserId)) throw new Error("target unavailable");
        return [];
      } finally {
        active -= 1;
      }
    },
    async fetchGroupMentions() { return []; },
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["good-user", "bad-user"],
      groupIds: [],
      selfUserId: null,
      stateFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: () => {},
    diagnose: () => {},
    now: () => currentTime,
  });
  await runtime.start();
  assert.equal(maximumActive, 2);
  const first = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(first.lastErrorCount, 0);

  failing.add("bad-user");
  currentTime = new Date("2026-08-18T14:02:00+08:00");
  await assert.rejects(
    runtime.check(),
    (error) => error.code === "DWS_SIDECAR_TARGETS_UNAVAILABLE",
  );
  await runtime.stop();
  const second = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(second.lastUsers["good-user"], "2026-08-18T06:02:00.000Z");
  assert.equal(second.lastUsers["bad-user"], "2026-08-18T06:01:00.000Z");
  assert.equal(second.lastFullSuccessAt, "2026-08-18T06:01:00.000Z");
  assert.equal(second.lastErrorCount, 1);
});

test("Hermes DWS sidecar keeps real sending disabled unless explicitly enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-send-"));
  const dws = new FakeDws();
  const base = {
    dwsPath: process.execPath,
    dingtalkRoot: "",
    userIds: ["trusted-user"],
    groupIds: [],
    selfUserId: null,
    stateFile: join(root, "state.json"),
    initialLookbackMs: 120_000,
    fallbackMs: 300_000,
  };
  const disabled = await createSidecarRuntime({
    config: { ...base, sendEnabled: false },
    dws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await disabled.start();
  assert.deepEqual(await disabled.send({
    conversationId: "conversation-1",
    content: "完成了",
  }), { success: false, error: "DWS personal send is disabled" });
  await disabled.stop();

  const enabled = await createSidecarRuntime({
    config: { ...base, stateFile: join(root, "enabled.json"), sendEnabled: true },
    dws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await enabled.start();
  const receipt = await enabled.send({
    conversationId: "conversation-1",
    content: "完成了",
  });
  const duplicate = await enabled.send({
    conversationId: "conversation-1",
    content: "完成了",
  });
  await enabled.stop();
  assert.equal(receipt.success, true);
  assert.equal(duplicate.success, true);
  assert.equal(duplicate.messageId, receipt.messageId);
  assert.equal(dws.sent.length, 1);
  assert.equal(receipt.messageId, "server-message-1");
  assert.equal(dws.sent.at(-1).recipientId, "open-trusted");
  assert.equal(dws.sent.at(-1).recipientKind, "open_dingtalk_id");
});

test("Hermes DWS sidecar converts a verified owner reply into one takeover event", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-takeover-"));
  const frames = [];
  const dws = new FakeDws();
  dws.manualReply = true;
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  await runtime.check();
  await runtime.stop();
  const takeovers = frames.filter((frame) =>
    frame.record?.control === "human_takeover"
  );
  assert.equal(takeovers.length, 1);
  assert.equal(takeovers[0].record.participantUserId, "trusted-user");
  assert.equal(dws.manualInput.selfUserId, "owner-user");
  assert.deepEqual(dws.manualInput.automatedSendEvidence, []);
});

test("Hermes DWS sidecar emits withdrawal audit without replaying message content", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-withdrawn-"));
  const frames = [];
  const dws = new FakeDws();
  dws.withdrawn = true;
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  await runtime.stop();
  const withdrawn = frames.find((frame) => frame.record?.control === "message_withdrawn");
  assert.ok(withdrawn);
  assert.equal(withdrawn.record.messageId, "dws-1");
  assert.equal(Object.hasOwn(withdrawn.record, "content"), false);
});

test("Hermes DWS sidecar marks an explicit send without server message id as unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-unknown-"));
  const dws = new FakeDws();
  dws.receiptWithoutMessageId = true;
  dws.fetchDirect = undefined;
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: true,
    },
    dws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  const result = await runtime.send({
    conversationId: "conversation-1",
    content: "完成了",
  });
  const duplicate = await runtime.send({
    conversationId: "conversation-1",
    content: "完成了",
  });
  await runtime.stop();
  assert.equal(result.success, false);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(duplicate.outcomeUnknown, true);
  assert.equal(dws.sent.length, 1);
});

test("Hermes DWS sidecar reuses a completed send receipt after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-send-ledger-"));
  const stateFile = join(root, "state.json");
  const config = {
    dwsPath: process.execPath,
    dingtalkRoot: "",
    userIds: ["trusted-user"],
    groupIds: [],
    selfUserId: null,
    stateFile,
    initialLookbackMs: 120_000,
    fallbackMs: 300_000,
    sendEnabled: true,
  };
  const firstDws = new FakeDws();
  const first = await createSidecarRuntime({
    config,
    dws: firstDws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await first.start();
  const receipt = await first.send({
    conversationId: "conversation-1",
    content: "完成了",
    replyTo: "source-1",
  });
  await first.stop();

  const secondDws = new FakeDws();
  const second = await createSidecarRuntime({
    config,
    dws: secondDws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:02:00+08:00"),
  });
  await second.start();
  const repeated = await second.send({
    conversationId: "conversation-1",
    content: "完成了",
    replyTo: "source-1",
  });
  await second.stop();
  assert.equal(receipt.success, true);
  assert.equal(repeated.success, true);
  assert.equal(repeated.messageId, receipt.messageId);
  assert.equal(secondDws.sent.length, 0);
});

test("Hermes DWS sidecar restart keeps dedupe and recipient recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-restart-"));
  const stateFile = join(root, "state.json");
  const config = {
    dwsPath: process.execPath,
    dingtalkRoot: "",
    userIds: ["trusted-user"],
    groupIds: [],
    selfUserId: null,
    stateFile,
    initialLookbackMs: 120_000,
    fallbackMs: 300_000,
    sendEnabled: true,
  };
  const firstFrames = [];
  const firstDws = new FakeDws();
  const first = await createSidecarRuntime({
    config,
    dws: firstDws,
    emit: (frame) => firstFrames.push(frame),
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await first.start();
  await first.stop();
  assert.equal(firstFrames.filter((frame) => frame.type === "event").length, 1);

  const secondFrames = [];
  const secondDws = new FakeDws();
  const second = await createSidecarRuntime({
    config,
    dws: secondDws,
    emit: (frame) => secondFrames.push(frame),
    now: () => new Date("2026-08-18T14:01:10+08:00"),
  });
  await second.start();
  const receipt = await second.send({
    conversationId: "conversation-1",
    content: "恢复后的结果",
  });
  await second.stop();
  assert.equal(secondFrames.filter((frame) => frame.type === "event").length, 0);
  assert.equal(receipt.success, true);
  assert.equal(secondDws.sent[0].recipientId, "open-trusted");
  assert.equal(secondDws.sent[0].recipientKind, "open_dingtalk_id");
  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(persisted.recentMessageIds, ["dws-1"]);
  assert.equal(persisted.recipients["conversation-1"].recipientId, "open-trusted");
  assert.equal(persisted.recipients["conversation-1"].recipientKind, "open_dingtalk_id");
});

test("Hermes DWS sidecar verifies a missing receipt id by exact DWS readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-readback-"));
  const dws = new FakeDws();
  dws.receiptWithoutMessageId = true;
  dws.readBackMessage = {
    id: "readback-message-1",
    conversationId: "conversation-1",
    createTime: new Date().toISOString(),
    content: "完成了",
    raw: { aiTag: true },
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: true,
    },
    dws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  const receipt = await runtime.send({
    conversationId: "conversation-1",
    content: "完成了",
  });
  await runtime.stop();
  assert.equal(receipt.success, true);
  assert.equal(receipt.messageId, "readback-message-1");
});
