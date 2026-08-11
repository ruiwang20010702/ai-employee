import * as Lark from "@larksuiteoapi/node-sdk";

import {
  adapterContractVersion,
  assertMessageAdapter,
  assertNormalizedMessage,
} from "./adapter-contracts.mjs";

function feishuError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw feishuError("FEISHU_EVENT_INVALID", "Feishu " + field + " is required");
  }
  return normalized;
}

function isoFromFeishuTimestamp(value) {
  const raw = requiredText(value, "message.create_time");
  const milliseconds = /^\d+$/u.test(raw)
    ? Number(raw.length <= 10 ? raw + "000" : raw)
    : Date.parse(raw);
  if (!Number.isFinite(milliseconds)) {
    throw feishuError("FEISHU_EVENT_INVALID", "Feishu create_time is invalid");
  }
  return new Date(milliseconds).toISOString();
}

function parseTextContent(content) {
  try {
    const parsed = JSON.parse(requiredText(content, "message.content"));
    return requiredText(parsed?.text, "text content");
  } catch (error) {
    if (error?.code === "FEISHU_EVENT_INVALID") throw error;
    throw feishuError(
      "FEISHU_EVENT_INVALID",
      "Feishu text message content must be valid JSON",
      error,
    );
  }
}

function senderOpenId(sender) {
  return sender?.sender_id?.open_id ?? sender?.id ?? "";
}

function mentionOpenId(mention) {
  return mention?.id?.open_id ?? mention?.id ?? "";
}

function removeSelfMention(text, mentions, selfOpenId) {
  let normalized = text;
  for (const mention of mentions ?? []) {
    if (mentionOpenId(mention) === selfOpenId && mention?.key) {
      normalized = normalized.replaceAll(mention.key, " ");
    }
  }
  return normalized.replace(/\s+/gu, " ").trim();
}

function normalizedChatType(value) {
  if (value === "p2p") return "direct";
  if (value === "group") return "group";
  throw feishuError("FEISHU_EVENT_INVALID", "Unsupported Feishu chat type: " + value);
}

function normalizeFeishuMessageRecord(message, { selfOpenId = "" } = {}) {
  if (message?.msg_type !== "text" && message?.message_type !== "text") {
    throw feishuError(
      "FEISHU_MESSAGE_UNSUPPORTED",
      "Unsupported Feishu message type: " +
        (message?.msg_type ?? message?.message_type ?? "unknown"),
    );
  }
  const mentions = message.mentions ?? [];
  const chatType = normalizedChatType(message.chat_type ?? (message.is_p2p ? "p2p" : "group"));
  const rawContent = message.body?.content ?? message.content;
  const content = removeSelfMention(parseTextContent(rawContent), mentions, selfOpenId);
  if (!content && chatType === "group") {
    throw feishuError(
      "FEISHU_EVENT_IGNORED",
      "Feishu group message contains only the Foursday mention",
    );
  }
  const normalized = {
    id: requiredText(message.message_id, "message_id"),
    senderId: requiredText(senderOpenId(message.sender), "sender open_id"),
    conversationId: requiredText(message.chat_id, "chat_id"),
    content,
    occurredAt: isoFromFeishuTimestamp(message.create_time),
    chatType,
    mentionedSelf: chatType === "group"
      ? mentions.some((mention) => mentionOpenId(mention) === selfOpenId)
      : false,
    isSelf: senderOpenId(message.sender) === selfOpenId,
    platform: "feishu",
    senderUserId: requiredText(senderOpenId(message.sender), "sender open_id"),
    senderName: message.sender?.sender_name ?? "",
    createTime: isoFromFeishuTimestamp(message.create_time),
    raw: message,
  };
  return assertNormalizedMessage(normalized);
}

export function normalizeFeishuEvent(event, { selfOpenId } = {}) {
  const identity = requiredText(selfOpenId, "self open_id");
  if (event?.event_type && event.event_type !== "im.message.receive_v1") {
    throw feishuError(
      "FEISHU_EVENT_UNSUPPORTED",
      "Unsupported Feishu event type: " + event.event_type,
    );
  }
  if (event?.sender?.sender_type !== "user") {
    throw feishuError("FEISHU_EVENT_IGNORED", "Feishu sender is not a user");
  }
  const normalized = normalizeFeishuMessageRecord({
    ...event.message,
    sender: event.sender,
  }, {
    selfOpenId: identity,
  });
  if (normalized.isSelf) {
    throw feishuError("FEISHU_EVENT_IGNORED", "Feishu self message is ignored");
  }
  return {
    ...normalized,
    eventId: requiredText(event.event_id, "event_id"),
  };
}

function successfulResponse(response, operation) {
  if (response?.code !== 0) {
    throw feishuError(
      "FEISHU_API_REJECTED",
      "Feishu " + operation + " rejected with code " + (response?.code ?? "unknown"),
    );
  }
  return response;
}

function evidenceMessageIds(evidence) {
  return new Set(
    (evidence ?? [])
      .flatMap((item) => [item?.messageId, item?.receipt?.messageId])
      .filter(Boolean),
  );
}

export class FeishuAdapter {
  constructor({
    client,
    selfOpenId,
    targetUserIds = null,
    targetGroupIds = null,
  }) {
    this.id = "feishu-open-platform";
    this.platform = "feishu";
    this.deliveryMode = "event";
    this.contractVersion = adapterContractVersion;
    this.client = client;
    this.selfOpenId = requiredText(selfOpenId, "self open_id");
    this.targetUserIds = targetUserIds ? new Set(targetUserIds) : null;
    this.targetGroupIds = targetGroupIds ? new Set(targetGroupIds) : null;
    this.pendingMessages = new Map();
    assertMessageAdapter(this);
  }

  acceptEvent(event) {
    const message = normalizeFeishuEvent(event, { selfOpenId: this.selfOpenId });
    const eligible = message.chatType === "direct"
      ? !this.targetUserIds || this.targetUserIds.has(message.senderId)
      : message.mentionedSelf &&
        (!this.targetGroupIds || this.targetGroupIds.has(message.conversationId));
    const duplicate = this.pendingMessages.has(message.id);
    if (eligible && !duplicate) {
      this.pendingMessages.set(message.id, message);
      if (this.pendingMessages.size > 10_000) {
        this.pendingMessages.delete(this.pendingMessages.keys().next().value);
      }
    }
    return { accepted: eligible, duplicate, message };
  }

  async listMessages({ scope, start = new Date(0), end = new Date() }) {
    const startAt = new Date(start).getTime();
    const endAt = new Date(end).getTime();
    const messages = [...this.pendingMessages.values()].filter((message) => {
      const occurredAt = new Date(message.occurredAt).getTime();
      if (occurredAt < startAt || occurredAt > endAt) return false;
      if (scope?.type === "direct") {
        return message.chatType === "direct" && message.senderId === scope.participantId;
      }
      if (scope?.type === "group") {
        return message.chatType === "group" &&
          message.conversationId === scope.conversationId &&
          message.mentionedSelf;
      }
      throw feishuError("FEISHU_SCOPE_INVALID", "Feishu scope must be direct or group");
    });
    return messages.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  }

  async listConversationHistory({
    conversationId,
    after = null,
    before = new Date(),
    limit = 50,
  }) {
    if (!this.client?.im?.v1?.message?.list) {
      throw feishuError("FEISHU_CLIENT_INVALID", "Feishu message.list client is unavailable");
    }
    const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 5_000);
    const items = [];
    const seenTokens = new Set();
    let pageToken;
    for (let page = 0; page < 100 && items.length < boundedLimit; page += 1) {
      if (pageToken && seenTokens.has(pageToken)) {
        throw feishuError("FEISHU_API_INVALID", "Feishu history page token repeated");
      }
      if (pageToken) seenTokens.add(pageToken);
      const params = {
        container_id_type: "chat",
        container_id: requiredText(conversationId, "conversationId"),
        end_time: String(Math.floor(new Date(before).getTime() / 1000)),
        sort_type: "ByCreateTimeAsc",
        page_size: Math.min(50, boundedLimit - items.length),
      };
      if (after != null) {
        params.start_time = String(Math.floor(new Date(after).getTime() / 1000));
      }
      if (pageToken) params.page_token = pageToken;
      const response = successfulResponse(
        await this.client.im.v1.message.list({ params }),
        "message.list",
      );
      items.push(...(response.data?.items ?? []));
      if (!response.data?.has_more) break;
      pageToken = requiredText(response.data?.page_token, "history page_token");
    }
    return items
      .slice(0, boundedLimit)
      .filter((item) => item.msg_type === "text")
      .map((item) => normalizeFeishuMessageRecord(item, { selfOpenId: this.selfOpenId }));
  }

  async getConversation({ conversationId, before = new Date(), limit = 50 }) {
    return this.listConversationHistory({ conversationId, before, limit });
  }

  async findManualReply({
    conversationId,
    selfIdentityId,
    after,
    now = new Date(),
    automatedSendEvidence = [],
  }) {
    const identity = typeof selfIdentityId === "string"
      ? selfIdentityId.trim()
      : "";
    if (!identity) {
      return { known: false, replied: false, reason: "Feishu self identity is unavailable" };
    }
    if (identity !== this.selfOpenId) {
      return { known: false, replied: false, reason: "Feishu self identity mismatch" };
    }
    const afterAt = new Date(after).getTime();
    if (!Number.isFinite(afterAt)) {
      return { known: false, replied: false, reason: "Source message time is invalid" };
    }
    const knownAutomatedIds = evidenceMessageIds(automatedSendEvidence);
    const messages = await this.listConversationHistory({
      conversationId,
      after,
      before: now,
      limit: 5_000,
    });
    return {
      known: true,
      replied: messages.some((message) =>
        message.senderId === identity &&
        new Date(message.occurredAt).getTime() > afterAt &&
        !knownAutomatedIds.has(message.id)),
    };
  }

  async sendMessage({
    conversationId,
    recipientId,
    chatType,
    text,
    idempotencyKey,
  }) {
    if (!this.client?.im?.v1?.message?.create) {
      throw feishuError("FEISHU_CLIENT_INVALID", "Feishu message.create client is unavailable");
    }
    if (!["direct", "group"].includes(chatType)) {
      throw feishuError("FEISHU_SCOPE_INVALID", "Feishu send chatType must be direct or group");
    }
    if (chatType === "direct" && this.targetUserIds && !this.targetUserIds.has(recipientId)) {
      throw feishuError("FEISHU_SCOPE_REJECTED", "Feishu recipient is not allowlisted");
    }
    if (chatType === "group" && this.targetGroupIds && !this.targetGroupIds.has(conversationId)) {
      throw feishuError("FEISHU_SCOPE_REJECTED", "Feishu group is not allowlisted");
    }
    const receiveId = chatType === "group"
      ? requiredText(conversationId, "conversationId")
      : requiredText(recipientId, "recipientId");
    try {
      const response = successfulResponse(await this.client.im.v1.message.create({
        params: { receive_id_type: chatType === "group" ? "chat_id" : "open_id" },
        data: {
          receive_id: receiveId,
          msg_type: "text",
          content: JSON.stringify({ text: requiredText(text, "message text") }),
          uuid: requiredText(idempotencyKey, "idempotencyKey"),
        },
      }), "message.create");
      const messageId = requiredText(response.data?.message_id, "send message_id");
      return {
        status: "SENT",
        platform: "feishu",
        messageId,
        conversationId: response.data?.chat_id ?? conversationId,
        recipientId,
        chatType,
        text,
        idempotencyKey,
      };
    } catch (error) {
      if (error?.code === "FEISHU_API_REJECTED") throw error;
      throw feishuError(
        "FEISHU_SEND_UNKNOWN",
        "Feishu send outcome is unknown; reconcile by idempotency key before retrying",
        error,
      );
    }
  }

  async verifySendReceipt(receipt) {
    if (receipt?.status !== "SENT" || !receipt?.messageId) {
      throw feishuError("FEISHU_SEND_UNKNOWN", "Feishu send receipt is not verifiable");
    }
    if (!this.client?.im?.v1?.message?.get) {
      throw feishuError("FEISHU_CLIENT_INVALID", "Feishu message.get client is unavailable");
    }
    const response = successfulResponse(await this.client.im.v1.message.get({
      path: { message_id: receipt.messageId },
    }), "message.get");
    const readBack = response.data?.items?.[0];
    const readBackText = readBack?.body?.content ? parseTextContent(readBack.body.content) : "";
    if (
      readBack?.message_id !== receipt.messageId ||
      readBack?.chat_id !== receipt.conversationId ||
      readBackText !== receipt.text
    ) {
      throw feishuError("FEISHU_SEND_UNKNOWN", "Feishu send readback does not match intent");
    }
    return {
      verified: true,
      platform: "feishu",
      messageId: receipt.messageId,
      conversationId: receipt.conversationId,
      text: receipt.text,
    };
  }
}

export function createFeishuLongConnection({
  appId,
  appSecret,
  selfOpenId,
  targetUserIds = [],
  targetGroupIds = [],
  persistMessage,
  sdk = Lark,
  loggerLevel = sdk.LoggerLevel?.info,
}) {
  if (typeof persistMessage !== "function") {
    throw feishuError(
      "FEISHU_PERSISTENCE_REQUIRED",
      "Feishu long connection requires a durable persistMessage callback",
    );
  }
  if (targetUserIds.length === 0 && targetGroupIds.length === 0) {
    throw feishuError(
      "FEISHU_TARGETS_REQUIRED",
      "Feishu long connection requires an explicit user or group allowlist",
    );
  }
  const credentials = {
    appId: requiredText(appId, "appId"),
    appSecret: requiredText(appSecret, "appSecret"),
  };
  const client = new sdk.Client(credentials);
  const adapter = new FeishuAdapter({
    client,
    selfOpenId,
    targetUserIds,
    targetGroupIds,
  });
  const persistenceByMessageId = new Map();
  const dispatcher = new sdk.EventDispatcher({}).register({
    "im.message.receive_v1": async (event) => {
      let accepted;
      try {
        accepted = adapter.acceptEvent(event);
      } catch (error) {
        if (["FEISHU_EVENT_IGNORED", "FEISHU_MESSAGE_UNSUPPORTED"].includes(error?.code)) return;
        throw error;
      }
      if (!accepted.accepted) return;
      if (accepted.duplicate) {
        await persistenceByMessageId.get(accepted.message.id);
        return;
      }
      const persistence = Promise.resolve().then(() => persistMessage(accepted.message));
      persistenceByMessageId.set(accepted.message.id, persistence);
      try {
        await persistence;
      } catch (error) {
        adapter.pendingMessages.delete(accepted.message.id);
        throw error;
      } finally {
        persistenceByMessageId.delete(accepted.message.id);
      }
    },
  });
  const wsClient = new sdk.WSClient({ ...credentials, loggerLevel });
  return {
    adapter,
    wsClient,
    start: () => wsClient.start({ eventDispatcher: dispatcher }),
  };
}
