import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  sanitizeDraftMemoryCandidates,
} from "../src/memory-candidate.mjs";
import { Store } from "../src/store.mjs";
import { processDraftTask } from "../src/worker.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ai-memory-candidate-"));
  const store = await new Store(join(directory, "test.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

function enqueue(store, id, content = "我以后希望你回复简短一点") {
  const at = new Date("2026-08-10T08:00:00.000Z");
  store.ingestMessages([{
    id,
    senderUserId: "u1",
    senderName: "测试用户",
    conversationId: "c1",
    createTime: at.toISOString(),
    content,
  }], at);
  return store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(at.getTime() + 10),
  })[0];
}

const config = {
  capabilities: new Set(["draft_reply"]),
  codexPath: "/fake/codex",
  selfUserId: null,
};

function noReplyDraft(memoryCandidates) {
  return {
    shouldReply: false,
    reply: "",
    confidence: 0.95,
    riskLevel: "low",
    reason: "无需回复",
    needsInformation: false,
    relatedToWaitingTask: false,
    workRequest: null,
    ...(memoryCandidates === undefined ? {} : { memoryCandidates }),
  };
}

function personCandidate(
  statement = "对方明确偏好简短回复。",
  sourceMessageId = "memory-source-message",
) {
  return {
    type: "person",
    statement,
    factKey: "communication.reply_length",
    sensitivity: "internal",
    retentionDays: 90,
    confidence: 0.95,
    projectHint: "",
    sourceMessageId,
  };
}

test("旧模拟响应不含记忆候选时按空数组兼容", () => {
  assert.deepEqual(sanitizeDraftMemoryCandidates(undefined), {
    candidates: [],
    rejectedReasons: [],
  });
});

test("凭据和敏感人员评价会在写库前被丢弃", () => {
  const result = sanitizeDraftMemoryCandidates([
    personCandidate("API token: abcdef"),
    { ...personCandidate("他能力差，不适合继续合作。"), sensitivity: "confidential" },
  ]);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.rejectedReasons, [
    "credential_material",
    "sensitive_person_fact",
  ]);
});

test("自然语言口令与裸 Bearer 令牌不会进入记忆候选", () => {
  const result = sanitizeDraftMemoryCandidates([
    personCandidate("我的密码是 abc123"),
    personCandidate("token is abc123"),
    personCandidate("Bearer abcdef123456"),
  ]);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.rejectedReasons, [
    "credential_material",
    "credential_material",
    "credential_material",
  ]);
});

test("没有冒号的凭据标签与验证码也不会进入记忆候选", () => {
  const statements = [
    "密码 abc123",
    "API key abc123",
    "access token abc123",
    "数据库密码 abc123",
    "验证码 123456",
    "verification code 123456",
    "OTP 123456",
  ];
  for (const statement of statements) {
    const result = sanitizeDraftMemoryCandidates([personCandidate(statement)]);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.rejectedReasons, ["credential_material"]);
  }
});

test("常见平台令牌前缀即使没有标签也会被拒绝", () => {
  const statements = [
    ["xoxb-", "1234567890-abcdefghijklmnop"].join(""),
    ["glpat-", "abcdefghijklmnop1234"].join(""),
    ["sk_live_", "abcdefghijklmnop"].join(""),
    ["npm_", "abcdefghijklmnopqrstuvwxyz123456"].join(""),
    ["AIzaSyD-", "abcdefghijklmnopqrstuvwxyz12345"].join(""),
    ["SG.", "abcdefghijklmno.abcdefghijklmnop"].join(""),
  ];
  for (const statement of statements) {
    const result = sanitizeDraftMemoryCandidates([personCandidate(statement)]);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.rejectedReasons, ["credential_material"]);
  }
});

test("人物候选只接受公开职责协作与表达偏好白名单", () => {
  const statements = [
    "He was diagnosed with depression.",
    "手机号是 13800138000",
    "Her home address is 10 Main Street.",
    "生日是 1990 年 1 月 1 日。",
    "他的薪资是每月三万元。",
    "He is unreliable and lazy.",
  ];
  for (const statement of statements) {
    const result = sanitizeDraftMemoryCandidates([personCandidate(statement)]);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.rejectedReasons, ["sensitive_person_fact"]);
  }
  const disallowedKey = sanitizeDraftMemoryCandidates([
    { ...personCandidate("他的手机号公开可联系。"), factKey: "identity.phone" },
  ]);
  assert.deepEqual(disallowedKey.candidates, []);
  assert.deepEqual(disallowedKey.rejectedReasons, ["invalid_shape"]);
});

test("人物隐私不能通过错误的候选类型绕过", () => {
  for (const candidate of [
    {
      ...personCandidate("张三手机号是 13800138000"),
      type: "project",
      factKey: "project.contact",
      projectHint: "示例项目",
    },
    {
      ...personCandidate("张三能力差，不适合继续合作"),
      type: "principle",
      factKey: "principle.collaboration",
    },
  ]) {
    const result = sanitizeDraftMemoryCandidates([candidate]);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.rejectedReasons, ["sensitive_person_fact"]);
  }
});

test("无标签邮箱和格式化电话在所有候选类型中都被拒绝", () => {
  const candidates = [
    personCandidate("请用邮件回复我：alice@example.com"),
    {
      ...personCandidate("联系 138-0013-8000"),
      type: "project",
      factKey: "project.contact",
      projectHint: "示例项目",
    },
    {
      ...personCandidate("备用联系 010-88886666"),
      type: "principle",
      factKey: "principle.contact",
    },
  ];
  for (const candidate of candidates) {
    const result = sanitizeDraftMemoryCandidates([candidate]);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.rejectedReasons, ["sensitive_person_fact"]);
  }
});

test("无标签身份证和银行卡号码不会进入任何自动记忆", () => {
  const candidates = [
    personCandidate("11010519491231002X"),
    {
      ...personCandidate("4111111111111111"),
      type: "project",
      factKey: "project.reference",
      projectHint: "示例项目",
    },
  ];
  for (const candidate of candidates) {
    const result = sanitizeDraftMemoryCandidates([candidate]);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.rejectedReasons, ["sensitive_person_fact"]);
  }
});

test("Worker 不会把凭据、敏感人员事实或无效 factKey 写入候选库", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "unsafe-memory-source");
  await processDraftTask({
    store,
    dws: { async fetchDirect() { return []; } },
    config,
    async generator() {
      return noReplyDraft([
        personCandidate("token: secret-value", "unsafe-memory-source"),
        {
          ...personCandidate("他能力差，不适合继续合作。", "unsafe-memory-source"),
          sensitivity: "confidential",
        },
        {
          ...personCandidate(undefined, "unsafe-memory-source"),
          factKey: "回复偏好",
        },
      ]);
    },
  });
  assert.equal(store.listMemories({ status: "proposed" }).length, 0);
  assert.deepEqual(store.getTask(taskId).result.memoryCandidates, []);
});

test("factKey 只接受稳定小写 ASCII 点路径", () => {
  const result = sanitizeDraftMemoryCandidates([
    { ...personCandidate(), factKey: "回复偏好" },
    { ...personCandidate(), factKey: "Communication.Reply_Length" },
    { ...personCandidate(), factKey: "reply_length" },
  ]);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.rejectedReasons, [
    "invalid_shape",
    "invalid_shape",
    "invalid_shape",
  ]);
});

test("工作线只创建有来源和期限的 proposed 候选", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "memory-source-message");
  await processDraftTask({
    store,
    dws: { async fetchDirect() { return []; } },
    config,
    async generator() {
      return noReplyDraft([personCandidate()]);
    },
  });
  const [memory] = store.listMemories({ status: "proposed" });
  assert.equal(memory.type, "person");
  assert.equal(memory.subject, "u1");
  assert.equal(memory.status, "proposed");
  assert.equal(memory.source_type, "dingtalk_message");
  assert.equal(memory.source_id, "memory-source-message");
  assert.equal(memory.source_version, taskId);
  assert.equal(memory.sensitivity, "internal");
  assert.equal(memory.created_by, "system:memory-candidate");
  assert.equal(memory.valid_from, null);
  assert.equal(memory.scope.factKey, "communication.reply_length");
  const expiresAt = new Date(memory.expires_at);
  assert.ok(expiresAt > new Date());
  assert.ok(expiresAt <= new Date(Date.now() + 365 * 86_400_000));
  assert.equal(store.searchMemories({ query: "简短" }).length, 0);
  store.db.prepare(
    "UPDATE tasks SET payload_json = ? WHERE id = ?",
  ).run(store.cipher.encrypt("{}"), taskId);
  assert.throws(
    () => store.confirmMemory(memory.id, "owner"),
    /source must remain verifiable/u,
  );
});

test("重复候选不刷屏，冲突候选不自动替代旧事实", async (t) => {
  const store = await fixture(t);
  const oldId = store.proposeMemory({
    type: "person",
    subject: "u1",
    statement: "对方明确偏好详细回复。",
    sourceType: "user_confirmation",
    sourceId: "confirmed-source",
    scope: { factKey: "communication.reply_length" },
    createdBy: "owner",
  });
  store.confirmMemory(oldId, "owner");

  for (const id of ["memory-conflict-one", "memory-conflict-two"]) {
    enqueue(store, id);
    await processDraftTask({
      store,
      dws: { async fetchDirect() { return []; } },
      config,
      async generator() {
        return noReplyDraft([personCandidate(undefined, id)]);
      },
    });
  }
  const proposed = store.listMemories({ status: "proposed" });
  assert.equal(proposed.length, 1);
  assert.throws(
    () => store.confirmMemory(proposed[0].id, "owner"),
    /supersedesId/u,
  );
  assert.equal(store.getMemory(oldId).status, "confirmed");
});

test("合并消息候选精确绑定所在消息且拒绝批次外来源", async (t) => {
  const store = await fixture(t);
  const at = new Date("2026-08-10T08:00:00.000Z");
  store.ingestMessages([
    {
      id: "bundle-first",
      senderUserId: "u1",
      senderName: "测试用户",
      conversationId: "c1",
      createTime: at.toISOString(),
      content: "以后请简短回复",
    },
    {
      id: "bundle-latest",
      senderUserId: "u1",
      senderName: "测试用户",
      conversationId: "c1",
      createTime: new Date(at.getTime() + 1_000).toISOString(),
      content: "另外帮我看下方案",
    },
  ], new Date(at.getTime() + 1_000));
  store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(at.getTime() + 2_000),
  });
  await processDraftTask({
    store,
    dws: { async fetchDirect() { return []; } },
    config,
    async generator() {
      return noReplyDraft([personCandidate(undefined, "bundle-first")]);
    },
  });
  assert.equal(
    store.listMemories({ status: "proposed" })[0].source_id,
    "bundle-first",
  );

  enqueue(store, "next-valid-message");
  await processDraftTask({
    store,
    dws: { async fetchDirect() { return []; } },
    config,
    async generator() {
      return noReplyDraft([personCandidate(undefined, "outside-message")]);
    },
  });
  assert.equal(store.listMemories({ status: "proposed" }).length, 1);
});

test("自动候选存储层强制来源、期限且拒绝凭据", async (t) => {
  const store = await fixture(t);
  const base = {
    type: "person",
    subject: "u1",
    statement: "对方偏好简短回复。",
    sourceType: "dingtalk_message",
    sourceId: "message-1",
    sourceVersion: "task-1",
    scope: { factKey: "communication.reply_length" },
    confidence: 0.9,
    sensitivity: "internal",
    createdBy: "system:memory-candidate",
  };
  assert.throws(
    () => store.proposeMemoryCandidate(base),
    /requires an expiry/u,
  );
  assert.throws(
    () => store.proposeMemoryCandidate({
      ...base,
      statement: "password: highly-sensitive",
      expiresAt: new Date(Date.now() + 86_400_000),
    }),
    /credential material/u,
  );
  assert.throws(
    () => store.proposeMemoryCandidate({
      ...base,
      type: "project",
      statement: "张三手机号是 13800138000",
      subject: "project-1",
      scope: { factKey: "project.contact" },
      expiresAt: new Date(Date.now() + 86_400_000),
    }),
    /sensitive person fact/u,
  );
  assert.throws(
    () => store.proposeMemoryCandidate({
      ...base,
      type: "principle",
      statement: "张三能力差，不适合继续合作",
      subject: "organization",
      scope: { factKey: "principle.collaboration" },
      expiresAt: new Date(Date.now() + 86_400_000),
    }),
    /sensitive person fact/u,
  );
  assert.throws(
    () => store.proposeMemoryCandidate({
      ...base,
      scope: { factKey: "回复偏好" },
      expiresAt: new Date(Date.now() + 86_400_000),
    }),
    /fact key is invalid/u,
  );
  assert.throws(
    () => store.proposeMemoryCandidate({
      ...base,
      expiresAt: new Date(Date.now() + 86_400_000),
    }),
    /does not belong to its source task/u,
  );
  assert.equal(store.listMemories({ status: "proposed" }).length, 0);
});
