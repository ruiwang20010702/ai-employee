import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  containsCredentialMaterial,
  containsSensitivePersonMaterial,
} from "./memory-candidate.mjs";

export const personalGbrainCandidateSchema = "foursday-personal-gbrain-candidate/v1";
const candidateTypes = new Set(["atom", "prospective", "source"]);
const sensitivities = new Set(["public", "internal"]);
const factKeyPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+){1,15}$/u;
const projectPattern = /^[a-z0-9][a-z0-9_-]{0,99}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

function boundedText(value, name, maximum) {
  const text = String(value ?? "").replace(/\0/gu, "").trim();
  if (!text || text.length > maximum) throw new Error(`${name} is invalid`);
  return text;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeRelativePath(value) {
  const path = String(value ?? "").trim().replaceAll("\\", "/");
  if (
    !path ||
    path.length > 500 ||
    path.startsWith("/") ||
    path.includes("//") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error("gbrain candidate evidence path is invalid");
  return path;
}

export function normalizePersonalGbrainCandidate(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error("gbrain candidate must be an object");
  }
  if (input.schema !== personalGbrainCandidateSchema) {
    throw new Error("gbrain candidate schema is invalid");
  }
  const type = String(input.type ?? "").trim();
  const projectId = String(input.projectId ?? "").trim();
  const factKey = String(input.factKey ?? "").trim();
  const sensitivity = String(input.sensitivity ?? "").trim();
  const confidence = Number(input.confidence);
  const statement = boundedText(input.statement, "gbrain candidate statement", 2_000);
  const title = boundedText(input.title, "gbrain candidate title", 200);
  if (!candidateTypes.has(type)) throw new Error("gbrain candidate type is not automatic-safe");
  if (!projectPattern.test(projectId)) throw new Error("gbrain candidate project is invalid");
  if (!factKeyPattern.test(factKey)) throw new Error("gbrain candidate fact key is invalid");
  if (!sensitivities.has(sensitivity)) throw new Error("gbrain candidate sensitivity is invalid");
  if (!Number.isFinite(confidence) || confidence < 0.97 || confidence > 1) {
    throw new Error("gbrain candidate confidence is below the automatic threshold");
  }
  if (
    containsCredentialMaterial(statement) ||
    containsSensitivePersonMaterial(statement)
  ) throw new Error("gbrain candidate contains restricted material");
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  if (evidence.length < 1 || evidence.length > 8) {
    throw new Error("gbrain candidate requires bounded workspace evidence");
  }
  const normalizedEvidence = evidence.map((item) => {
    const relativePath = safeRelativePath(item?.relativePath);
    const contentSha256 = String(item?.contentSha256 ?? "").trim().toLowerCase();
    if (!digestPattern.test(contentSha256)) {
      throw new Error("gbrain candidate evidence digest is invalid");
    }
    return {
      relativePath,
      contentSha256,
      description: boundedText(item?.description, "gbrain candidate evidence description", 300),
    };
  });
  const observedAt = new Date(input.observedAt ?? "");
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error("gbrain candidate observedAt is invalid");
  }
  const sourceSessionHash = String(input.sourceSessionHash ?? "").trim().toLowerCase();
  if (!digestPattern.test(sourceSessionHash)) {
    throw new Error("gbrain candidate source session hash is invalid");
  }
  return {
    schema: personalGbrainCandidateSchema,
    type,
    projectId,
    factKey,
    title,
    statement,
    sensitivity,
    confidence,
    evidence: normalizedEvidence,
    observedAt: observedAt.toISOString(),
    sourceSessionHash,
  };
}

async function safeEvidenceFile(root, relativePath) {
  const canonicalRoot = await realpath(root);
  const lexicalRoot = resolve(root);
  if (canonicalRoot !== lexicalRoot) throw new Error("project root must not use a symlink");
  const lexical = resolve(canonicalRoot, relativePath);
  const difference = relative(canonicalRoot, lexical);
  if (!difference || difference.startsWith("..") || isAbsolute(difference)) {
    throw new Error("gbrain candidate evidence escapes the project root");
  }
  let current = canonicalRoot;
  for (const part of difference.split(sep).slice(0, -1)) {
    current = resolve(current, part);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("gbrain candidate evidence path contains a symlink");
    }
  }
  const metadata = await lstat(lexical);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 50 * 1024 * 1024) {
    throw new Error("gbrain candidate evidence must be a bounded regular file");
  }
  const canonical = await realpath(lexical);
  if (canonical !== lexical) throw new Error("gbrain candidate evidence must not use a symlink");
  return { path: lexical, metadata };
}

async function fileSha256(path) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const hash = createHash("sha256");
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function verifyPersonalGbrainCandidateEvidence(candidate, {
  projectRoot,
} = {}) {
  const normalized = normalizePersonalGbrainCandidate(candidate);
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) {
    throw new Error("gbrain candidate project root must be absolute");
  }
  const verified = [];
  for (const item of normalized.evidence) {
    const file = await safeEvidenceFile(projectRoot, item.relativePath);
    const contentSha256 = await fileSha256(file.path);
    if (contentSha256 !== item.contentSha256) {
      const error = new Error("gbrain candidate evidence changed before admission");
      error.code = "EVIDENCE_CHANGED";
      throw error;
    }
    verified.push({ ...item, size: file.metadata.size });
  }
  return { ...normalized, evidence: verified };
}

export function personalGbrainCandidateKey(candidate) {
  const normalized = normalizePersonalGbrainCandidate(candidate);
  return sha256(JSON.stringify({
    type: normalized.type,
    projectId: normalized.projectId,
    factKey: normalized.factKey,
    statement: normalized.statement,
    evidence: normalized.evidence.map(({ relativePath, contentSha256 }) => ({
      relativePath,
      contentSha256,
    })),
  }));
}

export function renderPersonalGbrainCandidate(candidate, {
  generatedAt = new Date(),
} = {}) {
  const normalized = normalizePersonalGbrainCandidate(candidate);
  const key = personalGbrainCandidateKey(normalized);
  const directory = normalized.type === "prospective"
    ? "prospective"
    : normalized.type === "source" ? "source" : "atoms";
  const slug = `${directory}/agents/foursday/${normalized.projectId}/${key.slice(0, 24)}`;
  const sourceMode = normalized.type === "source" ? [
    "source_schema: gbrain-source-v1",
    "source_mode: pointer",
    "source_kind: project-file",
    "authority: canonical",
    `source_ref: ${yamlString(normalized.evidence[0].relativePath)}`,
    `content_hash: ${yamlString(`sha256:${normalized.evidence[0].contentSha256}`)}`,
    "derived_pages: []",
  ] : [];
  const typeMetadata = normalized.type === "atom" ? [
    "confidence: confirmed",
    `valid_from: ${yamlString(normalized.observedAt)}`,
    `provenance: ${yamlString(`foursday:${normalized.sourceSessionHash}`)}`,
    "supersedes: null",
  ] : normalized.type === "prospective" ? [
    "intent_kind: follow-up",
    "owner: wang-rui",
    "due_at: null",
    `source_ref: ${yamlString(normalized.evidence[0].relativePath)}`,
  ] : [];
  const content = [
    "---",
    `type: ${normalized.type}`,
    `title: ${yamlString(normalized.title)}`,
    "knowledge_schema: gbrain-page-v1",
    "status: active",
    `captured_at: ${yamlString(new Date(generatedAt).toISOString())}`,
    `updated_at: ${yamlString(new Date(generatedAt).toISOString())}`,
    `project_id: ${yamlString(normalized.projectId)}`,
    `fact_key: ${yamlString(normalized.factKey)}`,
    `sensitivity: ${yamlString(normalized.sensitivity)}`,
    `source_agent: ${yamlString("foursday")}`,
    `source_session_hash: ${yamlString(normalized.sourceSessionHash)}`,
    `candidate_key: ${yamlString(key)}`,
    ...typeMetadata,
    ...sourceMode,
    "tags:",
    "  - foursday",
    "  - agent-captured",
    "---",
    "",
    `# ${normalized.title}`,
    "",
    normalized.statement,
    "",
    "## 来源",
    "",
    ...normalized.evidence.map((item) =>
      `- \`${item.relativePath}\` — ${item.description} — \`sha256:${item.contentSha256}\``),
    "",
    "## 写入边界",
    "",
    "- 由 Foursday 从已注册项目中的固定文件证据自动形成。",
    "- 本页不包含消息原文、凭据、审批状态或执行租约。",
    "- 冲突时以当前项目正本和更新后的正式知识页为准。",
    "",
  ].join("\n");
  return { slug, content, contentSha256: sha256(content), candidateKey: key };
}
