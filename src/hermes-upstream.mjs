import { resolve } from "node:path";

const expectedRepository = "https://github.com/NousResearch/hermes-agent.git";
const fullSha = /^[a-f0-9]{40}$/u;
const releaseTag = /^v\d{4}\.\d{1,2}\.\d{1,2}$/u;
const version = /^\d+\.\d+\.\d+$/u;

function exactString(value, name) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`Hermes upstream ${name} is invalid`);
  }
  return value;
}

export function validateHermesUpstreamLock(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error("Hermes upstream lock must be an object");
  }
  if (input.schemaVersion !== 1) {
    throw new Error("Hermes upstream lock schemaVersion must be 1");
  }
  const repository = exactString(input.repository, "repository");
  let repositoryUrl;
  try {
    repositoryUrl = new URL(repository);
  } catch {
    throw new Error("Hermes upstream repository URL is invalid");
  }
  if (
    repository !== expectedRepository ||
    repositoryUrl.protocol !== "https:" ||
    repositoryUrl.username ||
    repositoryUrl.password ||
    repositoryUrl.search ||
    repositoryUrl.hash
  ) {
    throw new Error("Hermes upstream repository must be the credential-free official HTTPS repository");
  }
  const release = exactString(input.release, "release");
  if (!releaseTag.test(release)) {
    throw new Error("Hermes upstream release must be a dated immutable tag");
  }
  const packageVersion = exactString(input.version, "version");
  if (!version.test(packageVersion)) {
    throw new Error("Hermes upstream package version is invalid");
  }
  const commit = exactString(input.commit, "commit");
  if (!fullSha.test(commit)) {
    throw new Error("Hermes upstream commit must be a full SHA");
  }
  if (input.license !== "MIT") {
    throw new Error("Hermes upstream license must be MIT");
  }
  const licenseSha256 = exactString(input.licenseSha256, "licenseSha256");
  if (!/^[a-f0-9]{64}$/u.test(licenseSha256)) {
    throw new Error("Hermes upstream license digest is invalid");
  }
  if (input.pythonRequires !== ">=3.11,<3.14") {
    throw new Error("Hermes upstream Python range changed");
  }
  return {
    schemaVersion: 1,
    repository,
    release,
    version: packageVersion,
    commit,
    license: "MIT",
    licenseSha256,
    pythonRequires: ">=3.11,<3.14",
  };
}

export function hermesRuntimeLayout(projectRoot) {
  const root = resolve(projectRoot, ".runtime", "hermes-poc");
  return {
    root,
    source: resolve(root, "upstream"),
    patched: resolve(root, "patched"),
    venv: resolve(root, "venv"),
    state: resolve(root, "state"),
  };
}
