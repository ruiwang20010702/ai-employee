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

test("人工回复识别不确定时默认阻止发送", async () => {
  const dws = new DwsAdapter({ dwsPath: "/fake/dws" });
  dws.fetchDirect = async () => [
    {
      createTime: "2026-07-31T10:01:00Z",
      isSelf: false,
      raw: {},
    },
  ];
  assert.deepEqual(
    await dws.hasManualReply({
      userId: "u1",
      selfUserId: "self",
      after: "2026-07-31T10:00:00Z",
    }),
    {
      known: false,
      replied: false,
      reason: "Messages after the source could not be attributed safely",
    },
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
