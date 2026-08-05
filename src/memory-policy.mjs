const memoryTypes = new Set([
  "working",
  "project",
  "person",
  "principle",
  "knowledge",
]);
const sensitivities = new Set(["public", "internal", "confidential"]);

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export function validateMemoryProposal(input) {
  const type = required(input?.type, "type");
  if (!memoryTypes.has(type)) throw new Error(`Unsupported memory type: ${type}`);
  const sensitivity = input.sensitivity ?? "internal";
  if (!sensitivities.has(sensitivity)) {
    throw new Error(`Unsupported memory sensitivity: ${sensitivity}`);
  }
  const confidence = input.confidence == null ? 1 : Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("confidence must be between 0 and 1");
  }
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new Error("expiresAt must be a valid timestamp");
  }
  const scope = input.scope ?? {};
  if (!scope || Array.isArray(scope) || typeof scope !== "object") {
    throw new Error("scope must be an object");
  }
  if (
    scope.factKey != null &&
    (typeof scope.factKey !== "string" ||
      !scope.factKey.trim() ||
      scope.factKey.trim().length > 200)
  ) {
    throw new Error("scope.factKey must be a non-empty string up to 200 characters");
  }
  return {
    type,
    subject: required(input.subject, "subject"),
    projectId: input.projectId ? required(input.projectId, "projectId") : null,
    statement: required(input.statement, "statement"),
    sourceType: required(input.sourceType, "sourceType"),
    sourceId: required(input.sourceId, "sourceId"),
    sourceVersion: input.sourceVersion ? String(input.sourceVersion) : null,
    scope: { ...scope, ...(scope.factKey ? { factKey: scope.factKey.trim() } : {}) },
    confidence,
    sensitivity,
    expiresAt,
    createdBy: required(input.createdBy ?? "local-user", "createdBy"),
    supersedesId: input.supersedesId ? String(input.supersedesId) : null,
  };
}

export function memoryIsUsable(memory, now = new Date()) {
  return (
    memory?.status === "confirmed" &&
    !memory.deleted_at &&
    (!memory.expires_at || new Date(memory.expires_at) > now)
  );
}
