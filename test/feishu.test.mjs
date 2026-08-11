import assert from "node:assert/strict";
import test from "node:test";

import { assertMessageAdapter } from "../src/adapter-contracts.mjs";
import {
  createFeishuLongConnection,
  FeishuAdapter,
  normalizeFeishuEvent,
} from "../src/feishu.mjs";

const selfOpenId = "ou_bot";

function event(overrides = {}) {
  return {
    event_id: "evt_1",
    event_type: "im.message.receive_v1",
    sender: {
      sender_type: "user",
      sender_id: { open_id: "ou_user" },
    },
    message: {
      message_id: "om_1",
      create_time: "1786435200000",
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "Please review the launch plan" }),
    },
    ...overrides,
  };
}

function client({
  listResponse = { code: 0, data: { items: [] } },
  createResponse = {
    code: 0,
    data: { message_id: "om_sent", chat_id: "oc_chat" },
  },
  getResponse = {
    code: 0,
    data: {
      items: [{
        message_id: "om_sent",
        chat_id: "oc_chat",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "Approved reply" }) },
      }],
    },
  },
} = {}) {
  const calls = [];
  return {
    calls,
    im: {
      v1: {
        message: {
          list: async (payload) => {
            calls.push(["list", payload]);
            return listResponse;
          },
          create: async (payload) => {
            calls.push(["create", payload]);
            return createResponse;
          },
          get: async (payload) => {
            calls.push(["get", payload]);
            return getResponse;
          },
        },
      },
    },
  };
}

test("Feishu event normalizes direct text without DWS", () => {
  const message = normalizeFeishuEvent(event(), { selfOpenId });
  assert.equal(message.platform, "feishu");
  assert.equal(message.chatType, "direct");
  assert.equal(message.senderId, "ou_user");
  assert.equal(message.content, "Please review the launch plan");
  assert.equal(message.eventId, "evt_1");
});

test("Feishu group events require an explicit self mention", async () => {
  const adapter = new FeishuAdapter({ client: client(), selfOpenId });
  assert.equal(assertMessageAdapter(adapter), adapter);
  const withoutMention = adapter.acceptEvent(event({
    event_id: "evt_group_1",
    message: {
      ...event().message,
      message_id: "om_group_1",
      chat_type: "group",
      content: JSON.stringify({ text: "status?" }),
    },
  }));
  assert.equal(withoutMention.accepted, false);

  const withMention = adapter.acceptEvent(event({
    event_id: "evt_group_2",
    message: {
      ...event().message,
      message_id: "om_group_2",
      chat_type: "group",
      content: JSON.stringify({ text: "@_user_1 status?" }),
      mentions: [{
        key: "@_user_1",
        id: { open_id: selfOpenId },
        name: "Foursday",
      }],
    },
  }));
  assert.equal(withMention.accepted, true);
  assert.equal(withMention.message.content, "status?");
  assert.deepEqual(
    (await adapter.listMessages({
      scope: { type: "group", conversationId: "oc_chat" },
    })).map((message) => message.id),
    ["om_group_2"],
  );
});

test("Feishu ignores group messages containing only the self mention", () => {
  assert.throws(
    () => normalizeFeishuEvent(event({
      event_id: "evt_group_empty",
      message: {
        ...event().message,
        message_id: "om_group_empty",
        chat_type: "group",
        content: JSON.stringify({ text: "@_user_1" }),
        mentions: [{
          key: "@_user_1",
          id: { open_id: selfOpenId },
          name: "Foursday",
        }],
      },
    }), { selfOpenId }),
    (error) => error.code === "FEISHU_EVENT_IGNORED",
  );
});

test("Feishu event intake deduplicates at-least-once deliveries by message id", () => {
  const adapter = new FeishuAdapter({ client: client(), selfOpenId });
  assert.deepEqual(adapter.acceptEvent(event()), {
    accepted: true,
    duplicate: false,
    message: adapter.pendingMessages.get("om_1"),
  });
  const duplicate = adapter.acceptEvent(event({ event_id: "evt_retry" }));
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(adapter.pendingMessages.size, 1);
});

test("Feishu rejects bot, self, malformed, and unsupported events", () => {
  assert.throws(
    () => normalizeFeishuEvent(event({
      sender: { sender_type: "bot", sender_id: { open_id: "ou_other_bot" } },
    }), { selfOpenId }),
    (error) => error.code === "FEISHU_EVENT_IGNORED",
  );
  assert.throws(
    () => normalizeFeishuEvent(event({
      sender: { sender_type: "user", sender_id: { open_id: selfOpenId } },
    }), { selfOpenId }),
    (error) => error.code === "FEISHU_EVENT_IGNORED",
  );
  assert.throws(
    () => normalizeFeishuEvent(event({
      message: { ...event().message, content: "not-json" },
    }), { selfOpenId }),
    (error) => error.code === "FEISHU_EVENT_INVALID",
  );
  assert.throws(
    () => normalizeFeishuEvent(event({
      message: { ...event().message, message_type: "image" },
    }), { selfOpenId }),
    (error) => error.code === "FEISHU_MESSAGE_UNSUPPORTED",
  );
});

test("Feishu send uses native UUID idempotency and exact target readback", async () => {
  const mockClient = client();
  const adapter = new FeishuAdapter({ client: mockClient, selfOpenId });
  const receipt = await adapter.sendMessage({
    conversationId: "oc_chat",
    recipientId: "ou_user",
    chatType: "direct",
    text: "Approved reply",
    idempotencyKey: "task-1-send-1",
  });
  assert.equal(receipt.status, "SENT");
  assert.deepEqual(mockClient.calls[0], ["create", {
    params: { receive_id_type: "open_id" },
    data: {
      receive_id: "ou_user",
      msg_type: "text",
      content: JSON.stringify({ text: "Approved reply" }),
      uuid: "task-1-send-1",
    },
  }]);
  assert.deepEqual(await adapter.verifySendReceipt(receipt), {
    verified: true,
    platform: "feishu",
    messageId: "om_sent",
    conversationId: "oc_chat",
    text: "Approved reply",
  });
});

test("Feishu send failures distinguish rejection from unknown outcomes", async () => {
  const rejected = new FeishuAdapter({
    client: client({ createResponse: { code: 230001, msg: "forbidden" } }),
    selfOpenId,
  });
  await assert.rejects(
    rejected.sendMessage({
      conversationId: "oc_chat",
      recipientId: "ou_user",
      chatType: "direct",
      text: "Reply",
      idempotencyKey: "task-2",
    }),
    (error) => error.code === "FEISHU_API_REJECTED",
  );

  const unknownClient = client();
  unknownClient.im.v1.message.create = async () => {
    throw new Error("socket closed after request write");
  };
  const unknown = new FeishuAdapter({ client: unknownClient, selfOpenId });
  await assert.rejects(
    unknown.sendMessage({
      conversationId: "oc_chat",
      recipientId: "ou_user",
      chatType: "direct",
      text: "Reply",
      idempotencyKey: "task-3",
    }),
    (error) => error.code === "FEISHU_SEND_UNKNOWN",
  );
});

test("Feishu readback mismatch remains send-unknown", async () => {
  const adapter = new FeishuAdapter({
    client: client({
      getResponse: {
        code: 0,
        data: {
          items: [{
            message_id: "om_sent",
            chat_id: "oc_other",
            body: { content: JSON.stringify({ text: "Changed" }) },
          }],
        },
      },
    }),
    selfOpenId,
  });
  await assert.rejects(
    adapter.verifySendReceipt({
      status: "SENT",
      messageId: "om_sent",
      conversationId: "oc_chat",
      text: "Approved reply",
    }),
    (error) => error.code === "FEISHU_SEND_UNKNOWN",
  );
});

test("Feishu manual takeover ignores known automated receipts", async () => {
  const history = {
    code: 0,
    data: {
      items: [
        {
          message_id: "om_ai",
          chat_id: "oc_chat",
          msg_type: "text",
          create_time: "1786435201000",
          sender: { id: selfOpenId, sender_type: "user" },
          body: { content: JSON.stringify({ text: "AI reply" }) },
        },
        {
          message_id: "om_manual",
          chat_id: "oc_chat",
          msg_type: "text",
          create_time: "1786435202000",
          sender: { id: selfOpenId, sender_type: "user" },
          body: { content: JSON.stringify({ text: "I will take over" }) },
        },
      ],
    },
  };
  const adapter = new FeishuAdapter({
    client: client({ listResponse: history }),
    selfOpenId,
  });
  const result = await adapter.findManualReply({
    conversationId: "oc_chat",
    selfIdentityId: selfOpenId,
    after: "2026-08-11T00:00:00.000Z",
    now: "2026-08-11T00:01:00.000Z",
    automatedSendEvidence: [{ messageId: "om_ai" }],
  });
  assert.deepEqual(result, { known: true, replied: true });
});

test("Feishu manual takeover paginates beyond the first fifty messages", async () => {
  const pages = [
    {
      code: 0,
      data: {
        has_more: true,
        page_token: "page-2",
        items: Array.from({ length: 50 }, (_, index) => ({
          message_id: "om_bot_" + index,
          chat_id: "oc_chat",
          msg_type: "text",
          create_time: String(1786435201000 + index),
          sender: { id: "ou_other", sender_type: "user" },
          body: { content: JSON.stringify({ text: "history" }) },
        })),
      },
    },
    {
      code: 0,
      data: {
        has_more: false,
        items: [{
          message_id: "om_manual_page_2",
          chat_id: "oc_chat",
          msg_type: "text",
          create_time: "1786435209000",
          sender: { id: selfOpenId, sender_type: "user" },
          body: { content: JSON.stringify({ text: "I took over" }) },
        }],
      },
    },
  ];
  const calls = [];
  const adapter = new FeishuAdapter({
    selfOpenId,
    client: {
      im: { v1: { message: {
        async list(payload) {
          calls.push(payload);
          return pages.shift();
        },
      } } },
    },
  });
  const result = await adapter.findManualReply({
    conversationId: "oc_chat",
    selfIdentityId: selfOpenId,
    after: "2026-08-11T00:00:00.000Z",
    now: "2026-08-11T00:01:00.000Z",
  });
  assert.deepEqual(result, { known: true, replied: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.page_token, "page-2");
  assert.ok(calls[0].params.start_time);
});

test("Feishu manual takeover fails closed on a repeated page token", async () => {
  const adapter = new FeishuAdapter({
    selfOpenId,
    client: {
      im: { v1: { message: {
        async list() {
          return {
            code: 0,
            data: { has_more: true, page_token: "same-page", items: [] },
          };
        },
      } } },
    },
  });
  await assert.rejects(
    adapter.findManualReply({
      conversationId: "oc_chat",
      selfIdentityId: selfOpenId,
      after: "2026-08-11T00:00:00.000Z",
      now: "2026-08-11T00:01:00.000Z",
    }),
    (error) => error.code === "FEISHU_API_INVALID",
  );
});

test("Feishu send refuses targets outside adapter allowlists", async () => {
  const adapter = new FeishuAdapter({
    client: client(),
    selfOpenId,
    targetUserIds: ["ou_allowed"],
    targetGroupIds: ["oc_allowed"],
  });
  await assert.rejects(
    adapter.sendMessage({
      conversationId: "oc_chat",
      recipientId: "ou_other",
      chatType: "direct",
      text: "reply",
      idempotencyKey: "outside-user",
    }),
    (error) => error.code === "FEISHU_SCOPE_REJECTED",
  );
  await assert.rejects(
    adapter.sendMessage({
      conversationId: "oc_other",
      recipientId: "ou_allowed",
      chatType: "group",
      text: "reply",
      idempotencyKey: "outside-group",
    }),
    (error) => error.code === "FEISHU_SCOPE_REJECTED",
  );
});

test("Feishu long connection persists before returning and skips retries", async () => {
  let handler;
  let startPayload;
  const persisted = [];
  class FakeClient {
    constructor() {
      Object.assign(this, client());
    }
  }
  class FakeDispatcher {
    register(handlers) {
      handler = handlers["im.message.receive_v1"];
      return this;
    }
  }
  class FakeWsClient {
    start(payload) {
      startPayload = payload;
      return "started";
    }
  }
  const connection = createFeishuLongConnection({
    appId: "cli_app",
    appSecret: "secret-from-runtime",
    selfOpenId,
    targetUserIds: ["ou_user"],
    persistMessage: async (message) => persisted.push(message.id),
    sdk: {
      Client: FakeClient,
      EventDispatcher: FakeDispatcher,
      WSClient: FakeWsClient,
      LoggerLevel: { info: 1 },
    },
  });
  assert.equal(connection.start(), "started");
  assert.ok(startPayload.eventDispatcher);
  await handler(event());
  await handler(event({ event_id: "evt_retry" }));
  assert.deepEqual(persisted, ["om_1"]);
});

test("Feishu long connection refuses volatile-only event handling", () => {
  assert.throws(
    () => createFeishuLongConnection({
      appId: "cli_app",
      appSecret: "secret",
      selfOpenId,
      targetUserIds: ["ou_user"],
    }),
    (error) => error.code === "FEISHU_PERSISTENCE_REQUIRED",
  );
});

test("Feishu long connection retries durable persistence failures", async () => {
  let handler;
  let attempts = 0;
  class FakeClient {
    constructor() { Object.assign(this, client()); }
  }
  class FakeDispatcher {
    register(handlers) {
      handler = handlers["im.message.receive_v1"];
      return this;
    }
  }
  class FakeWsClient { start() {} }
  createFeishuLongConnection({
    appId: "cli_app",
    appSecret: "secret",
    selfOpenId,
    targetUserIds: ["ou_user"],
    persistMessage: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("database unavailable");
    },
    sdk: {
      Client: FakeClient,
      EventDispatcher: FakeDispatcher,
      WSClient: FakeWsClient,
      LoggerLevel: { info: 1 },
    },
  });
  await assert.rejects(handler(event()), /database unavailable/u);
  await handler(event({ event_id: "evt_retry" }));
  assert.equal(attempts, 2);
});

test("Feishu long connection requires an explicit allowlist", () => {
  assert.throws(
    () => createFeishuLongConnection({
      appId: "cli_app",
      appSecret: "secret",
      selfOpenId,
      persistMessage() {},
    }),
    (error) => error.code === "FEISHU_TARGETS_REQUIRED",
  );
});
