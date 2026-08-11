import assert from "node:assert/strict";
import test from "node:test";
import {
  adapterContractVersion,
  assertAgentRuntime,
  assertMessageAdapter,
  assertModelProvider,
  assertNormalizedMessage,
} from "../src/adapter-contracts.mjs";
import {
  ClaudeCodeAgentRuntime,
  CodexAgentRuntime,
  ModelProviderAgentRuntime,
} from "../src/agent-runtime.mjs";
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
    (error) => error.code === "AI_EMPLOYEE_MESSAGE_ADAPTER_CONTRACT",
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
    (error) => error.code === "AI_EMPLOYEE_MESSAGE_CONTRACT",
  );
});

test("Codex and model-backed runtimes share one draft runtime contract", async () => {
  assert.equal(assertAgentRuntime(new CodexAgentRuntime()).id, "codex");
  assert.equal(
    assertAgentRuntime(new ClaudeCodeAgentRuntime()).id,
    "claude-code",
  );
  const provider = {
    id: "fixture-model",
    contractVersion: adapterContractVersion,
    async generateStructured({ context, schema }) {
      assert.equal(context.marker, "contract-test");
      assert.equal(schema.type, "object");
      return { ok: true };
    },
  };
  assert.equal(assertModelProvider(provider), provider);
  const runtime = assertAgentRuntime(new ModelProviderAgentRuntime(provider));
  assert.deepEqual(await runtime.generateDraft({
    prompt: "fixture",
    schemaPath: new URL("../schemas/draft.schema.json", import.meta.url),
    context: { marker: "contract-test" },
  }), { ok: true });
});

test("model and runtime contracts reject unstable identities", () => {
  assert.throws(
    () => assertModelProvider({
      id: "Claude Model",
      contractVersion: adapterContractVersion,
      generateStructured() {},
    }),
    (error) => error.code === "AI_EMPLOYEE_MODEL_PROVIDER_CONTRACT",
  );
  assert.throws(
    () => assertAgentRuntime({
      id: "runtime",
      decisionSource: "runtime",
      contractVersion: "2.0",
      generateDraft() {},
    }),
    (error) => error.code === "AI_EMPLOYEE_AGENT_RUNTIME_CONTRACT",
  );
});
