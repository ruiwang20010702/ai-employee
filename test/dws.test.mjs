import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSuccessfulSendReceipt,
  collectMessages,
  DwsAdapter,
  isAutomatedSelfMessage,
} from "../src/dws.mjs";
import { fetchStart, startListener } from "../src/listener.mjs";

test("兼容 DWS 会话嵌套消息结构", () => {
  const messages = collectMessages(
    {
      result: {
        conversationMessagesList: [
          {
            openConversationId: "c1",
            messages: [
              {
                openMessageId: "m1",
                sender: "测试用户",
                createTime: "2026-07-31T10:00:00Z",
                content: "你好",
              },
            ],
          },
        ],
      },
    },
    "u1",
  );
  assert.deepEqual(
    {
      id: messages[0].id,
      senderUserId: messages[0].senderUserId,
      conversationId: messages[0].conversationId,
      content: messages[0].content,
    },
    { id: "m1", senderUserId: "u1", conversationId: "c1", content: "你好" },
  );
});

test("增量抓取从检查点前重叠一段时间", () => {
  const now = new Date("2026-07-31T12:00:00Z");
  assert.equal(
    fetchStart({
      checkpoint: "2026-07-31T11:00:00Z",
      now,
      overlapMs: 600_000,
      initialLookbackHours: 72,
    }).toISOString(),
    "2026-07-31T10:50:00.000Z",
  );
  assert.equal(
    fetchStart({
      checkpoint: null,
      now,
      overlapMs: 600_000,
      initialLookbackHours: 72,
    }).toISOString(),
    "2026-07-28T12:00:00.000Z",
  );
});

test("发送回执必须明确成功，失败或空回执不能冒充已发送", () => {
  assert.deepEqual(
    assertSuccessfulSendReceipt({ result: { sendStatus: "SUCCESS" } }),
    { result: { sendStatus: "SUCCESS" } },
  );
  assert.deepEqual(assertSuccessfulSendReceipt({ success: true }), {
    success: true,
  });
  assert.throws(
    () => assertSuccessfulSendReceipt({ success: false }),
    (error) => error.code === "dws_send_failed",
  );
  assert.throws(
    () => assertSuccessfulSendReceipt({ result: { sendStatus: "FAILED" } }),
    (error) => error.code === "dws_send_failed",
  );
  assert.throws(
    () => assertSuccessfulSendReceipt({ result: [] }),
    (error) => error.code === "dws_send_receipt_unknown",
  );
  assert.throws(
    () => assertSuccessfulSendReceipt({ meta: { status: "SUCCESS" }, result: {} }),
    (error) => error.code === "dws_send_receipt_unknown",
  );
});

test("DWS 子进程只接收工具运行白名单环境", async () => {
  let invocation;
  const dws = new DwsAdapter({
    dwsPath: "/safe/bin/dws",
    environment: {
      HOME: "/safe/home",
      TMPDIR: "/safe/tmp",
      LANG: "zh_CN.UTF-8",
      SSL_CERT_FILE: "/safe/cert.pem",
      HTTPS_PROXY: "https://proxy.example",
      DATABASE_URL: "postgresql://secret",
      AI_EMPLOYEE_ADMIN_TOKEN: "admin-secret",
      AI_EMPLOYEE_DATA_KEY: "data-secret",
      ALERT_WEBHOOK_URL: "https://secret.example/hook",
      DINGTALK_ACCESS_TOKEN: "dingtalk-secret",
      UNRELATED_SECRET: "extra-secret",
    },
    commandRunner: async (...args) => {
      invocation = args;
      return { stdout: "{}" };
    },
  });

  await dws.run(["chat", "message", "list-direct"], {
    timeout: 1_234,
    env: { DATABASE_URL: "caller-override", INJECTED_SECRET: "injected" },
  });

  const childEnvironment = invocation[2].env;
  assert.equal(invocation[2].timeout, 1_234);
  assert.equal(childEnvironment.HOME, "/safe/home");
  assert.equal(childEnvironment.TMPDIR, "/safe/tmp");
  assert.equal(childEnvironment.LANG, "zh_CN.UTF-8");
  assert.equal(childEnvironment.SSL_CERT_FILE, "/safe/cert.pem");
  assert.equal(childEnvironment.HTTPS_PROXY, "https://proxy.example");
  assert.ok(childEnvironment.PATH.startsWith("/safe/bin:"));
  for (const name of [
    "DATABASE_URL",
    "AI_EMPLOYEE_ADMIN_TOKEN",
    "AI_EMPLOYEE_DATA_KEY",
    "ALERT_WEBHOOK_URL",
    "DINGTALK_ACCESS_TOKEN",
    "UNRELATED_SECRET",
    "INJECTED_SECRET",
  ]) {
    assert.equal(Object.hasOwn(childEnvironment, name), false);
  }
  const childValues = new Set(Object.values(childEnvironment));
  for (const secret of [
    "postgresql://secret",
    "admin-secret",
    "data-secret",
    "https://secret.example/hook",
    "dingtalk-secret",
    "extra-secret",
    "caller-override",
    "injected",
  ]) {
    assert.equal(childValues.has(secret), false);
  }
});

test("移动审批只解析与当前账号精确匹配的本人自聊消息", async () => {
  const calls = [];
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.run = async (args) => {
    calls.push(args);
    if (args[0] === "contact" && args[2] === "get-self") {
      return { result: [{ orgEmployeeModel: { userId: "owner", orgUserName: "Owner" } }] };
    }
    if (args[0] === "contact" && args[2] === "search") {
      return { result: [{ userId: "owner", openDingTalkId: "DT-OWNER" }] };
    }
    return {
      result: {
        messages: [
          { openMessageId: "self", openConversationId: "self-chat", senderUserId: "owner", direction: "outgoing", createTime: "2026-08-17T10:01:00Z", content: "批准 ABCD1234" },
          { openMessageId: "other", openConversationId: "self-chat", senderUserId: "other", direction: "incoming", createTime: "2026-08-17T10:02:00Z", content: "批准 ABCD1234" },
        ],
      },
    };
  };
  const messages = await dws.fetchMobileApprovalMessages({
    selfUserId: "owner",
    start: new Date("2026-08-17T10:00:00Z"),
    end: new Date("2026-08-17T10:03:00Z"),
  });
  assert.deepEqual(messages.map((message) => message.id), ["self"]);
  assert.equal(messages[0].approvalOwnerVerified, true);
  const listCall = calls.find((args) => args.includes("list-direct"));
  assert.ok(listCall.includes("--open-dingtalk-id"));
  assert.equal(listCall.includes("--user"), false);
});

test("移动审批通知固定发送给当前认证账号并使用幂等 AI 消息", async () => {
  const calls = [];
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.run = async (args) => {
    calls.push(args);
    if (args[0] === "contact" && args[2] === "get-self") {
      return { result: [{ orgEmployeeModel: { userId: "owner", orgUserName: "Owner" } }] };
    }
    if (args[0] === "contact" && args[2] === "search") {
      return { result: [{ userId: "owner", openDingTalkId: "DT-OWNER" }] };
    }
    return { success: true };
  };
  await dws.sendMobileApproval({
    selfUserId: "owner",
    text: "待审批",
    idempotencyKey: "mobile-idempotency",
  });
  const send = calls.at(-1);
  assert.deepEqual(send.slice(0, 4), ["chat", "message", "send", "--open-dingtalk-id"]);
  assert.ok(send.includes("DT-OWNER"));
  assert.ok(send.includes("--ai-tag"));
  assert.equal(send[send.indexOf("--uuid") + 1], "mobile-idempotency");
});

test("人工回复按当前账号发送记录和会话匹配", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.fetchBySenderAll = async ({ senderUserId }) => [
    {
      createTime: "2026-07-31T10:01:00Z",
      isSelf: false,
      senderUserId,
      conversationId: "c1",
      raw: { sender: "Ray" },
    },
  ];
  assert.deepEqual(
    await dws.hasManualReply({
      conversationId: "c1",
      selfUserId: "self",
      after: "2026-07-31T10:00:00Z",
    }),
    {
      known: true,
      replied: true,
    },
  );
});

test("人工回复不会跨会话误取消", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.fetchBySenderAll = async () => [
    {
      createTime: "2026-07-31T10:01:00Z",
      conversationId: "other-conversation",
    },
  ];
  assert.deepEqual(
    await dws.hasManualReply({
      conversationId: "c1",
      selfUserId: "self",
      after: "2026-07-31T10:00:00Z",
    }),
    { known: true, replied: false },
  );
});

test("AI 标签、发送标识或同次发送内容不会冒充人工回复", () => {
  const evidence = [{
    taskId: "reply-1",
    idempotencyKey: "reply-1",
    conversationId: "c1",
    content: "请补充上线日期。",
    startedAt: "2026-07-31T10:00:00Z",
    receipt: { result: { openTaskId: "task-marker-1" } },
  }];
  assert.equal(isAutomatedSelfMessage({
    id: "m1",
    conversationId: "c1",
    createTime: "2026-07-31T10:00:01Z",
    content: "任意内容",
    raw: { aiTag: true },
  }, []), true);
  assert.equal(isAutomatedSelfMessage({
    id: "m2",
    conversationId: "c1",
    createTime: "2026-07-31T10:00:01Z",
    content: "请补充上线日期。",
    raw: {},
  }, evidence), true);
  assert.equal(isAutomatedSelfMessage({
    id: "m3",
    conversationId: "c1",
    createTime: "2026-07-31T10:00:01Z",
    content: "我来接手处理。",
    raw: {},
  }, evidence), false);
});

test("发送者分页只保留单聊消息", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  let calls = 0;
  dws.run = async () => {
    calls += 1;
    return calls === 1
      ? {
          result: {
            hasMore: true,
            nextCursor: "next",
            conversationMessagesList: [
              {
                singleChat: false,
                openConversationId: "group",
                messages: [{ openMessageId: "g1", createTime: "1" }],
              },
              {
                singleChat: true,
                openConversationId: "direct",
                messages: [{ openMessageId: "d1", createTime: "2" }],
              },
            ],
          },
        }
      : {
          result: {
            hasMore: false,
            conversationMessagesList: [
              {
                singleChat: true,
                openConversationId: "direct",
                messages: [{ openMessageId: "d2", createTime: "3" }],
              },
            ],
          },
        };
  };
  const messages = await dws.fetchBySender({
    senderUserId: "u1",
    start: new Date(),
    end: new Date(),
  });
  assert.deepEqual(
    messages.map((message) => message.id),
    ["d1", "d2"],
  );
});

test("发送者查询拒绝响应中不匹配的身份", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.run = async () => ({
    result: {
      hasMore: false,
      conversationMessagesList: [{
        singleChat: true,
        openConversationId: "direct",
        messages: [{
          openMessageId: "unexpected-message",
          senderUserId: "unexpected-user",
          createTime: "2026-07-31 10:00:00",
        }],
      }],
    },
  });

  await assert.rejects(
    dws.fetchBySender({
      senderUserId: "allowlisted-user",
      start: new Date("2026-07-31T00:00:00Z"),
      end: new Date("2026-07-31T12:00:00Z"),
    }),
    (error) => error.code === "dws_sender_identity_mismatch",
  );
});

test("群聊监听只保留白名单群中的 @我 消息", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.run = async (args) => {
    assert.ok(args.includes("--at-me"));
    assert.equal(args[args.indexOf("--conversation-ids") + 1], "group-1");
    return {
      result: {
        hasMore: false,
        conversationMessagesList: [
          {
            singleChat: false,
            openConversationId: "group-1",
            messages: [
              {
                openMessageId: "g1",
                createTime: "2026-07-31 10:00:00",
                sender: "测试用户",
                senderOpenDingTalkId: "open-user-1",
                content: "@负责人 帮忙看下",
              },
            ],
          },
          {
            singleChat: false,
            openConversationId: "other-group",
            messages: [
              {
                openMessageId: "g2",
                createTime: "2026-07-31 10:01:00",
                senderOpenDingTalkId: "open-user-2",
              },
            ],
          },
        ],
      },
    };
  };
  const messages = await dws.fetchGroupMentions({
    groupIds: ["group-1"],
    start: new Date("2026-07-31T00:00:00Z"),
    end: new Date("2026-07-31T12:00:00Z"),
  });
  assert.deepEqual(
    messages.map(({ id, senderUserId, conversationId }) => ({
      id,
      senderUserId,
      conversationId,
    })),
    [
      {
        id: "g1",
        senderUserId: "open-user-1",
        conversationId: "group-1",
      },
    ],
  );
});

test("私聊抓取优先保留配置的通讯录账号", () => {
  const [message] = collectMessages(
    {
      result: {
        conversationMessagesList: [
          {
            singleChat: true,
            openConversationId: "direct-1",
            messages: [
              {
                openMessageId: "d1",
                createTime: "2026-07-31 10:00:00",
                sender: "测试用户",
                senderOpenDingTalkId: "open-user-1",
              },
            ],
          },
        ],
      },
    },
    "staff-user-1",
  );
  assert.equal(message.senderUserId, "staff-user-1");
});

test("已有开放账号任务使用开放账号参数拉取私聊", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  let args;
  dws.run = async (input) => {
    args = input;
    return { result: { conversationMessagesList: [] } };
  };
  await dws.fetchDirect({ userId: "DTestOpenId123" });
  assert.ok(args.includes("--open-dingtalk-id"));
  assert.ok(!args.includes("--user"));
  assert.equal(args[args.indexOf("--forward") + 1], "true");
});

test("私聊上下文从过去向现在读取并只保留截止时间前最后若干条", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  let args;
  dws.run = async (input) => {
    args = input;
    return {
      result: {
        conversationMessagesList: [{
          singleChat: true,
          openConversationId: "direct-1",
          messages: [
            { openMessageId: "too-old", createTime: "2026-08-17T01:59:00.000Z" },
            { openMessageId: "m1", createTime: "2026-08-17T03:30:00.000Z" },
            { openMessageId: "m2", createTime: "2026-08-17T03:59:00.000Z" },
            { openMessageId: "m3", createTime: "2026-08-17T04:00:00.000Z" },
            { openMessageId: "future", createTime: "2026-08-17T04:00:02.000Z" },
          ],
        }],
      },
    };
  };
  const messages = await dws.fetchDirect({
    userId: "staff-user-1",
    before: new Date("2026-08-17T04:00:00.000Z"),
    lookbackMs: 2 * 60 * 60 * 1_000,
    limit: 2,
  });
  assert.equal(args[args.indexOf("--time") + 1], "2026-08-17 10:00:00");
  assert.equal(args[args.indexOf("--forward") + 1], "true");
  assert.equal(args[args.indexOf("--limit") + 1], "8");
  assert.deepEqual(messages.map((message) => message.id), ["m2", "m3"]);
});

test("已有开放账号任务使用开放账号参数发送私聊", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  let args;
  dws.run = async (input) => {
    args = input;
    return { success: true };
  };
  await dws.sendText({
    userId: "DTestOpenId123",
    text: "收到",
    idempotencyKey: "task-1",
  });
  assert.ok(args.includes("--open-dingtalk-id"));
  assert.ok(!args.includes("--user"));
});

function listenerStore() {
  const checkpoints = new Map();
  return {
    closed: false,
    async open() { return this; },
    async getCheckpoint(key) { return checkpoints.get(key) ?? null; },
    async setCheckpoint(key, value) { checkpoints.set(key, value); },
    async ingestMessages(messages) { return messages.length; },
    async createReadyTasks() { return []; },
    async isPaused() { return false; },
    async recordHeartbeat() {},
    async close() { this.closed = true; },
    checkpoints,
  };
}

const listenerConfig = {
  targetUserIds: ["good-user", "bad-user"],
  targetGroupIds: [],
  overlapMs: 60_000,
  initialLookbackHours: 24,
  quietWindowMs: 1_000,
  bundleGapMs: 1_000,
  maxMessagesPerTask: 20,
  maxTaskAttempts: 3,
};

test("监听器部分目标失败时保留成功检查点并记录整体失败", async () => {
  const store = listenerStore();
  await startListener({
    store,
    config: listenerConfig,
    once: true,
    dws: {
      async fetchBySender({ senderUserId }) {
        if (senderUserId === "bad-user") throw new Error("DWS unavailable");
        return [];
      },
    },
  });
  assert.equal(store.closed, true);
  assert.equal(store.checkpoints.get("listener:last-full-failure"), "target_fetch_failed");
  assert.equal(store.checkpoints.has("listener:last-full-success"), false);
  assert.equal(
    [...store.checkpoints.keys()].some((key) => key.startsWith("dws:last-success:")),
    true,
  );
});

test("监听器全部目标失败时一次运行明确失败且仍关闭存储", async () => {
  const store = listenerStore();
  await assert.rejects(
    startListener({
      store,
      config: listenerConfig,
      once: true,
      dws: {
        async fetchBySender() {
          throw new Error("DWS unavailable");
        },
      },
    }),
    /failed for every configured target/u,
  );
  assert.equal(store.closed, true);
});

test("监听入库边界拒绝白名单查询返回的其他发送者", async () => {
  const store = listenerStore();
  const ingested = [];
  store.ingestMessages = async (messages) => {
    ingested.push(...messages);
    return messages.length;
  };

  await assert.rejects(
    startListener({
      store,
      config: {
        ...listenerConfig,
        targetUserIds: ["allowlisted-user"],
      },
      once: true,
      dws: {
        async fetchBySender() {
          return [{
            id: "unexpected-message",
            senderUserId: "unexpected-user",
            conversationId: "direct",
            createTime: "2026-07-31T10:00:00Z",
            content: "异常消息",
          }];
        },
      },
    }),
    /failed for every configured target/u,
  );
  assert.deepEqual(ingested, []);
  assert.equal(
    [...store.checkpoints.keys()].some((key) => key.startsWith("dws:last-success:")),
    false,
  );
});

test("监听器并发重算截止时间时旧结果不能清除新定时器", async () => {
  const store = listenerStore();
  let createCalls = 0;
  let deadlineCalls = 0;
  let resolveOlder;
  let resolveNewer;
  const older = new Promise((resolve) => { resolveOlder = resolve; });
  const newer = new Promise((resolve) => { resolveNewer = resolve; });
  let observeSweep;
  const sweepObserved = new Promise((resolve) => { observeSweep = resolve; });
  store.createReadyTasks = async () => {
    createCalls += 1;
    if (createCalls === 4) observeSweep();
    return [];
  };
  store.nextPendingBundleAt = async () => {
    deadlineCalls += 1;
    if (deadlineCalls === 1) return null;
    if (deadlineCalls === 2) return older;
    if (deadlineCalls === 3) return newer;
    return null;
  };
  const listener = await startListener({
    store,
    config: {
      ...listenerConfig,
      targetUserIds: [],
      dingtalkRoot: "/nonexistent/dingtalk",
      bundleMaxWaitMs: 8_000,
      bundleGapMs: 1_000,
      waitingInformationTtlMs: 60_000,
      fallbackMs: 60_000,
      heartbeatMs: 60_000,
      debounceMs: 10,
    },
    once: false,
    dws: {},
  });
  const first = listener.createTasks();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deadlineCalls, 2);
  const second = listener.createTasks();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deadlineCalls, 3);
  resolveNewer(new Date(Date.now() + 30));
  await second;
  resolveOlder(null);
  await first;
  let timeout;
  await Promise.race([
    sweepObserved,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Bundle deadline timer was cleared by a stale result")),
        1_000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(createCalls, 4);
  await listener.stop();
  assert.equal(store.closed, true);
});

test("截止扫描瞬时失败后仍会自动重试而不等待低频兜底", async () => {
  const store = listenerStore();
  let createCalls = 0;
  let observeRecovery;
  const recovered = new Promise((resolve) => { observeRecovery = resolve; });
  store.createReadyTasks = async () => {
    createCalls += 1;
    if (createCalls === 2) throw new Error("temporary database failure");
    if (createCalls === 3) observeRecovery();
    return [];
  };
  let deadlineCalls = 0;
  store.nextPendingBundleAt = async () => {
    deadlineCalls += 1;
    return deadlineCalls === 1 ? new Date(Date.now() + 20) : null;
  };
  const listener = await startListener({
    store,
    config: {
      ...listenerConfig,
      targetUserIds: [],
      dingtalkRoot: "/nonexistent/dingtalk",
      bundleMaxWaitMs: 8_000,
      waitingInformationTtlMs: 60_000,
      fallbackMs: 60_000,
      heartbeatMs: 60_000,
      debounceMs: 10,
    },
    once: false,
    dws: {},
  });
  let timeout;
  await Promise.race([
    recovered,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Failed bundle sweep was not retried")),
        1_000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(createCalls, 3);
  await listener.stop();
});

test("暂停恢复后无需新消息事件也会重新处理到期消息", async () => {
  const store = listenerStore();
  store.paused = true;
  store.isPaused = async () => store.paused;
  let createCalls = 0;
  let observeResume;
  const resumed = new Promise((resolve) => { observeResume = resolve; });
  store.createReadyTasks = async () => {
    createCalls += 1;
    observeResume();
    return [];
  };
  store.nextPendingBundleAt = async () => null;
  const listener = await startListener({
    store,
    config: {
      ...listenerConfig,
      targetUserIds: [],
      dingtalkRoot: "/nonexistent/dingtalk",
      bundleMaxWaitMs: 8_000,
      waitingInformationTtlMs: 60_000,
      pausedBundleRecheckMs: 20,
      fallbackMs: 60_000,
      heartbeatMs: 60_000,
      debounceMs: 10,
    },
    once: false,
    dws: {},
  });
  assert.equal(createCalls, 0);
  store.paused = false;
  let timeout;
  await Promise.race([
    resumed,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Listener did not wake after pause was removed")),
        1_000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(createCalls, 1);
  await listener.stop();
});
