import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
      senderUserId:
        message.senderUserId ??
        message.sender?.userId ??
        message.sender?.staffId ??
        senderUserId ??
        message.senderOpenDingTalkId ??
        message.sender?.openDingTalkId,
      senderOpenDingTalkId:
        message.senderOpenDingTalkId ?? message.sender?.openDingTalkId,
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

export class DwsAdapter {
  constructor({ dwsPath, dwsMock = false }) {
    this.dwsPath = dwsPath;
    this.dwsMock = dwsMock;
  }

  async run(args, options = {}) {
    const { stdout } = await execFileAsync(
      this.dwsPath,
      [...args, ...(this.dwsMock ? ["--mock"] : []), "--format", "json"],
      {
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
        ...options,
      },
    );
    return JSON.parse(stdout);
  }

  async fetchBySenderAll({ senderUserId, start, end }) {
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
        senderUserId,
        "--start",
        isoWithOffset(start),
        "--end",
        isoWithOffset(end),
        "--limit",
        "50",
        "--cursor",
        cursor,
      ]);
      messages.push(...collectMessages(payload, senderUserId));
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

  async hasManualReply({ conversationId, selfUserId, after, now = new Date() }) {
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
        messageTime > afterTime
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
      "AI 员工回复",
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
      "AI 员工回复",
      "--text",
      text,
      "--uuid",
      idempotencyKey,
      "--ai-tag",
      "-y",
    ]);
  }
}
