import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const contractTypes = new Set([
  "message_adapter",
  "work_event_adapter",
  "workspace_adapter",
  "work_recipe",
]);
const contractVersion = "1.0";
const statuses = new Set(["reference", "experimental"]);

function text(value, name, maximum = 500) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

export function validateExtensionManifest(input) {
  if (!input || Array.isArray(input) || typeof input !== "object" || input.version !== 1) {
    throw new Error("Extension manifest version must be 1");
  }
  const id = text(input.id, "extension.id", 100);
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(id)) throw new Error("extension.id is invalid");
  if (!contractTypes.has(input.contract)) throw new Error("extension.contract is unsupported");
  if (input.contractVersion !== contractVersion) {
    throw new Error(`extension.contractVersion must be ${contractVersion}`);
  }
  if (!statuses.has(input.status)) throw new Error("extension.status is unsupported");
  const permissions = Array.isArray(input.permissions)
    ? [...new Set(input.permissions.map((value) => text(value, "extension.permissions", 200)))]
    : null;
  if (!permissions || permissions.length > 50) throw new Error("extension.permissions is invalid");
  const secrets = Array.isArray(input.runtimeSecrets)
    ? [...new Set(input.runtimeSecrets.map((value) => text(value, "extension.runtimeSecrets", 100)))]
    : null;
  if (!secrets || secrets.some((name) => !/^[A-Z][A-Z0-9_]{2,99}$/u.test(name))) {
    throw new Error("extension.runtimeSecrets must contain environment variable names only");
  }
  const guarantees = {
    allowlist: input.guarantees?.allowlist === true,
    idempotency: input.guarantees?.idempotency === true,
    humanTakeover: input.guarantees?.humanTakeover === true,
    targetReadback: input.guarantees?.targetReadback === true,
    unknownOutcome: input.guarantees?.unknownOutcome === true,
  };
  if (!Object.values(guarantees).every(Boolean)) {
    throw new Error("extension.guarantees must explicitly enable every safety guarantee");
  }
  return {
    version: 1,
    id,
    name: text(input.name, "extension.name", 200),
    platform: text(input.platform, "extension.platform", 100),
    contract: input.contract,
    contractVersion,
    status: input.status,
    permissions,
    runtimeSecrets: secrets,
    guarantees,
  };
}

export async function loadExtensionManifests(directory) {
  const root = directory instanceof URL ? fileURLToPath(directory) : directory;
  const result = new Map();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const manifest = validateExtensionManifest(JSON.parse(await readFile(join(root, entry.name), "utf8")));
    if (result.has(manifest.id)) throw new Error(`Duplicate extension: ${manifest.id}`);
    result.set(manifest.id, manifest);
  }
  return result;
}
