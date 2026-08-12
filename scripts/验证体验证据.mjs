#!/usr/bin/env node
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../src/main-module.mjs";
import { validateValidationEvidence } from "../src/validation-evidence.mjs";

function bounded(value, name, maximum = 500) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function manifestArgument(args) {
  const index = args.indexOf("--manifest");
  if (index === -1 || !args[index + 1]) {
    throw new Error("Usage: npm run pilot:verify -- --manifest /absolute/path/pilot.json");
  }
  return resolve(args[index + 1]);
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

export async function verifyPilotEvidence(manifestPath) {
  const absoluteManifest = resolve(manifestPath);
  const manifestStat = await lstat(absoluteManifest);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Pilot manifest must be a regular file");
  }
  const manifest = JSON.parse(await readFile(absoluteManifest, "utf8"));
  if (manifest?.schema !== "foursday-pilot-evidence/v1" || !Array.isArray(manifest.entries)) {
    throw new Error("Pilot manifest schema is invalid");
  }
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
  if (self.length < 10) throw new Error("Pilot requires at least 10 verified self-use loops");
  if (external.length < 10) throw new Error("Pilot requires at least 10 verified external testers");
  unique(external.map((entry) => entry.participantAlias), "External participant alias");
  unique(entries.map((entry) => entry.evidencePath), "Evidence path");
  unique(entries.map((entry) => entry.summary.planHash), "Plan hash");
  unique(entries.map((entry) => entry.summary.issueUrl), "Issue URL");
  unique(entries.map((entry) => entry.summary.draftPrUrl), "Draft PR URL");
  return {
    valid: true,
    schema: manifest.schema,
    verifiedLoops: entries.length,
    selfLoops: self.length,
    externalTesters: external.length,
    runtimes: [...new Set(entries.map((entry) => entry.summary.runtime))].sort(),
    confirmedReturnedMinutes: entries.reduce(
      (total, entry) => total + entry.summary.returnedMinutes,
      0,
    ),
    localIntegrityVerified: true,
    targetReadbackReverificationRequired: true,
  };
}

export async function runPilotEvidenceVerification({
  args = process.argv.slice(2),
  output = process.stdout,
} = {}) {
  const result = await verifyPilotEvidence(manifestArgument(args));
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) await runPilotEvidenceVerification();
