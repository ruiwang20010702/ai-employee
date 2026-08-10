import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { safeCodexEnvironment } from "../src/codex-environment.mjs";

if (process.env.AI_EMPLOYEE_CONFIG_FILE) {
  await applyProductionConfigFile();
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const allowedPostgresEnvironmentNames = [
  "PGCHANNELBINDING",
  "PGCONNECT_TIMEOUT",
  "PGSSLCERT",
  "PGSSLCRL",
  "PGSSLCRLDIR",
  "PGSSLKEY",
  "PGSSLMAXPROTOCOLVERSION",
  "PGSSLMINPROTOCOLVERSION",
  "PGSSLROOTCERT",
];

function databaseEnvironment(databaseUrl, executable, source = process.env) {
  const parsed = new URL(databaseUrl);
  const environment = safeCodexEnvironment(executable, source);
  for (const name of allowedPostgresEnvironmentNames) {
    if (typeof source[name] === "string") environment[name] = source[name];
  }
  return {
    ...environment,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: parsed.pathname.slice(1),
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGSSLMODE: source.DATABASE_SSL === "true" ? "verify-full" : "disable",
  };
}

const databaseUrl = required("DATABASE_URL");
const backupKeyText = required("AI_EMPLOYEE_BACKUP_KEY");
const backupKey = Buffer.from(backupKeyText, "base64");
if (backupKey.length !== 32 || backupKey.toString("base64") !== backupKeyText) {
  throw new Error("AI_EMPLOYEE_BACKUP_KEY must be a base64 encoded 32-byte key");
}
const backupDirectory = resolve(
  process.env.AI_EMPLOYEE_BACKUP_DIRECTORY ?? ".runtime/backups",
);
await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const filename = `ai-employee-${timestamp}.dump.enc`;
const destination = join(backupDirectory, filename);
const partialDestination = `${destination}.partial`;
const metadataPath = `${destination}.json`;
const partialMetadataPath = `${metadataPath}.partial`;
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", backupKey, iv);
const pgDumpPath = process.env.PG_DUMP_PATH ?? "pg_dump";
const dump = spawn(
  pgDumpPath,
  ["--format=custom", "--no-owner", "--no-privileges"],
  {
    env: databaseEnvironment(databaseUrl, pgDumpPath),
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const dumpExit = new Promise((resolveExit, rejectExit) => {
  dump.once("error", rejectExit);
  dump.once("close", resolveExit);
});
let stderr = "";
dump.stderr.setEncoding("utf8");
dump.stderr.on("data", (chunk) => {
  stderr += chunk;
});
try {
  const [, exitCode] = await Promise.all([
    pipeline(
      dump.stdout,
      cipher,
      createWriteStream(partialDestination, {
        mode: 0o600,
        flags: "wx",
      }),
    ),
    dumpExit,
  ]);
  if (exitCode !== 0) {
    throw new Error(`pg_dump failed (${exitCode}): ${stderr.trim()}`);
  }
  await chmod(partialDestination, 0o600);
  await writeFile(
    partialMetadataPath,
    `${JSON.stringify(
      {
        version: 1,
        file: basename(destination),
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: "wx" },
  );
  await rename(partialMetadataPath, metadataPath);
  await rename(partialDestination, destination);
  console.log(JSON.stringify({ completed: true }));
} catch (error) {
  dump.kill("SIGTERM");
  await Promise.all([
    rm(partialDestination, { force: true }),
    rm(partialMetadataPath, { force: true }),
  ]);
  throw error;
}
