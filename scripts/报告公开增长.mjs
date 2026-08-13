#!/usr/bin/env node
import { buildPublicGrowthReport } from "../src/public-growth-report.mjs";
import { isMainModule } from "../src/main-module.mjs";
import { verifyCommunityExtensionEvidence } from "./验证社区扩展证据.mjs";
import {
  verifyGrowthEvidence,
  verifyPilotEvidence,
  verifyPilotTargetReadback,
} from "./验证体验证据.mjs";

function candidateArgument(args) {
  const index = args.indexOf("--sha");
  if (index === -1 || !args[index + 1]) {
    throw new Error("Usage: npm run growth:report -- --sha <reviewed-40-character-candidate-sha>");
  }
  return args[index + 1];
}

function pilotManifestArgument(args) {
  const index = args.indexOf("--pilot-manifest");
  if (index === -1) return null;
  if (!args[index + 1]) {
    throw new Error("--pilot-manifest requires an absolute or relative pilot manifest path");
  }
  return args[index + 1];
}

function extensionManifestArgument(args) {
  const index = args.indexOf("--extension-manifest");
  if (index === -1) return null;
  if (!args[index + 1]) {
    throw new Error("--extension-manifest requires an absolute or relative evidence manifest path");
  }
  return args[index + 1];
}

function closedLoopManifestArgument(args) {
  const index = args.indexOf("--closed-loop-manifest");
  if (index === -1) return null;
  if (!args[index + 1]) {
    throw new Error("--closed-loop-manifest requires an absolute or relative evidence manifest path");
  }
  return args[index + 1];
}

export async function runPublicGrowthReport({
  args = process.argv.slice(2),
  output = process.stdout,
  build = buildPublicGrowthReport,
  verify = verifyPilotEvidence,
  verifyTargets = verifyPilotTargetReadback,
  verifyGrowth = verifyGrowthEvidence,
  verifyExtensions = verifyCommunityExtensionEvidence,
  environment = process.env,
} = {}) {
  const candidateSha = candidateArgument(args);
  const manifestPath = pilotManifestArgument(args);
  const closedLoopManifestPath = closedLoopManifestArgument(args);
  const extensionManifestPath = extensionManifestArgument(args);
  const githubToken = environment.GH_TOKEN ?? environment.GITHUB_TOKEN ?? null;
  const pilotVerification = manifestPath
    ? await verify(manifestPath, { candidateSha })
    : null;
  const pilotTargetVerification = manifestPath
    ? await verifyTargets(manifestPath, { candidateSha, githubToken })
    : null;
  const growthVerification = closedLoopManifestPath
    ? await verifyGrowth(closedLoopManifestPath)
    : null;
  const extensionVerification = extensionManifestPath
    ? await verifyExtensions(extensionManifestPath, { candidateSha })
    : null;
  const result = await build({
    candidateSha,
    pilotVerification,
    pilotTargetVerification,
    growthVerification,
    extensionVerification,
    githubToken,
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) await runPublicGrowthReport();
