import { createHash } from "node:crypto";
import { stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export function memoryDeletionConfirmation(id) {
  const memoryId = required(id, "memoryId");
  const suffix = createHash("sha256")
    .update(memoryId)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `DELETE-${suffix}`;
}

export function validateMemoryExportMode(mode = "metadata", confirmation) {
  if (!["metadata", "content"].includes(mode)) {
    throw new Error("Memory export mode must be metadata or content");
  }
  const includeContent = mode === "content";
  if (includeContent && confirmation !== "EXPORT-CONTENT") {
    throw new Error("Content export requires the exact EXPORT-CONTENT confirmation");
  }
  return includeContent;
}

function exportItem(memory, includeContent) {
  const item = {
    id: memory.id,
    type: memory.type,
    projectId: memory.project_id ?? null,
    status: memory.status,
    sensitivity: memory.sensitivity,
    confidence: memory.confidence,
    sourceType: memory.source_type,
    sourceVersion: memory.source_version ?? null,
    sourceAccessStatus: memory.source_access_status ?? "not_required",
    sourceAccessReason: memory.source_access_reason ?? null,
    sourceAccessCheckedAt: memory.source_access_checked_at ?? null,
    sourceAccessExpiresAt: memory.source_access_expires_at ?? null,
    validFrom: memory.valid_from ?? null,
    expiresAt: memory.expires_at ?? null,
    supersedesId: memory.supersedes_id ?? null,
    createdAt: memory.created_at,
    updatedAt: memory.updated_at,
  };
  if (includeContent) {
    Object.assign(item, {
      subject: memory.subject,
      statement: memory.statement,
      sourceId: memory.source_id,
      scope: memory.scope,
      createdBy: memory.created_by,
      updatedBy: memory.updated_by,
    });
  }
  return item;
}

export function createMemoryExport(
  memories,
  {
    projectId = null,
    includeContent = false,
    exportedAt = new Date(),
  } = {},
) {
  if (!Array.isArray(memories) || memories.length > 10_000) {
    throw new Error("Memory export must contain at most 10000 items");
  }
  if (memories.some((memory) => !memory?.id || memory.deleted_at != null)) {
    throw new Error("Memory export contains an invalid or deleted item");
  }
  if (
    projectId &&
    memories.some((memory) => memory.project_id !== projectId)
  ) {
    throw new Error("Memory export contains an item outside the requested project");
  }
  const timestamp = new Date(exportedAt);
  if (Number.isNaN(timestamp.getTime())) throw new Error("Invalid export timestamp");
  return {
    schema: "ai-employee-memory-export/v1",
    exportedAt: timestamp.toISOString(),
    projectId,
    contentIncluded: includeContent,
    itemCount: memories.length,
    items: memories.map((memory) => exportItem(memory, includeContent)),
  };
}

export async function writeMemoryExport(path, payload) {
  const destination = required(path, "path");
  if (!isAbsolute(destination) || !destination.endsWith(".json")) {
    throw new Error("Memory export path must be an absolute .json path");
  }
  await writeFile(destination, `${JSON.stringify(payload, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  if (((await stat(destination)).mode & 0o777) !== 0o600) {
    await unlink(destination).catch(() => {});
    throw new Error("Memory export permissions are not 600");
  }
  return destination;
}
