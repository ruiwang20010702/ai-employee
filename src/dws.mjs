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
    .map((message) => {
      const payloadSenderUserId = normalizeDwsIdentity(
        message.senderUserId ??
        message.sender?.userId ??
        message.sender?.staffId,
      );
      const openDingTalkId = normalizeDwsIdentity(
        message.senderOpenDingTalkId ?? message.sender?.openDingTalkId,
      );
      return {
        id: message.openMessageId ?? message.messageId ?? message.id,
        senderUserId: payloadSenderUserId ??
          normalizeDwsIdentity(senderUserId) ?? openDingTalkId,
        senderOpenDingTalkId: openDingTalkId,
        senderIdentitySource: payloadSenderUserId
          ? "payload_user_id"
          : normalizeDwsIdentity(senderUserId)
            ? "query_fallback"
            : openDingTalkId
              ? "payload_open_id"
              : "missing",
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
        isWithdrawn:
          message.isWithdrawn === true ||
          message.recalled === true ||
          message.revoked === true ||
          /^(?:RECALLED|REVOKED|WITHDRAWN)$/iu.test(String(message.status ?? "")),
        withdrawnAt:
          message.withdrawnAt ?? message.recalledAt ?? message.revokedAt ?? null,
        raw: message,
      };
    })
    .filter((message) => message.id && message.conversationId);
}

export function bindMessagesToSender(
  messages,
  senderUserId,
  expectedOpenDingTalkId = null,
) {
  const expectedSenderUserId = normalizeDwsIdentity(senderUserId);
  const expectedOpenId = normalizeDwsIdentity(expectedOpenDingTalkId);
  if (!expectedSenderUserId) {
    const error = new Error("DWS list-by-sender requires a sender identity");
    error.code = "dws_sender_identity_required";
    throw error;
  }
  return messages.map((message) => {
    const actualSender = message.senderIdentitySource === "query_fallback"
      ? null
      : normalizeDwsIdentity(message.senderUserId);
    const actualOpenId = normalizeDwsIdentity(message.senderOpenDingTalkId);
    if (
      actualSender !== expectedSenderUserId &&
      (!expectedOpenId || actualOpenId !== expectedOpenId)
    ) {
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
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+/gu, " ")
    .trim();
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
    this.selfApprovalIdentity = null;
    this.userIdentityCache = new Map();
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
    let expectedOpenDingTalkId = this.userIdentityCache.get(
      expectedSenderUserId,
    ) ?? null;
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
      const pageMessages = collectMessages(payload);
      const messagesNeedingOpenIdentity = pageMessages.filter(
        (message) => message.senderIdentitySource !== "payload_user_id",
      );
      if (!expectedOpenDingTalkId && messagesNeedingOpenIdentity.length > 0) {
        const names = [...new Set(messagesNeedingOpenIdentity.map((message) =>
          String(message.senderName ?? "").trim()
        ).filter(Boolean))];
        if (names.length !== 1) {
          const error = new Error("DWS sender display name is ambiguous or unavailable");
          error.code = "dws_contact_identity_unavailable";
          throw error;
        }
        expectedOpenDingTalkId = await this.resolveUserOpenDingTalkId(
          expectedSenderUserId,
          names[0],
        );
      }
      messages.push(
        ...bindMessagesToSender(
          pageMessages,
          expectedSenderUserId,
          expectedOpenDingTalkId,
        ),
      );
      const pageInfo = pagination(payload);
      if (!pageInfo.hasMore) return messages;
      cursor = pageInfo.nextCursor;
    }
    throw new Error("DWS pagination exceeded 100 pages");
  }

  async resolveUserOpenDingTalkId(expectedUserId, displayName = null) {
    const userId = normalizeDwsIdentity(expectedUserId);
    if (!userId) {
      const error = new Error("DWS contact identity requires a user ID");
      error.code = "dws_contact_identity_required";
      throw error;
    }
    if (this.userIdentityCache.has(userId)) {
      return this.userIdentityCache.get(userId);
    }
    let payload;
    try {
      payload = await this.run([
        "contact",
        "user",
        "get",
        "--ids",
        userId,
      ]);
    } catch (error) {
      const name = String(displayName ?? "").trim();
      if (!name) throw error;
      payload = await this.run([
        "contact",
        "user",
        "search",
        "--query",
        name,
      ]);
    }
    const candidates = Array.isArray(payload?.result)
      ? payload.result
      : Array.isArray(payload?.items)
        ? payload.items
        : payload?.result && typeof payload.result === "object"
          ? [payload.result]
          : [];
    const exact = candidates.filter((candidate) =>
      normalizeDwsIdentity(
        candidate?.userId ?? candidate?.orgEmployeeModel?.userId,
      ) === userId
    );
    const openDingTalkId = normalizeDwsIdentity(
      exact[0]?.openDingTalkId ??
      exact[0]?.openDingtalkId ??
      exact[0]?.orgEmployeeModel?.openDingTalkId,
    );
    if (exact.length !== 1 || !openDingTalkId) {
      const error = new Error("DWS contact identity is ambiguous or unavailable");
      error.code = "dws_contact_identity_unavailable";
      throw error;
    }
    this.userIdentityCache.set(userId, openDingTalkId);
    return openDingTalkId;
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

  async fetchDirect({
    userId,
    identityKind = null,
    before = new Date(),
    limit = 30,
    lookbackMs = 2 * 60 * 60 * 1_000,
  }) {
    const beforeTime = epoch(before);
    if (beforeTime == null) throw new Error("DWS direct context cutoff is invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("DWS direct context limit must be between 1 and 50");
    }
    if (!Number.isSafeInteger(lookbackMs) || lookbackMs < 60_000 || lookbackMs > 24 * 60 * 60 * 1_000) {
      throw new Error("DWS direct context lookback must be between 1 minute and 24 hours");
    }
    if (identityKind != null && !["open_dingtalk_id", "user_id"].includes(identityKind)) {
      throw new Error("DWS direct context identity kind is invalid");
    }
    const identityFlag = identityKind === "open_dingtalk_id"
      ? "--open-dingtalk-id"
      : identityKind === "user_id"
        ? "--user"
        : /^DT[A-Za-z0-9]/.test(String(userId))
          ? "--open-dingtalk-id"
          : "--user";
    const queryLimit = Math.min(200, Math.max(limit, limit * 4));
    const payload = await this.run([
      "chat",
      "message",
      "list-direct",
      identityFlag,
      userId,
      "--time",
      localTimestamp(new Date(beforeTime - lookbackMs)),
      "--forward",
      "true",
      "--limit",
      String(queryLimit),
    ]);
    return collectMessages(payload, userId)
      .filter((message) => {
        const createdAt = epoch(message.createTime);
        return createdAt != null && createdAt <= beforeTime + 999;
      })
      .sort((a, b) => String(a.createTime).localeCompare(String(b.createTime)))
      .slice(-limit);
  }

  async resolveSelfApprovalIdentity(expectedUserId) {
    if (this.selfApprovalIdentity?.userId === expectedUserId) {
      return this.selfApprovalIdentity.openDingTalkId;
    }
    const self = await this.run(["contact", "user", "get-self"]);
    const employee = self?.result?.[0]?.orgEmployeeModel;
    if (!employee?.userId || employee.userId !== expectedUserId || !employee.orgUserName) {
      throw new Error("DWS current user does not match the configured approval owner");
    }
    const search = await this.run([
      "contact",
      "user",
      "search",
      "--query",
      employee.orgUserName,
    ]);
    const candidates = search?.result ?? search?.items ?? [];
    const exact = candidates.filter((candidate) =>
      (candidate.userId ?? candidate.orgEmployeeModel?.userId) === expectedUserId
    );
    const openDingTalkId = exact[0]?.openDingTalkId ??
      exact[0]?.openDingtalkId ?? exact[0]?.orgEmployeeModel?.openDingTalkId;
    if (exact.length !== 1 || !openDingTalkId) {
      throw new Error("DWS approval owner identity is ambiguous or unavailable");
    }
    this.selfApprovalIdentity = { userId: expectedUserId, openDingTalkId };
    return openDingTalkId;
  }

  async sendMobileApproval({ selfUserId, text, idempotencyKey }) {
    const receiver = await this.resolveSelfApprovalIdentity(selfUserId);
    return this.run([
      "chat",
      "message",
      "send",
      "--open-dingtalk-id",
      receiver,
      "--title",
      "Foursday 待审批",
      "--text",
      text,
      "--uuid",
      idempotencyKey,
      "--ai-tag",
      "-y",
    ]);
  }

  async fetchMobileApprovalMessages({ selfUserId, start, end }) {
    const receiver = await this.resolveSelfApprovalIdentity(selfUserId);
    const payload = await this.run([
      "chat",
      "message",
      "list-direct",
      "--open-dingtalk-id",
      receiver,
      "--time",
      localTimestamp(start),
      "--forward",
      "true",
      "--limit",
      "50",
    ]);
    const startTime = epoch(start);
    const endTime = epoch(end);
    return collectMessages(payload, null)
      .filter((message) => {
        const createdAt = epoch(message.createTime);
        const senderMatches = normalizeDwsIdentity(message.senderUserId) === selfUserId ||
          normalizeDwsIdentity(message.senderOpenDingTalkId) === receiver;
        return senderMatches && createdAt != null &&
          createdAt > startTime && createdAt <= endTime + 999;
      })
      .map((message) => ({ ...message, approvalOwnerVerified: true }))
      .sort((left, right) => String(left.createTime).localeCompare(String(right.createTime)));
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

  async sendText({ userId, identityKind = null, text, idempotencyKey }) {
    if (identityKind != null && !["open_dingtalk_id", "user_id"].includes(identityKind)) {
      throw new Error("DWS send identity kind is invalid");
    }
    const identityFlag = identityKind === "open_dingtalk_id"
      ? "--open-dingtalk-id"
      : identityKind === "user_id"
        ? "--user"
        : /^DT[A-Za-z0-9]/.test(String(userId))
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

  async getConversation({ participantId, before, limit, lookbackMs }) {
    return (await this.fetchDirect({
      userId: participantId,
      before,
      limit,
      lookbackMs,
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
    recipientKind = null,
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
      identityKind: recipientKind,
      text,
      idempotencyKey,
    });
  }

  verifySendReceipt(receipt) {
    return assertSuccessfulSendReceipt(receipt);
  }
}
