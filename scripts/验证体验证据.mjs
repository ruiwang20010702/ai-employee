#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../src/main-module.mjs";
import { buildPilotTaskDraft } from "../src/pilot-task-draft.mjs";
import { validateValidationEvidence } from "../src/validation-evidence.mjs";

const maximumEvidenceBytes = 2 * 1024 * 1024;
const maximumGitHubResponseBytes = 1 * 1024 * 1024;
const pilotRepository = "ruiwang20010702/foursday";
const githubApiRoot = `https://api.github.com/repos/${pilotRepository}`;

function bounded(value, name, maximum = 500) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function manifestArgument(args) {
  const manifestIndex = args.indexOf("--manifest");
  const shaIndex = args.indexOf("--sha");
  if (
    args.length !== 4 ||
    manifestIndex === -1 ||
    shaIndex === -1 ||
    !args[manifestIndex + 1] ||
    !args[shaIndex + 1]
  ) {
    throw new Error("Usage: npm run pilot:verify -- --manifest /absolute/path/pilot.json --sha <40-character-sha>");
  }
  return {
    manifestPath: resolve(args[manifestIndex + 1]),
    candidateSha: exactCandidateSha(args[shaIndex + 1]),
  };
}

function exactCandidateSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error("Pilot candidate SHA must contain 40 lowercase hexadecimal characters");
  }
  return normalized;
}

async function safeEvidencePath(baseDirectory, configured) {
  const value = bounded(configured, "evidencePath", 1_000);
  if (isAbsolute(value) || value.split(/[\\/]/u).includes("..")) {
    throw new Error("evidencePath must stay relative to the pilot manifest directory");
  }
  const candidate = join(baseDirectory, value);
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("evidencePath must point to a regular file");
  }
  if (stat.size === 0 || stat.size > maximumEvidenceBytes) {
    throw new Error("evidencePath must point to a bounded evidence file");
  }
  const [base, target] = await Promise.all([realpath(baseDirectory), realpath(candidate)]);
  const rel = relative(base, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("evidencePath resolves outside the pilot manifest directory");
  }
  return target;
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} values must be unique`);
}

async function readEvidenceManifest(manifestPath) {
  const absoluteManifest = resolve(manifestPath);
  const manifestStat = await lstat(absoluteManifest);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Pilot manifest must be a regular file");
  }
  if (manifestStat.size === 0 || manifestStat.size > maximumEvidenceBytes) {
    throw new Error("Pilot manifest must be a bounded file");
  }
  const manifest = JSON.parse(await readFile(absoluteManifest, "utf8"));
  if (manifest?.schema !== "foursday-pilot-evidence/v1" || !Array.isArray(manifest.entries)) {
    throw new Error("Pilot manifest schema is invalid");
  }
  if (manifest.entries.length === 0 || manifest.entries.length > 1_000) {
    throw new Error("Pilot manifest requires 1-1000 evidence entries");
  }
  const manifestCandidateSha = manifest.candidateSha == null
    ? null
    : exactCandidateSha(manifest.candidateSha);
  const baseDirectory = dirname(absoluteManifest);
  const entries = [];
  for (const [index, entry] of manifest.entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`entries[${index}] must be an object`);
    }
    const cohort = bounded(entry.cohort, `entries[${index}].cohort`, 20);
    if (!new Set(["self", "external"]).has(cohort)) {
      throw new Error(`entries[${index}].cohort must be self or external`);
    }
    const participantAlias = bounded(
      entry.participantAlias,
      `entries[${index}].participantAlias`,
      80,
    );
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,79}$/u.test(participantAlias)) {
      throw new Error(`entries[${index}].participantAlias is invalid`);
    }
    if (entry.reproducedFromQuickStart !== true) {
      throw new Error(`entries[${index}] must confirm Quick Start reproduction`);
    }
    const feedback = cohort === "external"
      ? bounded(entry.feedback, `entries[${index}].feedback`, 2_000)
      : String(entry.feedback ?? "").trim();
    const evidenceFile = await safeEvidencePath(baseDirectory, entry.evidencePath);
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    entries.push({
      cohort,
      participantAlias,
      feedback,
      evidencePath: entry.evidencePath,
      summary: validateValidationEvidence(evidence),
    });
  }
  const self = entries.filter((entry) => entry.cohort === "self");
  const external = entries.filter((entry) => entry.cohort === "external");
  unique(external.map((entry) => entry.participantAlias), "External participant alias");
  const selfAliases = new Set(self.map((entry) => entry.participantAlias));
  if (selfAliases.size > 1) {
    throw new Error("Self-use loops must use one stable maintainer alias");
  }
  if (external.some((entry) => selfAliases.has(entry.participantAlias))) {
    throw new Error("Maintainer and external participant aliases must be disjoint");
  }
  unique(entries.map((entry) => entry.evidencePath), "Evidence path");
  unique(entries.map((entry) => entry.summary.planHash), "Plan hash");
  unique(entries.map((entry) => entry.summary.issueUrl), "Issue URL");
  unique(entries.map((entry) => entry.summary.draftPrUrl), "Draft PR URL");
  const summary = {
    valid: true,
    schema: manifest.schema,
    candidateSha: manifestCandidateSha,
    verifiedLoops: entries.length,
    selfLoops: self.length,
    externalTesters: external.length,
    distinctVerifiedClosedLoopUsers: external.length + (self.length > 0 ? 1 : 0),
    runtimes: [...new Set(entries.map((entry) => entry.summary.runtime))].sort(),
    confirmedReturnedMinutes: entries.reduce(
      (total, entry) => total + entry.summary.returnedMinutes,
      0,
    ),
    localIntegrityVerified: true,
    targetReadbackReverificationRequired: true,
  };
  return { summary, entries };
}

async function verifyEvidenceManifest(manifestPath) {
  return (await readEvidenceManifest(manifestPath)).summary;
}

function assertLaunchCohortEntries(entries, candidateSha) {
  for (const entry of entries) {
    if (entry.summary.startingCommit !== candidateSha) {
      throw new Error("Pilot evidence starting commit does not match the reviewed candidate");
    }
    buildPilotTaskDraft({
      participantAlias: entry.participantAlias,
      candidateSha,
    });
  }
}

export async function verifyGrowthEvidence(manifestPath) {
  return verifyEvidenceManifest(manifestPath);
}

export async function verifyPilotEvidence(manifestPath, { candidateSha } = {}) {
  return verifyLaunchCohortEvidence(manifestPath, {
    candidateSha,
    minimumSelfLoops: 10,
    minimumExternalTesters: 10,
  });
}

async function verifyLaunchCohortEvidence(manifestPath, {
  candidateSha,
  minimumSelfLoops,
  minimumExternalTesters,
}) {
  const expectedCandidateSha = exactCandidateSha(candidateSha);
  const { summary: result, entries } = await readEvidenceManifest(manifestPath);
  if (result.candidateSha !== expectedCandidateSha) {
    throw new Error("Pilot manifest candidate SHA does not match the reviewed candidate");
  }
  if (result.selfLoops < minimumSelfLoops) {
    throw new Error(`Pilot requires at least ${minimumSelfLoops} verified self-use loops`);
  }
  if (result.externalTesters < minimumExternalTesters) {
    throw new Error(`Pilot requires at least ${minimumExternalTesters} verified external testers`);
  }
  assertLaunchCohortEntries(entries, expectedCandidateSha);
  return result;
}

export async function verifyMaintainerEvidence(manifestPath, { candidateSha } = {}) {
  return verifyLaunchCohortEvidence(manifestPath, {
    candidateSha,
    minimumSelfLoops: 10,
    minimumExternalTesters: 0,
  });
}

function optionalGitHubToken(value) {
  if (value === null || value === undefined || value === "") return null;
  const token = String(value);
  if (token.length > 1_024 || /[\s\0]/u.test(token)) {
    throw new Error("Optional GitHub API token is invalid");
  }
  return token;
}

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "foursday-pilot-target-readback",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubJson(fetchImpl, path, token) {
  const url = new URL(path, `${githubApiRoot}/`);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.github.com" ||
    !url.pathname.startsWith(`/repos/${pilotRepository}/`) ||
    url.username ||
    url.password ||
    url.hash
  ) throw new Error("Pilot target readback only reads the fixed public GitHub repository");
  const response = await fetchImpl(url, {
    headers: githubHeaders(token),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response?.ok) {
    throw new Error(`Pilot target readback received HTTP ${Number(response?.status) || 0}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumGitHubResponseBytes) {
    throw new Error("Pilot target readback response exceeded the bounded size");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Pilot target readback received invalid JSON");
  }
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

async function verifyTargetEntry(entry, candidateSha, fetchImpl, token) {
  const expectedTask = buildPilotTaskDraft({
    participantAlias: entry.participantAlias,
    candidateSha,
  });
  const summary = entry.summary;
  if (
    summary.repository !== pilotRepository ||
    summary.draftPrState !== "OPEN" ||
    summary.draftPrIsDraft !== true
  ) throw new Error("Pilot evidence target is not the fixed open Draft PR workflow");
  const [issue, pull] = await Promise.all([
    githubJson(fetchImpl, `issues/${summary.issueNumber}`, token),
    githubJson(fetchImpl, `pulls/${summary.draftPrNumber}`, token),
  ]);
  const expectedIssueUrl = `https://github.com/${pilotRepository}/issues/${summary.issueNumber}`;
  const expectedPullUrl = `https://github.com/${pilotRepository}/pull/${summary.draftPrNumber}`;
  if (
    issue.number !== summary.issueNumber ||
    issue.html_url !== expectedIssueUrl ||
    summary.issueUrl !== expectedIssueUrl ||
    issue.state !== "open" ||
    issue.pull_request != null ||
    issue.title !== expectedTask.issueTitle ||
    String(issue.body ?? "") !== expectedTask.issueBody
  ) throw new Error("Pilot Issue online readback does not match the approved task");
  const titleDigest = sha256(pull.title);
  const bodyDigest = sha256(pull.body);
  if (
    pull.number !== summary.draftPrNumber ||
    pull.html_url !== expectedPullUrl ||
    summary.draftPrUrl !== expectedPullUrl ||
    pull.state !== "open" ||
    pull.draft !== true ||
    String(pull.head?.ref ?? "") !== summary.draftPrHead ||
    String(pull.head?.sha ?? "") !== summary.draftPrCommit ||
    String(pull.head?.repo?.full_name ?? "").toLowerCase() !== summary.draftPrHeadRepository ||
    String(pull.base?.ref ?? "") !== summary.draftPrBase ||
    String(pull.base?.repo?.full_name ?? "").toLowerCase() !== pilotRepository ||
    pull.title !== expectedTask.prTitle ||
    titleDigest !== summary.draftPrTitleSha256 ||
    bodyDigest !== summary.draftPrBodySha256
  ) throw new Error("Pilot Draft PR online readback does not match the approved evidence");
}

async function runBounded(items, worker, concurrency = 4) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  }));
}

export async function verifyPilotTargetReadback(manifestPath, {
  candidateSha,
  fetchImpl = globalThis.fetch,
  githubToken = null,
} = {}) {
  return verifyLaunchCohortTargetReadback(manifestPath, {
    candidateSha,
    fetchImpl,
    githubToken,
    minimumSelfLoops: 10,
    minimumExternalTesters: 10,
  });
}

async function verifyLaunchCohortTargetReadback(manifestPath, {
  candidateSha,
  fetchImpl,
  githubToken,
  minimumSelfLoops,
  minimumExternalTesters,
}) {
  const expectedCandidateSha = exactCandidateSha(candidateSha);
  if (typeof fetchImpl !== "function") throw new Error("Pilot target readback requires fetch");
  const token = optionalGitHubToken(githubToken);
  const { summary, entries } = await readEvidenceManifest(manifestPath);
  if (summary.candidateSha !== expectedCandidateSha) {
    throw new Error("Pilot manifest candidate SHA does not match the reviewed candidate");
  }
  if (
    summary.selfLoops < minimumSelfLoops ||
    summary.externalTesters < minimumExternalTesters
  ) {
    throw new Error(
      `Pilot target readback requires at least ${minimumSelfLoops} self and ${minimumExternalTesters} external loops`,
    );
  }
  assertLaunchCohortEntries(entries, expectedCandidateSha);
  if (entries.length > 100) {
    throw new Error("Pilot target readback is bounded to 100 launch-cohort entries");
  }
  await runBounded(entries, (entry) =>
    verifyTargetEntry(entry, expectedCandidateSha, fetchImpl, token));
  return Object.freeze({
    valid: true,
    schema: "foursday-pilot-target-readback/v1",
    candidateSha: expectedCandidateSha,
    verifiedTargets: entries.length,
    verifiedIssues: entries.length,
    verifiedDraftPullRequests: entries.length,
    targetReadbackReverificationRequired: false,
    identitiesEmitted: false,
    targetContentsEmitted: false,
    externalSystemsModified: false,
  });
}

export async function verifyMaintainerTargetReadback(manifestPath, {
  candidateSha,
  fetchImpl = globalThis.fetch,
  githubToken = null,
} = {}) {
  return verifyLaunchCohortTargetReadback(manifestPath, {
    candidateSha,
    fetchImpl,
    githubToken,
    minimumSelfLoops: 10,
    minimumExternalTesters: 0,
  });
}

export async function runPilotEvidenceVerification({
  args = process.argv.slice(2),
  output = process.stdout,
} = {}) {
  const parsed = manifestArgument(args);
  const result = await verifyPilotEvidence(parsed.manifestPath, {
    candidateSha: parsed.candidateSha,
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) await runPilotEvidenceVerification();
