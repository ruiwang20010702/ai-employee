const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;

function contractError(contract, message) {
  const error = new Error(`${contract} contract violation: ${message}`);
  error.code = `AI_EMPLOYEE_${contract.toUpperCase()}_CONTRACT`;
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

export function assertAgentRuntime(runtime) {
  assertObject(runtime, "agent_runtime");
  assertIdentifier(runtime.id, "id", "agent_runtime");
  assertIdentifier(runtime.decisionSource, "decisionSource", "agent_runtime");
  if (runtime.contractVersion !== adapterContractVersion) {
    throw contractError("agent_runtime", `contractVersion must be ${adapterContractVersion}`);
  }
  assertMethods(runtime, ["generateDraft"], "agent_runtime");
  return runtime;
}

export function assertModelProvider(provider) {
  assertObject(provider, "model_provider");
  assertIdentifier(provider.id, "id", "model_provider");
  if (provider.contractVersion !== adapterContractVersion) {
    throw contractError("model_provider", `contractVersion must be ${adapterContractVersion}`);
  }
  assertMethods(provider, ["generateStructured"], "model_provider");
  return provider;
}

export function assertWorkEventAdapter(adapter) {
  assertObject(adapter, "work_event_adapter");
  assertIdentifier(adapter.id, "id", "work_event_adapter");
  assertIdentifier(adapter.platform, "platform", "work_event_adapter");
  if (adapter.contractVersion !== adapterContractVersion) {
    throw contractError("work_event_adapter", `contractVersion must be ${adapterContractVersion}`);
  }
  if (!Array.isArray(adapter.eventTypes) || adapter.eventTypes.length === 0 || adapter.eventTypes.some(
    (type) => typeof type !== "string" || !/^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/u.test(type),
  )) {
    throw contractError("work_event_adapter", "eventTypes must be stable dotted identifiers");
  }
  assertMethods(adapter, ["normalizeEvent", "verifyAuthenticity"], "work_event_adapter");
  return adapter;
}

export function assertWorkspaceAdapter(adapter) {
  assertObject(adapter, "workspace_adapter");
  assertIdentifier(adapter.id, "id", "workspace_adapter");
  assertIdentifier(adapter.platform, "platform", "workspace_adapter");
  if (adapter.contractVersion !== adapterContractVersion) {
    throw contractError("workspace_adapter", `contractVersion must be ${adapterContractVersion}`);
  }
  const capabilities = adapter.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.some(
    (capability) => !["todo", "calendar", "document", "mail"].includes(capability),
  )) {
    throw contractError("workspace_adapter", "capabilities must use the supported workspace ports");
  }
  assertMethods(adapter, ["create", "readBack"], "workspace_adapter");
  return adapter;
}
