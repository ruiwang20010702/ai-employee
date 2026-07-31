import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createDecipheriv } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";

if (process.env.AI_EMPLOYEE_CONFIG_FILE) {
  await applyProductionConfigFile();
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function databaseEnvironment(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: parsed.pathname.slice(1),
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGSSLMODE: process.env.DATABASE_SSL === "true" ? "verify-full" : "disable",
  };
}

if (process.env.AI_EMPLOYEE_CONFIRM_RESTORE !== "yes") {
  throw new Error(
    "Set AI_EMPLOYEE_CONFIRM_RESTORE=yes after confirming the target database",
  );
}
const encryptedPath = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("Usage: node scripts/恢复数据库.mjs <backup.dump.enc>");
}
const metadata = JSON.parse(
  await readFile(`${encryptedPath}.json`, "utf8"),
);
if (
  metadata.version !== 1 ||
  metadata.algorithm !== "aes-256-gcm" ||
  metadata.file !== basename(encryptedPath)
) {
  throw new Error("Backup metadata does not match the encrypted backup");
}
const iv = Buffer.from(metadata.iv ?? "", "base64");
const authTag = Buffer.from(metadata.authTag ?? "", "base64");
if (iv.length !== 12 || authTag.length !== 16) {
  throw new Error("Backup metadata has an invalid IV or authentication tag");
}
const backupKeyText = required("AI_EMPLOYEE_BACKUP_KEY");
const backupKey = Buffer.from(backupKeyText, "base64");
if (backupKey.length !== 32 || backupKey.toString("base64") !== backupKeyText) {
  throw new Error("AI_EMPLOYEE_BACKUP_KEY must be a base64 encoded 32-byte key");
}
const decipher = createDecipheriv(
  "aes-256-gcm",
  backupKey,
  iv,
);
decipher.setAuthTag(authTag);
const restoreEnvironment = databaseEnvironment(required("DATABASE_URL"));
const restore = spawn(
  process.env.PG_RESTORE_PATH ?? "pg_restore",
  [
    "--dbname",
    restoreEnvironment.PGDATABASE,
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
  ],
  {
    env: restoreEnvironment,
    stdio: ["pipe", "inherit", "pipe"],
  },
);
const restoreExit = new Promise((resolveExit, rejectExit) => {
  restore.once("error", rejectExit);
  restore.once("close", resolveExit);
});
let stderr = "";
restore.stderr.setEncoding("utf8");
restore.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const [, exitCode] = await Promise.all([
  pipeline(createReadStream(encryptedPath), decipher, restore.stdin),
  restoreExit,
]);
if (exitCode !== 0) {
  throw new Error(`pg_restore failed (${exitCode}): ${stderr.trim()}`);
}
console.log(JSON.stringify({ restored: true }));
