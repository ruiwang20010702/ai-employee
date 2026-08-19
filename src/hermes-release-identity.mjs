import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const fullSha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;

export const requiredHermesReleaseFiles = Object.freeze([
  "foursday/src/hermes-gateway-launcher.mjs",
  "foursday/src/hermes-dws-sidecar.mjs",
  "foursday/src/hermes-personal-memory-context.mjs",
  "runtime/patched/gateway/session.py",
  "runtime/patched/gateway/platforms/base.py",
  "runtime/patched/gateway/run.py",
  "runtime/state/.hermes/plugins/dws-personal/adapter.py",
  "runtime/state/.hermes/plugins/dws-personal/bridge.py",
  "runtime/state/.hermes/plugins/dws-personal/memory.py",
  "runtime/state/.hermes/plugins/dws-personal/__init__.py",
  "runtime/state/.hermes/plugins/dws-personal/plugin.yaml",
  "runtime/state/.hermes/plugins/foursday-high-risk-boundary/__init__.py",
  "runtime/state/.hermes/plugins/foursday-high-risk-boundary/plugin.yaml",
  "runtime/state/.hermes/plugins/project_router/__init__.py",
  "runtime/state/.hermes/plugins/project_router/registry.py",
  "runtime/state/.hermes/plugins/project_router/plugin.yaml",
  "runtime/state/.hermes/skills/foursday-project-work/SKILL.md",
  "runtime/state/.hermes/config.yaml",
  "runtime/state/.hermes/SOUL.md",
  "runtime/state/projects.production.json",
  "runtime/state/projects.active.json",
]);

function safeRelative(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    !isAbsolute(value) &&
    !value.split("/").includes("..") &&
    !value.includes("//");
}

async function canonicalRoot(value) {
  if (!isAbsolute(String(value ?? ""))) {
    throw new Error("Hermes release root must be absolute");
  }
  const lexical = resolve(value);
  const metadata = await lstat(lexical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Hermes release root must be a canonical directory");
  }
  if (await realpath(lexical) !== lexical) {
    throw new Error("Hermes release root must not use a symlink");
  }
  return lexical;
}

async function fileDigest(root, path) {
  if (!safeRelative(path)) throw new Error("Hermes release file path is invalid");
  const lexical = resolve(root, path);
  const difference = relative(root, lexical);
  if (difference.startsWith("..") || isAbsolute(difference)) {
    throw new Error("Hermes release file escaped its root");
  }
  const metadata = await lstat(lexical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Hermes release file must be regular: ${path}`);
  }
  const canonical = await realpath(lexical);
  const canonicalDifference = relative(root, canonical);
  if (canonicalDifference.startsWith("..") || isAbsolute(canonicalDifference)) {
    throw new Error(`Hermes release file escaped its root: ${path}`);
  }
  return createHash("sha256").update(await readFile(canonical)).digest("hex");
}

export async function createHermesReleaseIdentity({
  releaseSha,
  releaseRoot,
  createdAt = new Date(),
}) {
  if (!fullSha.test(String(releaseSha ?? ""))) {
    throw new Error("Hermes release identity requires a full SHA");
  }
  const root = await canonicalRoot(releaseRoot);
  const files = {};
  for (const path of requiredHermesReleaseFiles) {
    files[path] = await fileDigest(root, path);
  }
  return {
    schema: "foursday-hermes-release-identity/v1",
    releaseSha,
    createdAt: createdAt.toISOString(),
    files,
  };
}

export async function verifyHermesReleaseIdentity({
  identity,
  releaseSha,
  releaseRoot,
}) {
  if (
    !identity ||
    Array.isArray(identity) ||
    identity.schema !== "foursday-hermes-release-identity/v1" ||
    identity.releaseSha !== releaseSha ||
    !identity.files ||
    Array.isArray(identity.files) ||
    typeof identity.files !== "object" ||
    Object.keys(identity.files).length !== requiredHermesReleaseFiles.length
  ) throw new Error("Hermes release identity is invalid");
  const root = await canonicalRoot(releaseRoot);
  for (const path of requiredHermesReleaseFiles) {
    const expected = identity.files[path];
    if (!digest.test(String(expected ?? ""))) {
      throw new Error(`Hermes release identity digest is invalid: ${path}`);
    }
    if (await fileDigest(root, path) !== expected) {
      throw new Error(`Hermes release file changed after identity creation: ${path}`);
    }
  }
  return {
    valid: true,
    releaseSha,
    fileCount: requiredHermesReleaseFiles.length,
  };
}
