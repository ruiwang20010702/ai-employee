import { randomUUID } from "node:crypto";
import { chmod, lstat, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createAdminPasswordHash,
  createAdminSessionManager,
  normalizeAdminLoginIdentifiers,
  validateAdminPassword,
} from "./admin-session-auth.mjs";
import {
  applyProductionConfigFile,
  defaultProductionConfigPath,
} from "./production-config-file.mjs";

function validateSessionTtl(sessionTtlMs) {
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 300_000 || sessionTtlMs > 86_400_000) {
    throw new Error("Admin session TTL must be between 300000 and 86400000 milliseconds");
  }
}

async function readProtectedConfig(configPath) {
  const destination = resolve(configPath);
  const metadata = await lstat(destination);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Production config must be a regular non-symlink file");
  }
  const { values } = await applyProductionConfigFile({
    path: destination,
    environment: {},
    resolveSecrets: false,
  });
  return { destination, values };
}

export async function persistAdminLoginConfiguration({
  configPath = defaultProductionConfigPath(),
  identifiers,
  passwordHash,
  sessionTtlMs = 28_800_000,
} = {}) {
  const normalizedIdentifiers = normalizeAdminLoginIdentifiers(identifiers);
  validateSessionTtl(sessionTtlMs);
  createAdminSessionManager({
    identifiers: normalizedIdentifiers,
    passwordHash,
    sessionTtlMs,
  });
  const { destination, values } = await readProtectedConfig(configPath);
  if (
    String(values.AI_EMPLOYEE_ADMIN_LOGIN_IDENTIFIERS ?? "").trim() ||
    String(values.AI_EMPLOYEE_ADMIN_PASSWORD_HASH ?? "").trim()
  ) {
    throw new Error("Admin login is already configured");
  }
  const temporaryPath = resolve(
    dirname(destination),
    `.admin-login-${randomUUID()}.tmp`,
  );
  const next = {
    ...values,
    AI_EMPLOYEE_ADMIN_LOGIN_IDENTIFIERS: normalizedIdentifiers.join(","),
    AI_EMPLOYEE_ADMIN_PASSWORD_HASH: passwordHash,
    AI_EMPLOYEE_ADMIN_SESSION_TTL_MS: sessionTtlMs,
  };
  try {
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, destination);
    await chmod(destination, 0o600);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return {
    configured: true,
    dryRun: false,
    configPath: destination,
    identifiers: normalizedIdentifiers,
    sessionTtlMs,
    passwordStored: false,
    passwordHashPrinted: false,
    legacyTokensPreserved: true,
    restartRequired: false,
  };
}

export async function configureAdminLogin({
  configPath = defaultProductionConfigPath(),
  identifiers,
  password,
  sessionTtlMs = 28_800_000,
  apply = false,
} = {}) {
  const normalizedIdentifiers = normalizeAdminLoginIdentifiers(identifiers);
  validateAdminPassword(password, { identifiers: normalizedIdentifiers });
  validateSessionTtl(sessionTtlMs);
  const { destination } = await readProtectedConfig(configPath);
  const summary = {
    configured: false,
    dryRun: !apply,
    configPath: destination,
    identifiers: normalizedIdentifiers,
    sessionTtlMs,
    passwordStored: false,
    passwordHashPrinted: false,
    legacyTokensPreserved: true,
    restartRequired: apply,
  };
  if (!apply) return summary;
  const passwordHash = await createAdminPasswordHash(password, {
    identifiers: normalizedIdentifiers,
  });
  const persisted = await persistAdminLoginConfiguration({
    configPath: destination,
    identifiers: normalizedIdentifiers,
    passwordHash,
    sessionTtlMs,
  });
  return { ...persisted, restartRequired: true };
}
