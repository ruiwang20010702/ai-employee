import assert from "node:assert/strict";
import test from "node:test";
import {
  adapterContractVersion,
  assertMessageAdapter,
  assertNormalizedMessage,
} from "../src/adapter-contracts.mjs";
import { DwsAdapter } from "../src/dws.mjs";

test("DWS exposes the versioned generic message adapter contract", async () => {
  const adapter = new DwsAdapter({ dwsPath: "/fake/dws" });
  adapter.fetchBySender = async () => [{
    id: "message-1",
    senderUserId: "user-1",
    conversationId: "conversation-1",
    content: "hello",
    createTime: "2026-08-11T10:00:00Z",
    singleChat: true,
    isSelf: false,
    raw: {},
  }];
  assert.equal(assertMessageAdapter(adapter), adapter);
  const messages = await adapter.listMessages({
    scope: { type: "direct", participantId: "user-1" },
    start: new Date("2026-08-11T09:00:00Z"),
    end: new Date("2026-08-11T11:00:00Z"),
  });
  assert.deepEqual(messages.map((message) => ({
    id: message.id,
    senderId: message.senderId,
    chatType: message.chatType,
    platform: message.platform,
  })), [{
    id: "message-1",
    senderId: "user-1",
    chatType: "direct",
    platform: "dingtalk",
  }]);
});

test("message contracts fail closed for missing methods and ambiguous group mentions", () => {
  assert.throws(
    () => assertMessageAdapter({
      id: "broken",
      platform: "demo",
      deliveryMode: "demo",
      contractVersion: adapterContractVersion,
    }),
    (error) => error.code === "FOURSDAY_MESSAGE_ADAPTER_CONTRACT",
  );
  assert.throws(
    () => assertNormalizedMessage({
      id: "m1",
      senderId: "u1",
      conversationId: "c1",
      content: "hello",
      occurredAt: "2026-08-11T10:00:00Z",
      chatType: "group",
    }),
    (error) => error.code === "FOURSDAY_MESSAGE_CONTRACT",
  );
});
