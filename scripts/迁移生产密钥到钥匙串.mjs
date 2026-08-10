import { timingSafeEqual, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyProductionConfigFile,
  defaultProductionConfigPath,
} from "../src/production-config-file.mjs";
import { isMainModule } from "../src/main-module.mjs";
import {
  isSecretReference,
  resolveSecretReference,
} from "../src/secret-provider.mjs";

export const keychainMigrationEntries = Object.freeze([
  ["DATABASE_URL", "database-url"],
  ["AI_EMPLOYEE_DATA_KEY", "data-key"],
  ["AI_EMPLOYEE_BACKUP_KEY", "backup-key"],
  ["AI_EMPLOYEE_ADMIN_READ_TOKEN", "admin-read-token"],
  ["AI_EMPLOYEE_ADMIN_WRITE_TOKEN", "admin-write-token"],
]);

const defaultService = "ai-employee-production";
const keychainWriterPath = fileURLToPath(
  new URL("./写入钥匙串.exp", import.meta.url),
);

function secretEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer);
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

function safeEnvironment() {
  return Object.fromEntries(
    ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL"]
      .filter((name) => typeof process.env[name] === "string")
      .map((name) => [name, process.env[name]]),
  );
}

export async function writeMacosKeychainSecret(service, account, secret) {
  if (process.platform !== "darwin") {
    throw new Error("macOS Keychain is unavailable on this platform");
  }
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      "/usr/bin/expect",
      [keychainWriterPath, service, account],
      {
        env: {
          ...safeEnvironment(),
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        },
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("macOS Keychain write timed out"));
    }, 30_000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("macOS Keychain write failed"));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error("macOS Keychain write failed"));
    });
    child.stdin.end(secret);
  });
}

export async function deleteMacosKeychainSecret(service, account) {
  if (process.platform !== "darwin") {
    throw new Error("macOS Keychain is unavailable on this platform");
  }
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      "/usr/bin/security",
      ["delete-generic-password", "-s", service, "-a", account],
      {
        env: { ...safeEnvironment(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        stdio: "ignore",
      },
    );
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("macOS Keychain delete timed out"));
    }, 10_000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("macOS Keychain delete failed"));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0 || code === 44) resolvePromise();
      else reject(new Error("macOS Keychain delete failed"));
    });
  });
}

async function writeProtectedJson(path, values) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(values, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function migrateProductionSecretsToKeychain({
  configPath = defaultProductionConfigPath(),
  apply = false,
  service = defaultService,
  now = new Date(),
  platform = process.platform,
  keychainWriter = writeMacosKeychainSecret,
  keychainDeleter = deleteMacosKeychainSecret,
  keychainReader,
} = {}) {
  const destination = resolve(configPath);
  const { values } = await applyProductionConfigFile({
    path: destination,
    environment: {},
    resolveSecrets: false,
  });
  const plannedKeys = [];
  const alreadyExternalKeys = [];
  const secrets = new Map();

  for (const [key, account] of keychainMigrationEntries) {
    const targetReference = `keychain://${service}/${account}`;
    const current = values[key];
    if (current === targetReference) {
      alreadyExternalKeys.push(key);
      continue;
    }
    if (typeof current !== "string" || current.length === 0) {
      throw new Error(`Production secret is missing: ${key}`);
    }
    if (isSecretReference(current)) {
      throw new Error(`Production secret already uses another external reference: ${key}`);
    }
    plannedKeys.push(key);
    secrets.set(key, current);
  }

  if (!apply) {
    return {
      completed: false,
      dryRun: true,
      service,
      plannedKeys,
      alreadyExternalKeys,
      configUpdated: false,
      secretsPrinted: false,
    };
  }
  if (platform !== "darwin") {
    throw new Error("Production Keychain migration requires macOS");
  }

  const reader = keychainReader ?? (async (targetService, account) => {
    const result = await resolveSecretReference(
      `keychain://${encodeURIComponent(targetService)}/${encodeURIComponent(account)}`,
    );
    return result.value;
  });

  if (plannedKeys.length === 0) {
    for (const [key, account] of keychainMigrationEntries) {
      const resolved = await reader(service, account);
      if (typeof resolved !== "string" || resolved.length === 0) {
        throw new Error(`Keychain readback failed: ${key}`);
      }
    }
    return {
      completed: true,
      dryRun: false,
      service,
      migratedKeys: [],
      alreadyExternalKeys,
      configUpdated: false,
      rollbackSnapshot: null,
      secretsPrinted: false,
    };
  }

  const reusableAccounts = new Set();
  for (const [key, account] of keychainMigrationEntries) {
    if (!secrets.has(key)) continue;
    const existing = await readExistingSecret(reader, service, account);
    if (existing === null) continue;
    if (!secretEquals(secrets.get(key), existing)) {
      throw new Error(`Keychain target already contains another value: ${key}`);
    }
    reusableAccounts.add(account);
  }

  const createdAccounts = [];
  let currentKey = "unknown";
  let currentAccount = null;
  let currentSecret = null;
  try {
    for (const [key, account] of keychainMigrationEntries) {
      if (!secrets.has(key)) continue;
      if (reusableAccounts.has(account)) continue;
      currentKey = key;
      currentAccount = account;
      currentSecret = secrets.get(key);
      await keychainWriter(service, account, currentSecret);
      createdAccounts.push(account);
      const readback = await reader(service, account);
      if (!secretEquals(currentSecret, readback)) {
        throw new Error("readback mismatch");
      }
    }
  } catch {
    let cleanupUncertain = false;
    if (currentAccount && !createdAccounts.includes(currentAccount)) {
      try {
        const currentValue = await readExistingSecret(reader, service, currentAccount);
        if (currentValue !== null && secretEquals(currentSecret, currentValue)) {
          createdAccounts.push(currentAccount);
        }
      } catch {
        cleanupUncertain = true;
      }
    }
    const cleanup = await Promise.allSettled(
      createdAccounts.map((account) => keychainDeleter(service, account)),
    );
    if (cleanupUncertain || cleanup.some((result) => result.status === "rejected")) {
      throw new Error(`Keychain write failed and cleanup is incomplete: ${currentKey}`);
    }
    throw new Error(`Keychain write or readback failed: ${currentKey}`);
  }

  const next = { ...values };
  for (const [key, account] of keychainMigrationEntries) {
    next[key] = `keychain://${service}/${account}`;
  }
  const directory = dirname(destination);
  const backupDirectory = join(directory, "keychain-migration-backups");
  const timestamp = now.toISOString().replaceAll(/[:.]/gu, "-");
  const rollbackSnapshot = join(backupDirectory, `production-${timestamp}.json`);
  const temporaryPath = join(directory, `.production-keychain-${randomUUID()}.tmp`);
  let snapshotCreated = false;
  let configCommitted = false;
  try {
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    await chmod(backupDirectory, 0o700);
    await copyFile(destination, rollbackSnapshot, constants.COPYFILE_EXCL);
    snapshotCreated = true;
    await chmod(rollbackSnapshot, 0o600);
    await writeProtectedJson(temporaryPath, next);
    await applyProductionConfigFile({
      path: temporaryPath,
      environment: {},
      secretResolverOptions: { keychainReader: reader },
    });
    await rename(temporaryPath, destination);
    configCommitted = true;
  } catch {
    if (!configCommitted) {
      const cleanup = await Promise.allSettled([
        ...createdAccounts.map((account) => keychainDeleter(service, account)),
        unlink(temporaryPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        }),
        snapshotCreated
          ? unlink(rollbackSnapshot)
          : Promise.resolve(),
      ]);
      if (cleanup.some((result) => result.status === "rejected")) {
        throw new Error("Keychain migration failed and cleanup is incomplete");
      }
    }
    throw new Error("Keychain migration failed before configuration commit");
  } finally {
    if (configCommitted) {
      await unlink(temporaryPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  return {
    completed: true,
    dryRun: false,
    service,
    migratedKeys: plannedKeys,
    reusedExistingKeys: keychainMigrationEntries
      .filter(([, account]) => reusableAccounts.has(account))
      .map(([key]) => key),
    alreadyExternalKeys,
    configUpdated: true,
    rollbackSnapshot,
    secretsPrinted: false,
  };
}

if (isMainModule(import.meta.url)) {
  const result = await migrateProductionSecretsToKeychain({
    configPath: process.env.AI_EMPLOYEE_CONFIG_FILE,
    apply: process.argv.includes("--apply"),
  });
  console.log(JSON.stringify(result, null, 2));
}
