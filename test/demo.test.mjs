import assert from "node:assert/strict";
import test from "node:test";
import { DemoMessageAdapter, runDemoScenario } from "../src/demo.mjs";

test("demo requires approval and records no side effect beforehand", async () => {
  const result = await runDemoScenario({
    message: "Prepare a launch checklist for Project Aurora.",
    approved: false,
  });
  assert.equal(result.mode, "local-simulation");
  assert.equal(result.externalSystemsTouched, false);
  assert.equal(result.outcome, "awaiting_approval");
  assert.equal(result.draft.workRequest.requested, true);
  assert.deepEqual(result.sideEffects, []);
  assert.deepEqual(result.evidence, []);
});

test("approved demo records intent before effects and verifies target read-back", async () => {
  const result = await runDemoScenario({
    message: "Prepare a launch checklist for Project Aurora.",
    approved: true,
  });
  assert.equal(result.outcome, "completed");
  assert.deepEqual(
    result.sideEffects.map(({ type, status }) => ({ type, status })),
    [
      { type: "demo_document_write", status: "completed" },
      { type: "demo_message_send", status: "completed" },
    ],
  );
  assert.equal(result.evidence.length, 2);
  assert.ok(result.evidence.every((item) => item.verified !== false));
  assert.deepEqual(result.events.map((event) => event.step), [
    "message_received",
    "draft_generated",
    "approval",
    "side_effects",
    "target_verification",
  ]);
});

test("demo message delivery is idempotent and receipt verification reads the target", async () => {
  const adapter = new DemoMessageAdapter({
    now: () => new Date("2026-08-11T10:00:00Z"),
  });
  const input = {
    conversationId: "conversation-1",
    recipientId: "user-1",
    chatType: "direct",
    text: "hello",
    idempotencyKey: "send-1",
  };
  const first = await adapter.sendMessage(input);
  const second = await adapter.sendMessage(input);
  assert.deepEqual(second, first);
  assert.equal(adapter.messages.length, 1);
  assert.equal(adapter.verifySendReceipt(first).readBack, true);
  assert.throws(
    () => adapter.verifySendReceipt({ status: "UNKNOWN" }),
    (error) => error.code === "demo_send_receipt_unknown",
  );
});

test("group demo messages are only listed when explicitly mentioning the agent", async () => {
  const adapter = new DemoMessageAdapter({
    now: () => new Date("2026-08-11T10:00:00Z"),
  });
  adapter.pushInbound("for your information", {
    chatType: "group",
    conversationId: "group-1",
    mentionedSelf: false,
  });
  adapter.pushInbound("@agent please review", {
    chatType: "group",
    conversationId: "group-1",
    mentionedSelf: true,
  });
  const messages = await adapter.listMessages({
    scope: { type: "group", conversationId: "group-1" },
  });
  assert.deepEqual(messages.map((message) => message.content), [
    "@agent please review",
  ]);
});
