import { createHash } from "node:crypto";

function stable(value, depth = 0) {
  if (depth > 12) throw new Error("Work evidence exceeds maximum nesting depth");
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Work evidence contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => stable(item, depth + 1));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Work evidence must be JSON-compatible");
  }
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key], depth + 1)]),
  );
}

export function workEvidenceSha256(evidence) {
  const serialized = JSON.stringify(stable(evidence));
  if (Buffer.byteLength(serialized, "utf8") > 4 * 1024 * 1024) {
    throw new Error("Work evidence exceeds 4 MiB");
  }
  return createHash("sha256").update(serialized).digest("hex");
}

export function workPlanMemoryEvidenceScope({ factKey, stepId, evidence }) {
  const normalizedFactKey = String(factKey ?? "").trim();
  const normalizedStepId = String(stepId ?? "").trim();
  const evidenceKind = String(evidence?.kind ?? "").trim();
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,4}$/u.test(normalizedFactKey)) {
    throw new Error("Project memory evidence requires a valid fact key");
  }
  if (!normalizedStepId || normalizedStepId.length > 100 || !evidenceKind || evidenceKind.length > 100) {
    throw new Error("Project memory requires bounded completed-step evidence");
  }
  return {
    factKey: normalizedFactKey,
    evidenceStepId: normalizedStepId,
    evidenceKind,
    evidenceSha256: workEvidenceSha256(evidence),
  };
}

export function assertWorkPlanMemoryEvidence(scope, { stepId, status, evidence }) {
  const expected = workPlanMemoryEvidenceScope({
    factKey: scope?.factKey,
    stepId,
    evidence,
  });
  if (
    status !== "completed" ||
    scope?.evidenceStepId !== expected.evidenceStepId ||
    scope?.evidenceKind !== expected.evidenceKind ||
    scope?.evidenceSha256 !== expected.evidenceSha256
  ) {
    throw new Error("Work plan memory evidence is not verifiable");
  }
  return expected;
}
