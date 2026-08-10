import { createHash } from "node:crypto";

export const erasableTaskStatuses = Object.freeze([
  "completed",
  "no_reply",
  "rejected",
  "cancelled_manual",
  "cancelled_operator",
  "expired",
  "continued",
]);

export const erasableWorkPlanStatuses = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "rejected",
  "superseded",
]);

const selectorKeys = Object.freeze([
  ["personId", "person"],
  ["projectId", "project"],
  ["before", "time"],
]);

function requiredText(value, name, maximum) {
  const normalized = String(value ?? "").trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`Privacy erasure ${name} is invalid`);
  }
  return normalized;
}

export function validatePrivacySelector(input, now = new Date()) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error("Privacy erasure selector must be a JSON object");
  }
  const selected = selectorKeys.filter(([key]) => input[key] != null);
  if (selected.length !== 1 || Object.keys(input).some(
    (key) => !selectorKeys.some(([allowed]) => allowed === key),
  )) {
    throw new Error("Privacy erasure selector requires exactly one of personId, projectId, or before");
  }
  const [key, type] = selected[0];
  if (type === "person") {
    return { type, value: requiredText(input[key], key, 500) };
  }
  if (type === "project") {
    return { type, value: requiredText(input[key], key, 200) };
  }
  const raw = requiredText(input[key], key, 100);
  const value = new Date(raw);
  if (Number.isNaN(value.getTime()) || value.toISOString() !== raw) {
    throw new Error("Privacy erasure before must be an ISO 8601 UTC timestamp");
  }
  if (value >= now) {
    throw new Error("Privacy erasure before must be in the past");
  }
  return { type, value };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

export function buildPrivacyErasurePreview({
  selector,
  selectorFingerprint,
  eligible,
  blocked,
}) {
  const normalizedEligible = Object.fromEntries(
    Object.entries(eligible).map(([key, values]) => [key, [...values].sort()]),
  );
  const normalizedBlocked = Object.fromEntries(
    Object.entries(blocked).map(([key, values]) => [key, [...values].sort()]),
  );
  const counts = Object.fromEntries(
    Object.entries(normalizedEligible).map(([key, values]) => [key, values.length]),
  );
  const blockedCounts = Object.fromEntries(
    Object.entries(normalizedBlocked).map(([key, values]) => [key, values.length]),
  );
  const eligibleTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const blockedTotal = Object.values(blockedCounts).reduce((sum, count) => sum + count, 0);
  const snapshot = {
    version: 1,
    selector: {
      type: selector.type,
      fingerprint: selectorFingerprint,
    },
    eligible: normalizedEligible,
    blocked: normalizedBlocked,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(stable(snapshot)))
    .digest("hex");
  return {
    selector: snapshot.selector,
    counts,
    blocked: blockedCounts,
    eligibleTotal,
    blockedTotal,
    confirmation:
      eligibleTotal > 0 && blockedTotal === 0
        ? `ERASE-${digest.slice(0, 16).toUpperCase()}`
        : null,
    snapshotDigest: digest,
    warning: blockedTotal > 0
      ? "Active or unresolved records must be completed or cancelled before erasure."
      : eligibleTotal > 0
        ? "This permanently erases business content and cannot be undone."
        : "No matching business data is eligible for erasure.",
  };
}

export function privacySelectorFingerprint(cipher, selector) {
  const value = selector.type === "time"
    ? selector.value.toISOString()
    : selector.value;
  return cipher.fingerprint(`privacy:${selector.type}:${value}`).slice(0, 24);
}

export function jsonContainsAny(value, needles) {
  if (value == null) return false;
  if (["string", "number", "boolean"].includes(typeof value)) {
    return needles.has(String(value));
  }
  if (Array.isArray(value)) return value.some((item) => jsonContainsAny(item, needles));
  if (typeof value === "object") {
    return Object.values(value).some((item) => jsonContainsAny(item, needles));
  }
  return false;
}
