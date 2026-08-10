import { randomBytes } from "node:crypto";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { resolveSecretReference } from "../src/secret-provider.mjs";
import { isMainModule } from "../src/main-module.mjs";
import {
  deleteMacosKeychainSecret,
  writeMacosKeychainSecret,
} from "./迁移生产密钥到钥匙串.mjs";
const generatedEntries = Object.freeze([
  ["AI_EMPLOYEE_DATA_KEY", "data-key", () => randomBytes(32).toString("base64")],
  ["AI_EMPLOYEE_BACKUP_KEY", "backup-key", () => randomBytes(32).toString("base64")],
  ["AI_EMPLOYEE_ADMIN_READ_TOKEN", "admin-read-token", () => randomBytes(32).toString("hex")],
  ["AI_EMPLOYEE_ADMIN_WRITE_TOKEN", "admin-write-token", () => randomBytes(32).toString("hex")],
]);

function decodedReference(value) {
  const match = String(value).match(/^keychain:\/\/([^/]+)\/([^/]+)$/u);
  if (!match) throw new Error("Generated secret must use a macOS Keychain reference");
  const service = decodeURIComponent(match[1]);
  const account = decodeURIComponent(match[2]);
  if (!service || !account || /[\0\r\n]/u.test(`${service}${account}`)) {
    throw new Error("Generated secret Keychain reference is invalid");
  }
  return { service, account };
}

async function readExistingSecret(reader, service, account) {
  try {
    const value = await reader(service, account);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch (error) {
    if (error?.code === 44) return null;
    throw new Error("Keychain availability check failed");
  }
}

function canonicalBase64Key(value) {
  const decoded = Buffer.from(String(value), "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

function existingSecretsValid(values) {
  const [dataKey, backupKey, readToken, writeToken] = values;
  return canonicalBase64Key(dataKey) &&
    canonicalBase64Key(backupKey) &&
    dataKey !== backupKey &&
    Buffer.byteLength(readToken) >= 32 &&
    Buffer.byteLength(writeToken) >= 32 &&
    readToken !== writeToken;
}

export async function provisionGeneratedKeychainSecrets({
  configPath,
  apply = false,
  platform = process.platform,
  keychainWriter = writeMacosKeychainSecret,
  keychainReader = async (service, account) => (
    resolveSecretReference(`keychain://${encodeURIComponent(service)}/${encodeURIComponent(account)}`)
      .then((result) => result.value)
  ),
  keychainDeleter = deleteMacosKeychainSecret,
} = {}) {
  const { values } = await applyProductionConfigFile({
    path: configPath,
    environment: {},
    resolveSecrets: false,
  });
  const entries = generatedEntries.map(([key, expectedAccount, generator]) => {
    const reference = decodedReference(values[key]);
    if (reference.account !== expectedAccount) {
      throw new Error(`Unexpected Keychain account for ${key}`);
    }
    return { key, ...reference, generator };
  });
  if (new Set(entries.map(({ service }) => service)).size !== 1) {
    throw new Error("Generated secrets must use one isolated Keychain service");
  }
  const summary = {
    completed: false,
    dryRun: !apply,
    service: entries[0].service,
    plannedKeys: entries.map(({ key }) => key),
    secretsPrinted: false,
  };
  if (!apply) return summary;
  if (platform !== "darwin") throw new Error("Keychain provisioning requires macOS");

  const existing = [];
  for (const { service, account } of entries) {
    existing.push(await readExistingSecret(keychainReader, service, account));
  }
  const existingCount = existing.filter((value) => value !== null).length;
  if (existingCount === entries.length) {
    if (!existingSecretsValid(existing)) {
      throw new Error("Existing Keychain entries failed validation");
    }
    return {
      ...summary,
      completed: true,
      dryRun: false,
      provisionedKeys: [],
      alreadyProvisionedKeys: entries.map(({ key }) => key),
    };
  }
  if (existingCount > 0) {
    throw new Error(`Keychain provisioning requires manual cleanup: ${existingCount}/${entries.length} entries already exist`);
  }

  const created = [];
  let currentKey = "unknown";
  let currentEntry = null;
  let currentSecret = null;
  try {
    for (const { key, service, account, generator } of entries) {
      currentKey = key;
      currentEntry = { service, account };
      currentSecret = generator();
      await keychainWriter(service, account, currentSecret);
      created.push({ service, account });
      const readback = await keychainReader(service, account);
      if (readback !== currentSecret) throw new Error(`Keychain readback failed: ${key}`);
    }
  } catch {
    let cleanupUncertain = false;
    if (
      currentEntry &&
      !created.some(({ service, account }) => (
        service === currentEntry.service && account === currentEntry.account
      ))
    ) {
      try {
        const currentValue = await readExistingSecret(
          keychainReader,
          currentEntry.service,
          currentEntry.account,
        );
        if (currentValue === currentSecret) created.push(currentEntry);
      } catch {
        cleanupUncertain = true;
      }
    }
    const cleanup = await Promise.allSettled(
      created.map(({ service, account }) => keychainDeleter(service, account)),
    );
    if (cleanupUncertain || cleanup.some((result) => result.status === "rejected")) {
      throw new Error(`Keychain provisioning failed and cleanup is incomplete: ${currentKey}`);
    }
    throw new Error(`Keychain provisioning failed: ${currentKey}`);
  }
  return {
    ...summary,
    completed: true,
    dryRun: false,
    provisionedKeys: entries.map(({ key }) => key),
  };
}

if (isMainModule(import.meta.url)) {
  const result = await provisionGeneratedKeychainSecrets({
    configPath: process.env.AI_EMPLOYEE_CONFIG_FILE,
    apply: process.argv.includes("--apply"),
  });
  console.log(JSON.stringify(result, null, 2));
}
