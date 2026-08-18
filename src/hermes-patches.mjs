const fullSha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
const patchPath = /^hermes\/patches\/[a-z0-9][a-z0-9._-]*\.patch$/u;

function text(value, name, maximum) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximum
  ) {
    throw new Error(`Hermes patch ${name} is invalid`);
  }
  return value;
}

export function validateHermesPatchLock(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error("Hermes patch lock must be an object");
  }
  if (input.schemaVersion !== 1) {
    throw new Error("Hermes patch lock schemaVersion must be 1");
  }
  const baseCommit = text(input.baseCommit, "baseCommit", 40);
  if (!fullSha.test(baseCommit)) {
    throw new Error("Hermes patch baseCommit must be a full SHA");
  }
  if (!Array.isArray(input.patches) || input.patches.length < 1 || input.patches.length > 20) {
    throw new Error("Hermes patch lock must contain 1-20 patches");
  }
  const seen = new Set();
  const patches = input.patches.map((entry) => {
    if (!entry || Array.isArray(entry) || typeof entry !== "object") {
      throw new Error("Hermes patch entry must be an object");
    }
    const path = text(entry.path, "path", 300);
    const sha256 = text(entry.sha256, "sha256", 64);
    const purpose = text(entry.purpose, "purpose", 500);
    if (!patchPath.test(path) || seen.has(path)) {
      throw new Error("Hermes patch paths must be unique normalized repository paths");
    }
    if (!digest.test(sha256)) {
      throw new Error("Hermes patch sha256 is invalid");
    }
    seen.add(path);
    return { path, sha256, purpose };
  });
  return { schemaVersion: 1, baseCommit, patches };
}
