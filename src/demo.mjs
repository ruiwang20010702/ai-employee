import { createHash } from "node:crypto";
import {
  adapterContractVersion,
  assertAgentRuntime,
  assertMessageAdapter,
  assertModelProvider,
  assertNormalizedMessage,
} from "./adapter-contracts.mjs";
import { ModelProviderAgentRuntime } from "./agent-runtime.mjs";
import { generateReplyDraft } from "./draft.mjs";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export class DemoMessageAdapter {
  constructor({ now = () => new Date() } = {}) {
    this.id = "demo-message";
    this.platform = "demo";
    this.deliveryMode = "demo";
    this.contractVersion = adapterContractVersion;
    this.now = now;
    this.messages = [];
    this.receipts = new Map();
  }

  pushInbound(content, {
    senderId = "demo-user",
    conversationId = "demo-conversation",
    chatType = "direct",
    mentionedSelf = chatType === "group",
  } = {}) {
    const message = assertNormalizedMessage({
      id: `demo-in-${this.messages.length + 1}`,
      senderId,
      conversationId,
      content: String(content),
      occurredAt: this.now().toISOString(),
      chatType,
      mentionedSelf: chatType === "group" ? mentionedSelf : undefined,
      isSelf: false,
      platform: "demo",
    });
    this.messages.push(message);
    return message;
  }

  async listMessages({ scope, start = new Date(0), end = this.now() } = {}) {
    const startTime = new Date(start).getTime();
    const endTime = new Date(end).getTime();
    return this.messages.filter((message) => {
      const occurredAt = new Date(message.occurredAt).getTime();
      const inTime = occurredAt >= startTime && occurredAt <= endTime;
      if (!inTime) return false;
      if (scope?.type === "direct") {
        return message.chatType === "direct" &&
          message.senderId === scope.participantId;
      }
      if (scope?.type === "group") {
        return message.chatType === "group" &&
          message.conversationId === scope.conversationId &&
          message.mentionedSelf;
      }
      return true;
    });
  }

  async getConversation({ conversationId, limit = 50 }) {
    return this.messages
      .filter((message) => message.conversationId === conversationId)
      .slice(-limit);
  }

  async findManualReply({ conversationId, after }) {
    const afterTime = new Date(after).getTime();
    return {
      known: true,
      replied: this.messages.some((message) =>
        message.conversationId === conversationId &&
        message.isSelf === true &&
        new Date(message.occurredAt).getTime() > afterTime
      ),
    };
  }

  async sendMessage({
    conversationId,
    recipientId,
    chatType,
    text,
    idempotencyKey,
  }) {
    if (this.receipts.has(idempotencyKey)) {
      return this.receipts.get(idempotencyKey);
    }
    const message = assertNormalizedMessage({
      id: `demo-out-${this.messages.length + 1}`,
      senderId: "demo-foursday",
      conversationId,
      content: String(text),
      occurredAt: this.now().toISOString(),
      chatType,
      mentionedSelf: chatType === "group" ? false : undefined,
      isSelf: true,
      platform: "demo",
      recipientId,
      aiGenerated: true,
    });
    this.messages.push(message);
    const receipt = {
      status: "SENT",
      messageId: message.id,
      idempotencyKey,
    };
    this.receipts.set(idempotencyKey, receipt);
    return receipt;
  }

  verifySendReceipt(receipt) {
    if (receipt?.status !== "SENT" || !receipt.messageId) {
      const error = new Error("Demo send receipt is not explicitly successful");
      error.code = "demo_send_receipt_unknown";
      throw error;
    }
    const message = this.messages.find((item) => item.id === receipt.messageId);
    if (!message?.isSelf) {
      const error = new Error("Demo sent message cannot be read back");
      error.code = "demo_send_readback_failed";
      throw error;
    }
    return { ...receipt, readBack: true, contentSha256: sha256(message.content) };
  }
}

export class DemoModelProvider {
  constructor() {
    this.id = "demo-deterministic";
    this.contractVersion = adapterContractVersion;
  }

  async generateStructured({ context }) {
    const event = context?.event ?? {};
    const content = String(event.content ?? "").trim();
    const workRequested = /(?:方案|文档|代码|测试|上线|发布|plan|document|code|test|deploy|checklist)/iu.test(content);
    return {
      shouldReply: true,
      reply: workRequested
        ? "I can prepare that as a scoped demo work plan. Please review and approve it first."
        : "Thanks — this is a local demo draft. Nothing has been sent or executed yet.",
      confidence: 0.95,
      riskLevel: workRequested ? "medium" : "low",
      reason: workRequested
        ? "The message requests work that requires an approved plan."
        : "The message benefits from a concise reply draft.",
      needsInformation: false,
      relatedToWaitingTask: false,
      workRequest: workRequested
        ? {
            requested: true,
            objective: content.slice(0, 500),
            projectHint: "demo-project",
          }
        : null,
      memoryCandidates: [],
    };
  }
}

export async function runDemoScenario({
  message = "Prepare a launch checklist for Project Aurora.",
  approved = false,
  chatType = "direct",
  messageAdapter = new DemoMessageAdapter(),
  modelProvider = new DemoModelProvider(),
} = {}) {
  assertMessageAdapter(messageAdapter);
  assertModelProvider(modelProvider);
  const runtime = assertAgentRuntime(new ModelProviderAgentRuntime(modelProvider));
  const inbound = messageAdapter.pushInbound(message, { chatType });
  const draft = await generateReplyDraft({
    taskId: "demo-task-1",
    content: inbound.content,
    messages: [{
      id: inbound.id,
      content: inbound.content,
      createTime: inbound.occurredAt,
    }],
    chatType,
    mentionedSelf: chatType === "group" ? inbound.mentionedSelf : undefined,
  }, {
    runtime,
    conversation: await messageAdapter.getConversation({
      conversationId: inbound.conversationId,
      limit: 20,
    }),
  });
  const events = [
    { step: "message_received", status: "completed" },
    { step: "draft_generated", status: "completed" },
    { step: "approval", status: approved ? "approved" : "waiting" },
  ];
  const base = {
    schema: "foursday-demo/v1",
    mode: "local-simulation",
    externalSystemsTouched: false,
    message: inbound,
    draft,
    events,
  };
  if (!approved) {
    return {
      ...base,
      outcome: "awaiting_approval",
      sideEffects: [],
      evidence: [],
    };
  }

  const sideEffects = [];
  const evidence = [];
  if (draft.workRequest?.requested) {
    const effect = {
      type: "demo_document_write",
      status: "started",
      idempotencyKey: "demo-task-1:document",
    };
    sideEffects.push(effect);
    const targetDocument = [
      `Objective: ${draft.workRequest.objective}`,
      "- Confirm scope",
      "- Run checks",
      "- Read the target back",
    ].join("\n");
    const targetReadBack = targetDocument;
    effect.status = "completed";
    effect.contentSha256 = sha256(targetDocument);
    evidence.push({
      type: "target_readback",
      verified: targetReadBack === targetDocument,
      contentSha256: sha256(targetReadBack),
    });
  }

  const sendEffect = {
    type: "demo_message_send",
    status: "started",
    idempotencyKey: "demo-task-1:message",
  };
  sideEffects.push(sendEffect);
  const receipt = await messageAdapter.sendMessage({
    conversationId: inbound.conversationId,
    recipientId: inbound.senderId,
    chatType: inbound.chatType,
    text: draft.reply,
    idempotencyKey: sendEffect.idempotencyKey,
  });
  const verifiedReceipt = messageAdapter.verifySendReceipt(receipt);
  sendEffect.status = "completed";
  evidence.push({ type: "send_readback", ...verifiedReceipt });
  events.push(
    { step: "side_effects", status: "completed" },
    { step: "target_verification", status: "completed" },
  );
  return {
    ...base,
    outcome: "completed",
    sideEffects,
    evidence,
  };
}
