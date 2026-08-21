const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;

function contractError(contract, message) {
  const error = new Error(`${contract} contract violation: ${message}`);
  error.code = `FOURSDAY_${contract.toUpperCase()}_CONTRACT`;
  return error;
}

function assertObject(value, contract) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(contract, "adapter must be an object");
  }
}

function assertIdentifier(value, field, contract) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw contractError(contract, `${field} must be a stable lowercase identifier`);
  }
}

function assertMethods(value, methods, contract) {
  for (const method of methods) {
    if (typeof value[method] !== "function") {
      throw contractError(contract, `missing method: ${method}`);
    }
  }
}

export const adapterContractVersion = "1.0";

export function assertNormalizedMessage(message) {
  assertObject(message, "message");
  for (const field of ["id", "senderId", "conversationId", "content", "occurredAt"]) {
    if (typeof message[field] !== "string" || message[field].trim() === "") {
      throw contractError("message", `${field} is required`);
    }
  }
  if (!["direct", "group"].includes(message.chatType)) {
    throw contractError("message", "chatType must be direct or group");
  }
  if (message.chatType === "group" && typeof message.mentionedSelf !== "boolean") {
    throw contractError("message", "group messages must declare mentionedSelf");
  }
  if (Number.isNaN(new Date(message.occurredAt).getTime())) {
    throw contractError("message", "occurredAt must be a valid timestamp");
  }
  return message;
}

export function assertMessageAdapter(adapter) {
  assertObject(adapter, "message_adapter");
  assertIdentifier(adapter.id, "id", "message_adapter");
  assertIdentifier(adapter.platform, "platform", "message_adapter");
  if (adapter.contractVersion !== adapterContractVersion) {
    throw contractError("message_adapter", `contractVersion must be ${adapterContractVersion}`);
  }
  if (!["pull", "event", "demo"].includes(adapter.deliveryMode)) {
    throw contractError("message_adapter", "deliveryMode must be pull, event, or demo");
  }
  assertMethods(adapter, [
    "listMessages",
    "getConversation",
    "findManualReply",
    "sendMessage",
    "verifySendReceipt",
  ], "message_adapter");
  return adapter;
}
