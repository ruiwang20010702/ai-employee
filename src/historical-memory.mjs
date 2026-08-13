import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  containsCredentialMaterial,
  containsSensitivePersonMaterial,
} from "./memory-candidate.mjs";
import { validateMemoryProposal } from "./memory-policy.mjs";

const digestPattern = /^[a-f0-9]{64}$/u;
const factKeyPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,4}$/u;

export function validateHistoricalMemoryProposals(inputs, now = new Date()) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) {
    throw new Error("Historical memory proposals must contain 1-100 items");
  }
  return inputs.map((input) => {
    const memory = validateMemoryProposal(input);
    if (memory.sourceType !== "historical_project_import") {
      throw new Error("Historical memory source type is invalid");
    }
    const sourcePath = String(memory.scope.sourcePath ?? "").replaceAll("\\", "/");
    if (
      !memory.projectId ||
      memory.subject !== memory.projectId ||
      !["project", "principle"].includes(memory.type) ||
      !digestPattern.test(memory.sourceId) ||
      memory.sourceVersion !== memory.sourceId ||
      !digestPattern.test(String(memory.scope.importDigest ?? "")) ||
      !digestPattern.test(String(memory.scope.sourceQuoteSha256 ?? "")) ||
      !sourcePath ||
      isAbsolute(sourcePath) ||
      sourcePath.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error("Historical memory source binding is invalid");
    }
    if (!factKeyPattern.test(String(memory.scope.factKey ?? ""))) {
      throw new Error("Historical memory requires a fact key");
    }
    if (
      containsCredentialMaterial(memory.statement) ||
      containsSensitivePersonMaterial(memory.statement)
    ) {
      throw new Error("Historical memory contains restricted material");
    }
    if (
      !memory.expiresAt ||
      memory.expiresAt <= now ||
      memory.expiresAt > new Date(now.getTime() + 365 * 86_400_000)
    ) {
      throw new Error("Historical memory expiry is outside the allowed range");
    }
    if (memory.supersedesId) {
      throw new Error("Historical import cannot automatically supersede a memory");
    }
    return memory;
  });
}

export function historicalMemoryId(memory) {
  const identity = [
    memory.projectId,
    memory.type,
    memory.subject,
    memory.scope.factKey,
    memory.scope.importDigest,
    memory.sourceId,
    memory.statement.trim(),
  ].join("\n");
  return `memory_import_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}
