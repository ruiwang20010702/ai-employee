import { createHash } from "node:crypto";
import { readGbrainPage } from "./gbrain-page.mjs";
import {
  isManagedMemoryAuthority,
  parseAuthorityStatement,
} from "./memory-authority.mjs";

const sourceAccessStatuses = new Set([
  "not_required",
  "unverified",
  "verified",
  "unavailable",
  "revoked",
]);

export function validateSourceAccessChange(change) {
  if (!change || !sourceAccessStatuses.has(change.status)) {
    throw new Error("Invalid memory source access status");
  }
  const checkedAt = new Date(change.checkedAt);
  if (Number.isNaN(checkedAt.getTime())) {
    throw new Error("Invalid memory source access check time");
  }
  const expiresAt = change.expiresAt ? new Date(change.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new Error("Invalid memory source access expiry");
  }
  if (change.status === "verified" && (!expiresAt || expiresAt <= checkedAt)) {
    throw new Error("Verified memory source access requires a future expiry");
  }
  const reason = String(change.reason ?? "").trim();
  if (!reason || reason.length > 100 || !/^[a-z0-9_]+$/u.test(reason)) {
    throw new Error("Memory source access reason must be a stable code");
  }
  const sourceVersion = change.sourceVersion == null
    ? null
    : String(change.sourceVersion).trim();
  if (sourceVersion != null && (!sourceVersion || sourceVersion.length > 300)) {
    throw new Error("Memory source version must be 1-300 characters");
  }
  return {
    status: change.status,
    reason,
    checkedAt,
    expiresAt: change.status === "verified" ? expiresAt : null,
    sourceVersion: change.status === "verified" ? sourceVersion : null,
  };
}

function denied(status, reason, checkedAt) {
  return validateSourceAccessChange({ status, reason, checkedAt });
}

function normalizedSourceVersion(value) {
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T/u.test(text)) {
    const timestamp = new Date(text);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
  }
  return text;
}

export async function checkMemorySourceAccess(
  memory,
  {
    projects,
    gbrainPath = "gbrain",
    now = new Date(),
    leaseMs = 15 * 60 * 1000,
    readPage = readGbrainPage,
  },
) {
  const checkedAt = new Date(now);
  if (memory.source_type !== "gbrain") {
    return denied("not_required", "source_not_live_checked", checkedAt);
  }
  const slug = String(memory.source_id ?? "");
  const managedAuthority = isManagedMemoryAuthority(memory);
  let rule;
  if (managedAuthority) {
    rule = {
      expiresAt: null,
      timeoutMs: 30_000,
      maxContentBytes: 256 * 1024,
    };
  } else {
    const project = projects.get(memory.project_id);
    if (!project) return denied("revoked", "project_not_authorized", checkedAt);
    rule = project.capabilities?.knowledge_read;
    if (!rule || rule.mode === "disabled") {
      return denied("revoked", "knowledge_read_disabled", checkedAt);
    }
    if (rule.expiresAt && new Date(rule.expiresAt) <= checkedAt) {
      return denied("revoked", "knowledge_read_expired", checkedAt);
    }
    if (
      !slug ||
      !rule.allowedSlugPrefixes?.some(
        (prefix) => slug.startsWith(prefix) && slug.length > prefix.length,
      )
    ) {
      return denied("revoked", "slug_outside_project", checkedAt);
    }
  }
  if (!Number.isFinite(leaseMs) || leaseMs < 600_000 || leaseMs > 3_600_000) {
    throw new Error("Memory source access lease must be 10-60 minutes");
  }
  let page;
  try {
    page = await readPage(gbrainPath, slug, {
      timeoutMs: rule.timeoutMs ?? 30_000,
      maxBuffer: rule.maxContentBytes + 1024 * 1024,
      sourceId: managedAuthority
        ? memory.scope?.authority?.sourceId
        : null,
    });
  } catch {
    return denied("unavailable", "source_unavailable", checkedAt);
  }
  if (typeof page.content !== "string" || !page.content.trim()) {
    return denied("unavailable", "source_unavailable", checkedAt);
  }
  if (Buffer.byteLength(page.content) > rule.maxContentBytes) {
    return denied("unavailable", "source_content_exceeded", checkedAt);
  }
  if (managedAuthority) {
    try {
      if (parseAuthorityStatement(page.content) !== memory.statement.trim()) {
        return denied("unavailable", "authority_statement_changed", checkedAt);
      }
    } catch {
      return denied("unavailable", "authority_content_invalid", checkedAt);
    }
    const expectedDigest = memory.scope?.authority?.contentSha256;
    if (
      !/^[a-f0-9]{64}$/u.test(String(expectedDigest ?? "")) ||
      createHash("sha256").update(page.content).digest("hex") !== expectedDigest
    ) {
      return denied("unavailable", "authority_content_changed", checkedAt);
    }
  }
  const liveVersion = page.updatedAt == null
    ? `sha256:${createHash("sha256").update(page.content).digest("hex")}`
    : normalizedSourceVersion(page.updatedAt);
  if (
    memory.source_version &&
    normalizedSourceVersion(memory.source_version) !== liveVersion
  ) {
    return denied("unavailable", "source_version_changed", checkedAt);
  }
  const requestedExpiry = new Date(checkedAt.getTime() + leaseMs);
  const authorizationExpiry = rule.expiresAt ? new Date(rule.expiresAt) : null;
  return validateSourceAccessChange({
    status: "verified",
    reason: "exact_source_verified",
    checkedAt,
    expiresAt:
      authorizationExpiry && authorizationExpiry < requestedExpiry
        ? authorizationExpiry
        : requestedExpiry,
    sourceVersion: liveVersion,
  });
}

export async function reconcileMemorySources({
  store,
  projects,
  gbrainPath = "gbrain",
  now = new Date(),
  leaseMs = 15 * 60 * 1000,
  readPage = readGbrainPage,
  limit = 500,
}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("Memory source reconciliation limit must be 1-5000");
  }
  const memories = await store.listMemories({
    sourceType: "gbrain",
    statuses: ["proposed", "confirmed"],
    limit: limit + 1,
  });
  if (memories.length > limit) {
    throw new Error("Memory source reconciliation limit reached");
  }
  const counts = { verified: 0, unavailable: 0, revoked: 0 };
  for (const memory of memories) {
    const change = await checkMemorySourceAccess(memory, {
      projects,
      gbrainPath,
      now,
      leaseMs,
      readPage,
    });
    await store.setMemorySourceAccess(memory.id, change, "system:memory-source");
    counts[change.status] = (counts[change.status] ?? 0) + 1;
  }
  return { checkedAt: new Date(now).toISOString(), checked: memories.length, ...counts };
}
