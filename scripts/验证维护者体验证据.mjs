#!/usr/bin/env node
import { resolve } from "node:path";
import { isMainModule } from "../src/main-module.mjs";
import {
  verifyMaintainerEvidence,
  verifyMaintainerTargetReadback,
} from "./验证体验证据.mjs";

function exactCandidateSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error("Maintainer pilot candidate SHA must contain 40 lowercase hexadecimal characters");
  }
  return normalized;
}

function argumentsForVerification(args) {
  const manifestIndex = args.indexOf("--manifest");
  const shaIndex = args.indexOf("--sha");
  if (
    args.length !== 4 ||
    manifestIndex === -1 ||
    shaIndex === -1 ||
    !args[manifestIndex + 1] ||
    !args[shaIndex + 1]
  ) {
    throw new Error(
      "Usage: npm run pilot:self:verify -- --manifest /absolute/path/pilot.json --sha <40-character-sha>",
    );
  }
  return {
    manifestPath: resolve(args[manifestIndex + 1]),
    candidateSha: exactCandidateSha(args[shaIndex + 1]),
  };
}

export async function runMaintainerEvidenceVerification({
  args = process.argv.slice(2),
  output = process.stdout,
  environment = process.env,
  verifyLocal = verifyMaintainerEvidence,
  verifyTargets = verifyMaintainerTargetReadback,
} = {}) {
  const { manifestPath, candidateSha } = argumentsForVerification(args);
  const githubToken = environment.GH_TOKEN ?? environment.GITHUB_TOKEN ?? null;
  const local = await verifyLocal(manifestPath, { candidateSha });
  const targets = await verifyTargets(manifestPath, { candidateSha, githubToken });
  if (
    local.valid !== true ||
    local.schema !== "foursday-pilot-evidence/v1" ||
    local.candidateSha !== candidateSha ||
    local.selfLoops < 10 ||
    local.localIntegrityVerified !== true ||
    local.targetReadbackReverificationRequired !== true ||
    targets.valid !== true ||
    targets.schema !== "foursday-pilot-target-readback/v1" ||
    targets.candidateSha !== candidateSha ||
    targets.verifiedTargets !== local.verifiedLoops ||
    targets.targetReadbackReverificationRequired !== false ||
    targets.identitiesEmitted !== false ||
    targets.targetContentsEmitted !== false ||
    targets.externalSystemsModified !== false
  ) throw new Error("Maintainer pilot verification result is incomplete");
  const result = Object.freeze({
    valid: true,
    schema: "foursday-maintainer-pilot-verification/v1",
    candidateSha,
    verifiedMaintainerLoops: local.selfLoops,
    verifiedTargets: targets.verifiedTargets,
    localIntegrityVerified: local.localIntegrityVerified === true,
    onlineTargetReadbackVerified: true,
    identitiesEmitted: false,
    targetContentsEmitted: false,
    externalSystemsModified: false,
    productionWrite: false,
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) await runMaintainerEvidenceVerification();
