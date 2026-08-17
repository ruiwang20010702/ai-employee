import { createHash } from "node:crypto";
import {
  readGbrainPage,
  writeGbrainMarkdownAuthority,
} from "./gbrain-page.mjs";
import {
  containsCredentialMaterial,
  containsSensitivePersonMaterial,
} from "./memory-candidate.mjs";
import { safeErrorCode } from "./logging.mjs";

export const memoryAuthoritySchema = "foursday-memory-authority/v1";
export const memoryAuthorityPrefix = "atoms/foursday/";

const authorityTypes = new Set([
  "working",
  "project",
  "person",
  "principle",
  "knowledge",
]);
const promotableSourceTypes = new Set([
  "dingtalk_message",
  "historical_project_import",
  "work_plan",
  "project_identity",
]);
function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function normalizedFactKey(memory) {
  const value = String(memory?.scope?.factKey ?? "").trim();
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,4}$/u.test(value)) {
    throw new Error("Memory authority requires a normalized fact key");
  }
  return value;
}

export function isManagedMemoryAuthority(memory) {
  return memory?.source_type === "gbrain" &&
    memory?.scope?.authority?.schema === memoryAuthoritySchema &&
    memory.scope.authority.managed === true &&
    String(memory.source_id ?? "").startsWith(memoryAuthorityPrefix);
}

export function authoritySlugForMemory(memory) {
  if (!authorityTypes.has(memory?.type)) {
    throw new Error("Unsupported memory authority type");
  }
  const factKey = normalizedFactKey(memory);
  const scope = memory.type === "project"
    ? `projects/${sha256(memory.project_id ?? memory.subject).slice(0, 24)}`
    : memory.type === "person"
      ? `people/${sha256(memory.subject).slice(0, 24)}`
      : memory.type === "principle"
        ? "principles/core"
      : memory.type === "knowledge"
          ? `knowledge/${sha256(memory.project_id ?? "shared").slice(0, 24)}`
          : "working/shared";
  const identity = sha256([
    memory.type,
    memory.subject,
    memory.project_id ?? "",
    factKey,
    memory.id,
  ].join("\n")).slice(0, 32);
  return `${memoryAuthorityPrefix}${scope}/${identity}`;
}

export function authorityMarkdownForMemory(memory, {
  generatedAt = new Date(),
} = {}) {
  if (!promotableSourceTypes.has(memory?.source_type)) {
    throw new Error("Memory source is not eligible for authority promotion");
  }
  if (memory.sensitivity === "confidential") {
    throw new Error("Confidential memory cannot be written to the Markdown authority");
  }
  if (
    containsCredentialMaterial(memory.statement) ||
    containsSensitivePersonMaterial(memory.statement)
  ) {
    throw new Error("Restricted material cannot be written to the memory authority");
  }
  const factKey = normalizedFactKey(memory);
  const slug = authoritySlugForMemory(memory);
  const statement = String(memory.statement ?? "").trim();
  if (!statement || statement.includes("<!-- foursday-memory-")) {
    throw new Error("Memory statement is not safe for the authority document");
  }
  const sourceFingerprint = sha256([
    memory.source_type,
    memory.source_id,
    memory.source_version ?? "",
  ].join("\n"));
  const subjectFingerprint = sha256(memory.subject);
  const content = [
    "---",
    "type: atom",
    `title: ${yamlString(`Foursday memory ${sha256(memory.id).slice(0, 12)}`)}`,
    "tags:",
    "  - foursday-memory",
    `  - ${memory.type}-memory`,
    `foursday_schema: ${yamlString(memoryAuthoritySchema)}`,
    `memory_type: ${yamlString(memory.type)}`,
    `fact_key: ${yamlString(factKey)}`,
    `project_fingerprint: ${yamlString(sha256(memory.project_id ?? ""))}`,
    `sensitivity: ${yamlString(memory.sensitivity)}`,
    `source_fingerprint: ${yamlString(sourceFingerprint)}`,
    `subject_fingerprint: ${yamlString(subjectFingerprint)}`,
    `generated_at: ${yamlString(new Date(generatedAt).toISOString())}`,
    "---",
    "",
    "# Foursday memory",
    "",
    "<!-- foursday-memory-statement:start -->",
    statement,
    "<!-- foursday-memory-statement:end -->",
    "",
    "## Provenance",
    "",
    `- Schema: \`${memoryAuthoritySchema}\``,
    `- Memory type: \`${memory.type}\``,
    `- Fact key: \`${factKey}\``,
    `- Source fingerprint: \`${sourceFingerprint}\``,
    `- Subject fingerprint: \`${subjectFingerprint}\``,
    "- The original source identity remains encrypted in Foursday PostgreSQL.",
    "",
  ].join("\n");
  return { slug, content, contentSha256: sha256(content), factKey };
}

export function parseAuthorityStatement(content) {
  const match = String(content ?? "").match(
    /<!-- foursday-memory-statement:start -->\s*([\s\S]*?)\s*<!-- foursday-memory-statement:end -->/u,
  );
  const statement = match?.[1]?.trim() ?? "";
  if (!statement) throw new Error("Memory authority page has no statement block");
  if (
    containsCredentialMaterial(statement) ||
    containsSensitivePersonMaterial(statement)
  ) {
    throw new Error("Memory authority page contains restricted material");
  }
  return statement;
}

function liveVersion(page) {
  return page.updatedAt == null
    ? `sha256:${sha256(page.content)}`
    : new Date(page.updatedAt).toISOString();
}

export async function promoteMemoryToAuthority(memory, {
  store,
  gbrainPath = "gbrain",
  autoConfirm = false,
  autoConfirmMinimumConfidence = 0.95,
  now = new Date(),
  writePage = writeGbrainMarkdownAuthority,
  readPage = readGbrainPage,
  leaseMs = 15 * 60 * 1_000,
  authorityRoot,
  authoritySourceId = "foursday",
} = {}) {
  if (typeof store?.upsertAuthorityMemoryProjection !== "function") {
    throw new Error("Memory authority requires PostgreSQL projection support");
  }
  if (!Number.isFinite(leaseMs) || leaseMs < 600_000 || leaseMs > 3_600_000) {
    throw new Error("Memory authority lease must be 10-60 minutes");
  }
  if (
    !Number.isFinite(Number(autoConfirmMinimumConfidence)) ||
    Number(autoConfirmMinimumConfidence) < 0 ||
    Number(autoConfirmMinimumConfidence) > 1
  ) {
    throw new Error("Memory authority auto-confirm confidence must be 0-1");
  }
  const document = authorityMarkdownForMemory(memory, {
    generatedAt: memory.created_at ?? now,
  });
  await writePage(gbrainPath, document, {
    root: authorityRoot,
    sourceId: authoritySourceId,
  });
  const page = await readPage(gbrainPath, document.slug, {
    sourceId: authoritySourceId,
  });
  if (page.slug !== document.slug) {
    throw new Error("Memory authority read-back identity mismatch");
  }
  const statement = parseAuthorityStatement(page.content);
  if (statement !== String(memory.statement).trim()) {
    throw new Error("Memory authority read-back statement mismatch");
  }
  const sourceVersion = liveVersion(page);
  const projection = await store.upsertAuthorityMemoryProjection({
    sourceMemoryId: memory.id,
    slug: document.slug,
    sourceVersion,
    authorityContentSha256: sha256(page.content),
    authoritySourceId,
    accessExpiresAt: new Date(new Date(now).getTime() + leaseMs),
    actor: "system:memory-authority",
  }, now);
  let confirmed = false;
  if (
    autoConfirm &&
    projection.status === "proposed" &&
    Number(memory.confidence) >= Number(autoConfirmMinimumConfidence)
  ) {
    try {
      await store.confirmMemory(
        projection.id,
        "system:memory-authority",
        now,
        projection.supersedesId
          ? { supersedesId: projection.supersedesId }
          : undefined,
      );
      confirmed = true;
    } catch {
      confirmed = false;
    }
  }
  return {
    sourceMemoryId: memory.id,
    authorityMemoryId: projection.id,
    slug: document.slug,
    sourceVersion,
    created: projection.created,
    confirmed,
  };
}

export async function synchronizeMemoryAuthority({
  store,
  gbrainPath = "gbrain",
  autoConfirm = false,
  autoConfirmMinimumConfidence = 0.95,
  now = new Date(),
  limit = 100,
  writePage = writeGbrainMarkdownAuthority,
  readPage = readGbrainPage,
  leaseMs = 15 * 60 * 1_000,
  authorityRoot,
  authoritySourceId = "foursday",
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Memory authority sync limit must be 1-500");
  }
  const byId = new Map();
  for (const sourceType of promotableSourceTypes) {
    const rows = await store.listMemories({
      sourceType,
      statuses: ["proposed", "confirmed"],
      limit: limit + 1,
    });
    for (const memory of rows) byId.set(memory.id, memory);
  }
  const memories = [...byId.values()];
  const eligible = memories.filter((memory) =>
    promotableSourceTypes.has(memory.source_type) &&
    memory.sensitivity !== "confidential" &&
    memory.scope?.factKey
  );
  if (eligible.length > limit) {
    throw new Error("Memory authority sync limit reached");
  }
  const report = {
    inspected: memories.length,
    eligible: eligible.length,
    promoted: 0,
    confirmed: 0,
    failed: 0,
    failures: [],
  };
  for (const memory of eligible) {
    try {
      const result = await promoteMemoryToAuthority(memory, {
        store,
        gbrainPath,
        autoConfirm,
        autoConfirmMinimumConfidence,
        now,
        writePage,
        readPage,
        leaseMs,
        authorityRoot,
        authoritySourceId,
      });
      if (result.created) report.promoted += 1;
      if (result.confirmed) report.confirmed += 1;
    } catch (error) {
      report.failed += 1;
      report.failures.push({
        memoryId: memory.id,
        errorCode: safeErrorCode(error),
      });
    }
  }
  return report;
}
