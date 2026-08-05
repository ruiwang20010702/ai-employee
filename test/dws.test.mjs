import assert from "node:assert/strict";
import test from "node:test";
import { collectMessages, DwsAdapter } from "../src/dws.mjs";
import { fetchStart } from "../src/listener.mjs";

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
                content: "@王睿 帮忙看下",
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
