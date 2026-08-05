import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  applyProductionConfigFile,
  defaultProductionConfigPath,
} from "../src/production-config-file.mjs";
import { isMainModule } from "../src/main-module.mjs";
import { isSecretReference } from "../src/secret-provider.mjs";

function token() {
  return randomBytes(32).toString("hex");
}

export async function rotateAdminTokens({
  configPath = defaultProductionConfigPath(),
  now = new Date(),
} = {}) {
  const destination = resolve(configPath);
  const { values } = await applyProductionConfigFile({
    path: destination,
    environment: {},
    resolveSecrets: false,
  });
  if (
    isSecretReference(values.AI_EMPLOYEE_ADMIN_READ_TOKEN) ||
    isSecretReference(values.AI_EMPLOYEE_ADMIN_WRITE_TOKEN)
  ) {
    throw new Error("Externally managed admin tokens must be rotated in their secret store");
  }
  const directory = dirname(destination);
  const backupDirectory = join(directory, "config-backups");
  const timestamp = now.toISOString().replaceAll(/[:.]/gu, "-");
  const backupPath = join(backupDirectory, `production-${timestamp}.json`);
  const temporaryPath = join(directory, `.production-${randomUUID()}.tmp`);
  const next = {
    ...values,
    AI_EMPLOYEE_ADMIN_READ_TOKEN: token(),
    AI_EMPLOYEE_ADMIN_WRITE_TOKEN: token(),
  };
  if (
    next.AI_EMPLOYEE_ADMIN_READ_TOKEN ===
    next.AI_EMPLOYEE_ADMIN_WRITE_TOKEN
  ) {
    throw new Error("Generated admin tokens must be independent");
  }
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await copyFile(destination, backupPath, constants.COPYFILE_EXCL);
  await chmod(backupPath, 0o600);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, destination);
    await chmod(destination, 0o600);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return {
    rotated: true,
    configPath: destination,
    backupPath,
    tokenBytes: 32,
    secretsPrinted: false,
  };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  if (!process.argv.includes("--yes")) {
    throw new Error("Refusing to rotate admin tokens without --yes");
  }
  const result = await rotateAdminTokens({
    configPath: process.env.AI_EMPLOYEE_CONFIG_FILE,
  });
  console.log(JSON.stringify(result, null, 2));
}
