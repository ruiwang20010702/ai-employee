import { createHash } from "node:crypto";

const capabilities = Object.freeze([
  "code_patch",
  "local_branch",
  "local_test",
  "git_push",
  "github_pr_draft",
]);

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function bounded(value, name, maximum = 2_000) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function exactSha(value, name, length) {
  const normalized = bounded(value, name, length);
  if (!new RegExp(`^[a-f0-9]{${length}}$`, "u").test(normalized)) {
    throw new Error(`${name} must be a ${length}-character lowercase hexadecimal digest`);
  }
  return normalized;
}

function githubUrl(value, kind) {
  const normalized = bounded(value, kind, 2_000);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${kind} must be a GitHub URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) throw new Error(`${kind} must use credential-free GitHub HTTPS`);
  const pattern = kind === "issue.url"
    ? /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*\/?$/u
    : /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/u;
  if (!pattern.test(parsed.pathname)) throw new Error(`${kind} has an invalid path`);
  return normalized;
}

function githubIdentity(value, kind) {
  const url = githubUrl(value, kind);
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  return {
    url,
    repository: `${segments[0]}/${segments[1]}`.toLowerCase(),
    number: Number(segments[3]),
  };
}

function repositorySlug(value, name) {
  const normalized = bounded(value, name, 300).toLowerCase();
  if (!/^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/u.test(normalized)) {
    throw new Error(`${name} must be an owner/repository slug`);
  }
  return normalized;
}

function branch(value, name, { prefix = null } = {}) {
  const normalized = bounded(value, name, 200);
  if (
    !/^[A-Za-z0-9._/-]+$/u.test(normalized) ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.startsWith(".") ||
    normalized.endsWith(".") ||
    normalized.includes("//") ||
    normalized.includes("..") ||
    (prefix && !normalized.startsWith(prefix))
  ) {
    throw new Error(`${name} is not a valid governed branch name`);
  }
  return normalized;
}

function rejectPrivateFields(value, path = "bundle") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectPrivateFields(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:rootDirectory|remoteUrl|actionToken|credentials?|password|apiKey|modelOutput)$/iu.test(key)) {
      throw new Error(`Evidence contains forbidden private field: ${path}.${key}`);
    }
    rejectPrivateFields(entry, `${path}.${key}`);
  }
}

export function validationEvidenceDigest(core) {
  return createHash("sha256").update(JSON.stringify(core)).digest("hex");
}

export function sealValidationEvidence(core) {
  object(core, "evidence core");
  return {
    ...core,
    integrity: {
      algorithm: "sha256",
      digest: validationEvidenceDigest(core),
      signed: false,
    },
  };
}

export function validateValidationEvidence(value, { requireConfirmed = true } = {}) {
  const bundle = object(value, "evidence bundle");
  if (bundle.schema !== "foursday-validation-evidence/v1") {
    throw new Error("Evidence schema is unsupported");
  }
  rejectPrivateFields(bundle);
  const integrity = object(bundle.integrity, "integrity");
  if (integrity.algorithm !== "sha256" || integrity.signed !== false) {
    throw new Error("Evidence integrity metadata is invalid");
  }
  const { integrity: ignored, ...core } = bundle;
  if (exactSha(integrity.digest, "integrity.digest", 64) !== validationEvidenceDigest(core)) {
    throw new Error("Evidence integrity digest does not match the bundle");
  }
  if (typeof bundle.generatedAt !== "string") {
    throw new Error("generatedAt must be a canonical ISO 8601 UTC timestamp");
  }
  const generatedAt = new Date(bundle.generatedAt);
  if (Number.isNaN(generatedAt.getTime()) || generatedAt.toISOString() !== bundle.generatedAt) {
    throw new Error("generatedAt must be a canonical ISO 8601 UTC timestamp");
  }
  if (!Array.isArray(bundle.evidence) || bundle.evidence.length !== capabilities.length) {
    throw new Error("Evidence bundle must contain the complete five-step delivery");
  }
  const observedCapabilities = bundle.evidence.map((entry) => entry?.capability);
  if (JSON.stringify(observedCapabilities) !== JSON.stringify(capabilities)) {
    throw new Error("Evidence capabilities or order do not match the governed recipe");
  }
  for (const entry of bundle.evidence) {
    object(entry, "step evidence");
    if (entry.status !== "completed" || !entry.kind || !entry.verification) {
      throw new Error(`Evidence step ${entry.capability} is not verified and completed`);
    }
  }
  const project = object(bundle.project, "project");
  const plan = object(bundle.plan, "plan");
  const outcomes = object(bundle.outcomes, "outcomes");
  const safeguards = object(bundle.safeguards, "safeguards");
  const pr = bundle.evidence.find((entry) => entry.capability === "github_pr_draft");
  const issue = object(bundle.issue, "issue");
  const issueIdentity = githubIdentity(issue.url, "issue.url");
  if (!Number.isSafeInteger(issue.number) || issue.number !== issueIdentity.number) {
    throw new Error("issue.number must exactly match the terminal number in issue.url");
  }
  const prIdentity = githubIdentity(pr.url, "draftPr.url");
  if (!Number.isSafeInteger(pr.number) || pr.number !== prIdentity.number) {
    throw new Error("draftPr.number must exactly match the terminal number in draftPr.url");
  }
  const planHash = exactSha(plan.planHash, "plan.planHash", 64);
  exactSha(project.startingCommit, "project.startingCommit", 40);
  exactSha(pr.commit, "draftPr.commit", 40);
  const repository = repositorySlug(project.repository, "project.repository");
  const sourceRepository = repositorySlug(
    project.sourceRepository ?? repository,
    "project.sourceRepository",
  );
  if (issueIdentity.repository !== repository || prIdentity.repository !== repository) {
    throw new Error("Evidence Issue and Draft PR must belong to the project repository");
  }
  const draftPrHeadRepository = repositorySlug(
    pr.headRepository ?? repository,
    "draftPr.headRepository",
  );
  if (draftPrHeadRepository !== sourceRepository) {
    throw new Error("Evidence Draft PR head repository must match the approved source repository");
  }
  const draftPrHead = branch(pr.head, "draftPr.head", { prefix: "foursday/" });
  const draftPrBase = branch(pr.base, "draftPr.base");
  if (pr.state !== "OPEN" || pr.isDraft !== true) {
    throw new Error("Evidence Draft PR must be open and remain a draft");
  }
  if (plan.status !== "completed") throw new Error("Evidence plan is not completed");
  for (const key of ["exactPlanApproval", "targetReadBack"]) {
    if (safeguards[key] !== true) throw new Error(`Evidence safeguard ${key} is missing`);
  }
  for (const key of [
    "mergePerformed",
    "deploymentPerformed",
    "productionSendingEnabled",
    "proactiveWorkEnabled",
  ]) {
    if (safeguards[key] !== false) throw new Error(`Evidence safeguard ${key} must remain false`);
  }
  const confirmed = outcomes.memory?.status === "confirmed" &&
    outcomes.timeReturn?.status === "confirmed" &&
    bundle.validationStatus === "verified_closed_loop";
  if (requireConfirmed && !confirmed) {
    throw new Error("Evidence outcomes are not a confirmed closed loop");
  }
  return {
    planHash,
    projectId: bounded(project.id, "project.id", 64),
    repository,
    sourceRepository,
    issueUrl: issueIdentity.url,
    issueNumber: issueIdentity.number,
    draftPrUrl: prIdentity.url,
    draftPrNumber: prIdentity.number,
    draftPrHead,
    draftPrHeadRepository,
    draftPrBase,
    draftPrState: pr.state,
    draftPrIsDraft: pr.isDraft,
    draftPrCommit: pr.commit,
    runtime: bounded(bundle.runtime, "runtime", 100),
    returnedMinutes: Number(outcomes.timeReturn?.returnedMinutes ?? 0),
    confirmed,
    integrityDigest: integrity.digest,
  };
}

export const validationEvidenceCapabilities = capabilities;
