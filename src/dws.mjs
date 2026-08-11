import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { adapterContractVersion, assertNormalizedMessage } from "./adapter-contracts.mjs";
import { safeCodexEnvironment } from "./codex-environment.mjs";

const execFileAsync = promisify(execFile);

function localTimestamp(date) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function isoWithOffset(date) {
  return `${localTimestamp(date).replace(" ", "T")}+08:00`;
}

export function normalizeDwsIdentity(value) {
  const normalized = String(value ?? "").trim();
  return normalized === "" ? null : normalized;
}

export function collectMessages(payload, senderUserId) {
  const result = payload?.result ?? payload ?? {};
  const conversations =
    result.conversationMessagesList ?? payload?.conversationMessagesList ?? [];
  const nested = conversations.flatMap((conversation) =>
    (conversation.messages ?? []).map((message) => ({
      ...message,
      singleChat: conversation.singleChat,
      conversationTitle: conversation.title,
      openConversationId:
        message.openConversationId ?? conversation.openConversationId,
    })),
  );
  const direct = Array.isArray(result) ? result : result.messages ?? [];
  return [...nested, ...direct]
    .map((message) => ({
      id: message.openMessageId ?? message.messageId ?? message.id,
      senderUserId: normalizeDwsIdentity(
        message.senderUserId ??
        message.sender?.userId ??
        message.sender?.staffId ??
        senderUserId ??
        message.senderOpenDingTalkId ??
        message.sender?.openDingTalkId,
      ),
      senderOpenDingTalkId: normalizeDwsIdentity(
        message.senderOpenDingTalkId ?? message.sender?.openDingTalkId,
      ),
      senderName:
        typeof message.sender === "string"
          ? message.sender
          : message.senderName ?? message.sender?.name,
      conversationId:
        message.openConversationId ??
        message.conversationId ??
        message.openCid,
      singleChat: message.singleChat,
      createTime:
        message.createTime ?? message.createdAt ?? message.sendTime ?? "",
      content:
        typeof message.content === "string"
          ? message.content
          : message.content?.text ?? JSON.stringify(message.content ?? ""),
      isSelf:
        message.isSelf === true ||
        message.direction === "outgoing" ||
        message.sendType === "send",
      raw: message,
    }))
    .filter((message) => message.id && message.conversationId);
}

export function bindMessagesToSender(messages, senderUserId) {
  const expectedSenderUserId = normalizeDwsIdentity(senderUserId);
  if (!expectedSenderUserId) {
    const error = new Error("DWS list-by-sender requires a sender identity");
    error.code = "dws_sender_identity_required";
    throw error;
  }
  return messages.map((message) => {
    if (normalizeDwsIdentity(message.senderUserId) !== expectedSenderUserId) {
      const error = new Error(
        "DWS list-by-sender returned a message for a different sender",
      );
      error.code = "dws_sender_identity_mismatch";
      throw error;
    }
    return { ...message, senderUserId: expectedSenderUserId };
  });
}

export function normalizeDwsMessage(message, { mentionedSelf = false } = {}) {
  const chatType = message.singleChat === false ? "group" : "direct";
  const occurredAt = new Date(message.createTime).toISOString();
  const normalized = {
    id: String(message.id ?? ""),
    senderId: normalizeDwsIdentity(message.senderUserId) ?? "",
    conversationId: String(message.conversationId ?? ""),
    content: String(message.content ?? ""),
    occurredAt,
    chatType,
    mentionedSelf: chatType === "group" ? mentionedSelf : undefined,
    isSelf: message.isSelf === true,
    platform: "dingtalk",
    raw: message.raw,
  };
  assertNormalizedMessage(normalized);
  return {
    ...message,
    ...normalized,
    senderUserId: normalized.senderId,
    createTime: normalized.occurredAt,
    singleChat: normalized.chatType === "direct",
  };
}

export function assertSuccessfulSendReceipt(receipt) {
  const values = [];
  const addKnownReceiptFields = (value) => {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return;
    for (const key of ["sendStatus", "send_status", "status", "success"]) {
      if (Object.hasOwn(value, key)) values.push({ key, value: value[key] });
    }
  };
  addKnownReceiptFields(receipt);
  if (Array.isArray(receipt?.result)) {
    for (const item of receipt.result) addKnownReceiptFields(item);
  } else {
    addKnownReceiptFields(receipt?.result);
  }

  const explicitFailure = values.some(({ key, value }) => (
    (key === "success" && value !== true) ||
    (key !== "success" && /^(?:FAIL|FAILED|ERROR|REJECTED|CANCELLED)$/iu.test(String(value)))
  ));
  const explicitSuccess = values.some(({ key, value }) => (
    (key === "success" && value === true) ||
    (key !== "success" && /^(?:SUCCESS|SENT|DELIVERED)$/iu.test(String(value)))
  ));
  if (explicitFailure || !explicitSuccess) {
    const error = new Error("DWS send did not return an explicit success receipt");
    error.code = explicitFailure ? "dws_send_failed" : "dws_send_receipt_unknown";
    throw error;
  }
  return receipt;
}

function pagination(payload) {
  const result = payload?.result ?? payload ?? {};
  const nextCursor =
    result.nextCursor ?? result.next_cursor ?? payload?.nextCursor ?? null;
  const hasMore =
    result.hasMore ?? result.has_more ?? payload?.hasMore ?? nextCursor != null;
  return {
    hasMore: Boolean(hasMore) && String(nextCursor ?? "") !== "",
    nextCursor: nextCursor == null ? null : String(nextCursor),
  };
}

function epoch(value) {
  if (typeof value === "number") {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== "") {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizedText(value) {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim();
}

function explicitAiMarker(raw) {
  const values = [
    raw?.aiTag,
    raw?.ai_tag,
    raw?.isAiGenerated,
    raw?.aiGenerated,
    raw?.generatedByAi,
  ];
  return values.some((value) =>
    value === true || value === 1 || String(value).toLowerCase() === "true",
  );
}

function evidenceMarkerValues(evidence) {
  const values = new Set([evidence.taskId, evidence.idempotencyKey]);
  const visit = (value, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        typeof child === "string" &&
        /(?:message|msg|task|query|process|uuid|idempotency).*(?:id|key)|^(?:openTaskId|openMessageId|processQueryKey|uuid)$/iu.test(key)
      ) {
        values.add(child);
      }
      visit(child, depth + 1);
    }
  };
  visit(evidence.receipt);
  return values;
}

function rawMarkerValues(raw) {
  const values = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 3 || value == null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        typeof child === "string" &&
        /(?:message|msg|task|query|process|uuid|idempotency).*(?:id|key)|^(?:openTaskId|openMessageId|processQueryKey|uuid)$/iu.test(key)
      ) {
        values.add(child);
      }
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  };
  visit(raw);
  return values;
}

export function isAutomatedSelfMessage(message, evidence = []) {
  if (explicitAiMarker(message?.raw)) return true;
  const messageTime = epoch(message?.createTime);
  const messageMarkers = new Set([message?.id, ...rawMarkerValues(message?.raw)]);
  for (const item of evidence) {
    if (item.conversationId !== message?.conversationId) continue;
    const knownMarkers = evidenceMarkerValues(item);
    if ([...messageMarkers].some((value) => value && knownMarkers.has(value))) {
      return true;
    }
    const startedAt = epoch(item.startedAt);
    if (
      messageTime != null &&
      startedAt != null &&
      messageTime >= startedAt - 5_000 &&
      messageTime <= startedAt + 10 * 60 * 1_000 &&
      normalizedText(message?.content) !== "" &&
      normalizedText(message?.content) === normalizedText(item.content)
    ) {
      return true;
    }
  }
  return false;
}

export class DwsAdapter {
  constructor({
    dwsPath,
    dwsMock = false,
    commandRunner = execFileAsync,
    environment = process.env,
  }) {
    this.id = "dingtalk-dws";
    this.platform = "dingtalk";
    this.deliveryMode = "pull";
    this.contractVersion = adapterContractVersion;
    this.dwsPath = dwsPath;
    this.dwsMock = dwsMock;
    this.commandRunner = commandRunner;
    this.environment = environment;
  }

  async run(args, options = {}) {
    const { env: ignoredEnvironment, ...commandOptions } = options;
    const { stdout } = await this.commandRunner(
      this.dwsPath,
      [...args, ...(this.dwsMock ? ["--mock"] : []), "--format", "json"],
      {
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
        ...commandOptions,
        env: safeCodexEnvironment(this.dwsPath, this.environment),
      },
    );
    return JSON.parse(stdout);
  }

  async fetchBySenderAll({ senderUserId, start, end }) {
    const expectedSenderUserId = normalizeDwsIdentity(senderUserId);
    if (!expectedSenderUserId) {
      const error = new Error("DWS list-by-sender requires a sender identity");
      error.code = "dws_sender_identity_required";
      throw error;
    }
    const messages = [];
    const seenCursors = new Set();
    let cursor = "0";

    for (let page = 0; page < 100; page += 1) {
      if (seenCursors.has(cursor)) {
        throw new Error(`DWS pagination cursor repeated: ${cursor}`);
      }
      seenCursors.add(cursor);
      const payload = await this.run([
        "chat",
        "message",
        "list-by-sender",
        "--sender-user-id",
        expectedSenderUserId,
        "--start",
        isoWithOffset(start),
        "--end",
        isoWithOffset(end),
        "--limit",
        "50",
        "--cursor",
        cursor,
      ]);
      messages.push(
        ...bindMessagesToSender(
          collectMessages(payload, expectedSenderUserId),
          expectedSenderUserId,
        ),
      );
      const pageInfo = pagination(payload);
      if (!pageInfo.hasMore) return messages;
      cursor = pageInfo.nextCursor;
    }
    throw new Error("DWS pagination exceeded 100 pages");
  }

  async fetchBySender({ senderUserId, start, end }) {
    return (await this.fetchBySenderAll({ senderUserId, start, end })).filter(
      (message) => message.singleChat !== false,
    );
  }

  async fetchGroupMentions({ groupIds, start, end }) {
    if (!Array.isArray(groupIds) || groupIds.length === 0) return [];
    const messages = [];
    const seenCursors = new Set();
    let cursor = "0";

    for (let page = 0; page < 100; page += 1) {
      if (seenCursors.has(cursor)) {
        throw new Error(`DWS pagination cursor repeated: ${cursor}`);
      }
      seenCursors.add(cursor);
      const payload = await this.run([
        "chat",
        "message",
        "search-advanced",
        "--at-me",
        "--conversation-ids",
        groupIds.join(","),
        "--start",
        isoWithOffset(start),
        "--end",
        isoWithOffset(end),
        "--limit",
        "50",
        "--cursor",
        cursor,
      ]);
      messages.push(
        ...collectMessages(payload, null).filter(
          (message) =>
            message.singleChat === false &&
            groupIds.includes(message.conversationId) &&
            !message.isSelf,
        ),
      );
      const pageInfo = pagination(payload);
      if (!pageInfo.hasMore) return messages;
      cursor = pageInfo.nextCursor;
    }
    throw new Error("DWS pagination exceeded 100 pages");
  }

  async fetchDirect({ userId, before = new Date(), limit = 30 }) {
    const identityFlag = /^DT[A-Za-z0-9]/.test(String(userId))
      ? "--open-dingtalk-id"
      : "--user";
    const payload = await this.run([
      "chat",
      "message",
      "list-direct",
      identityFlag,
      userId,
      "--time",
      localTimestamp(before),
      "--forward",
      "false",
      "--limit",
      String(limit),
    ]);
    return collectMessages(payload, userId).sort((a, b) =>
      String(a.createTime).localeCompare(String(b.createTime)),
    );
  }

  async hasManualReply({
    conversationId,
    selfUserId,
    after,
    now = new Date(),
    automatedSendEvidence = [],
  }) {
    if (!selfUserId) {
      return {
        known: false,
        replied: false,
        reason: "DINGTALK_SELF_USER_ID is not configured",
      };
    }
    if (!conversationId) {
      return {
        known: false,
        replied: false,
        reason: "Conversation ID is not available",
      };
    }
    const afterTime = epoch(after);
    if (afterTime == null) {
      return {
        known: false,
        replied: false,
        reason: "Source message time is invalid",
      };
    }
    const messages = await this.fetchBySenderAll({
      senderUserId: selfUserId,
      start: new Date(afterTime),
      end: now,
    });
    const replied = messages.some((message) => {
      const messageTime = epoch(message.createTime);
      return (
        message.conversationId === conversationId &&
        messageTime != null &&
        messageTime > afterTime &&
        !isAutomatedSelfMessage(message, automatedSendEvidence)
      );
    });
    return { known: true, replied };
  }

  async sendText({ userId, text, idempotencyKey }) {
    const identityFlag = /^DT[A-Za-z0-9]/.test(String(userId))
      ? "--open-dingtalk-id"
      : "--user";
    return this.run([
      "chat",
      "message",
      "send",
      identityFlag,
      userId,
      "--title",
      "Foursday 回复",
      "--text",
      text,
      "--uuid",
      idempotencyKey,
      "--ai-tag",
      "-y",
    ]);
  }

  async sendGroupText({ groupId, text, idempotencyKey }) {
    return this.run([
      "chat",
      "message",
      "send",
      "--group",
      groupId,
      "--title",
      "Foursday 回复",
      "--text",
      text,
      "--uuid",
      idempotencyKey,
      "--ai-tag",
      "-y",
    ]);
  }

  async listMessages({ scope, start, end }) {
    if (scope?.type === "direct") {
      return (await this.fetchBySender({
        senderUserId: scope.participantId,
        start,
        end,
      })).map((message) => normalizeDwsMessage(message));
    }
    if (scope?.type === "group") {
      return (await this.fetchGroupMentions({
        groupIds: [scope.conversationId],
        start,
        end,
      })).map((message) => normalizeDwsMessage(message, { mentionedSelf: true }));
    }
    throw new Error("DWS message scope must be direct or group");
  }

  async getConversation({ participantId, before, limit }) {
    return (await this.fetchDirect({
      userId: participantId,
      before,
      limit,
    })).map((message) => normalizeDwsMessage(message));
  }

  async findManualReply({
    conversationId,
    selfIdentityId,
    after,
    now,
    automatedSendEvidence,
  }) {
    return this.hasManualReply({
      conversationId,
      selfUserId: selfIdentityId,
      after,
      now,
      automatedSendEvidence,
    });
  }

  async sendMessage({
    conversationId,
    recipientId,
    chatType,
    text,
    idempotencyKey,
  }) {
    if (chatType === "group") {
      return this.sendGroupText({
        groupId: conversationId,
        text,
        idempotencyKey,
      });
    }
    if (chatType !== "direct") {
      throw new Error("DWS send chatType must be direct or group");
    }
    return this.sendText({
      userId: recipientId,
      text,
      idempotencyKey,
    });
  }

  verifySendReceipt(receipt) {
    return assertSuccessfulSendReceipt(receipt);
  }
}
