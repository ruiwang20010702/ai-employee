function occurredAt(message) {
  const value = message.occurred_at ?? message.create_time ?? message.createTime;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid message timestamp: ${value}`);
  }
  return timestamp;
}

export function splitMessageBursts(
  messages,
  { gapMs = 120_000, maxMessages = 20 } = {},
) {
  if (!Number.isFinite(gapMs) || gapMs <= 0) {
    throw new Error("gapMs must be a positive number");
  }
  if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) {
    throw new Error("maxMessages must be a positive integer");
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
      occurredAt(message) - occurredAt(previous) > gapMs
    ) {
      bursts.push([message]);
    } else {
      current.push(message);
    }
  }
  return bursts;
}
