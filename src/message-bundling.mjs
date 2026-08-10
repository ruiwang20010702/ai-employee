function occurredAt(message) {
  const value = message.occurred_at ?? message.create_time ?? message.createTime;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid message timestamp: ${value}`);
  }
  return timestamp;
}

const explicitEarlyFlushPatterns = Object.freeze([
  /^(?:\[紧急\]|【紧急】|紧急\s*[:：]|P[01](?:\s|[:：]))/iu,
  /(?:\[发完\]|【发完】|（发完）|\(发完\)|以上(?:是|为)(?:全部|完整)(?:内容|需求)?|需求描述完毕|可以开始(?:处理|执行)?了)[。.!！]?$/u,
]);

function messageContent(message) {
  return String(
    message.content ??
    message.text ??
    message.messageContent ??
    "",
  ).trim();
}

export function shouldFlushMessageBundleEarly(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const content = messageContent(messages.at(-1));
  return content.length > 0 && explicitEarlyFlushPatterns.some(
    (pattern) => pattern.test(content),
  );
}

export function splitMessageBursts(
  messages,
  { gapMs = 120_000, maxMessages = 20, boundaryAt = null } = {},
) {
  if (!Number.isFinite(gapMs) || gapMs <= 0) {
    throw new Error("gapMs must be a positive number");
  }
  if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) {
    throw new Error("maxMessages must be a positive integer");
  }
  const boundaryTime = boundaryAt == null
    ? null
    : new Date(boundaryAt).getTime();
  if (boundaryAt != null && !Number.isFinite(boundaryTime)) {
    throw new Error("boundaryAt must be a valid timestamp");
  }
  const ordered = [...messages].sort((left, right) => {
    const timeDifference = occurredAt(left) - occurredAt(right);
    if (timeDifference !== 0) return timeDifference;
    return String(left.platform_message_id ?? left.id).localeCompare(
      String(right.platform_message_id ?? right.id),
    );
  });
  const bursts = [];
  for (const message of ordered) {
    const current = bursts.at(-1);
    const previous = current?.at(-1);
    if (
      !current ||
      current.length >= maxMessages ||
      (boundaryTime != null &&
        occurredAt(previous) <= boundaryTime &&
        occurredAt(message) > boundaryTime) ||
      occurredAt(message) - occurredAt(previous) > gapMs
    ) {
      bursts.push([message]);
    } else {
      current.push(message);
    }
  }
  return bursts;
}
