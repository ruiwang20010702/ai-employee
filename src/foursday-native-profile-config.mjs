import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isSecretReference, secretConfigKeys } from "./secret-provider.mjs";

const execFileAsync = promisify(execFile);
const memoryPromoterJobName = "foursday-memory-promoter";

async function privateJson(path, label) {
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a private regular file`);
  }
  const value = JSON.parse(await readFile(absolute, "utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} is invalid`);
  }
  return { absolute, value };
}

function absoluteExecutable(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function scalar(values, name, fallback = "") {
  const value = values[name];
  return value == null ? String(fallback) : String(value);
}

function envLine(name, value) {
  return `${name}=${JSON.stringify(String(value))}`;
}

async function atomicWrite(path, content, { replace = false } = {}) {
  const current = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current) {
    if (!current.isFile() || current.isSymbolicLink() || (current.mode & 0o077) !== 0) {
      throw new Error("Foursday native profile config destination is unsafe");
    }
    if (await readFile(path, "utf8") === content) return { changed: false, backup: null };
    if (!replace) throw new Error("Foursday native profile config already exists with different content");
  }
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    let backup = null;
    if (current) {
      backup = `${path}.backup-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
      await copyFile(path, backup, constants.COPYFILE_EXCL);
      await chmod(backup, 0o600);
    }
    await rename(temporary, path);
    return { changed: true, backup };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function buildFoursdayNativeProfileConfiguration({
  layout,
  productionConfigPath,
  projectRegistryPath,
  nodePath,
  dwsPath,
} = {}) {
  const production = await privateJson(productionConfigPath, "Foursday production config");
  const registry = await privateJson(projectRegistryPath, "Foursday project registry");
  if (registry.value.schemaVersion !== 1 || !Array.isArray(registry.value.projects)) {
    throw new Error("Foursday project registry is invalid");
  }
  for (const key of secretConfigKeys) {
    if (key in production.value && !isSecretReference(production.value[key])) {
      throw new Error(`Foursday production secret must remain externally referenced: ${key}`);
    }
  }
  const node = absoluteExecutable(nodePath, "Hermes managed Node");
  const dws = absoluteExecutable(dwsPath, "DWS executable");
  await Promise.all([
    access(node, constants.X_OK),
    access(dws, constants.X_OK),
  ]);
  const localRoot = join(layout.profileDirectory, "local", "foursday");
  const stateRoot = join(localRoot, "state");
  const hostRoot = join(layout.profileDirectory, "host", "src");
  const targetConfig = join(localRoot, "production.json");
  const targetRegistry = join(localRoot, "projects.json");
  const environment = {
    FOURSDAY_NODE_PATH: node,
    FOURSDAY_DWS_SIDECAR: join(hostRoot, "hermes-dws-sidecar.mjs"),
    FOURSDAY_MEMORY_CONTEXT_SIDECAR: join(hostRoot, "hermes-personal-memory-context.mjs"),
    FOURSDAY_MEMORY_CANDIDATE_SIDECAR: join(hostRoot, "hermes-memory-candidate-sidecar.mjs"),
    FOURSDAY_PRODUCTION_CONFIG: targetConfig,
    FOURSDAY_PROJECT_REGISTRY: targetRegistry,
    FOURSDAY_FALLBACK_WORKSPACE: join(localRoot, "fallback"),
    FOURSDAY_ROUTE_STATE_FILE: join(stateRoot, "routes.json"),
    FOURSDAY_SHADOW_EVIDENCE_FILE: join(stateRoot, "shadow-evidence.jsonl"),
    FOURSDAY_HERMES_MODE: "shadow",
    FOURSDAY_MEMORY_HOME: layout.userHome,
    FOURSDAY_DWS_HOME: layout.userHome,
    DWS_PATH: dws,
    DWS_PERSONAL_ALLOWED_USERS: scalar(production.value, "DINGTALK_TARGET_USER_IDS"),
    DWS_PERSONAL_FETCH_USERS: scalar(production.value, "DINGTALK_TARGET_USER_IDS"),
    DWS_PERSONAL_ALLOWED_GROUPS: scalar(production.value, "DINGTALK_TARGET_GROUP_IDS"),
    DINGTALK_SELF_USER_ID: scalar(production.value, "DINGTALK_SELF_USER_ID"),
    DINGTALK_DATA_ROOT: join(layout.userHome, "Library", "Application Support", "DingTalkMac"),
    DWS_PERSONAL_STATE_FILE: join(stateRoot, "dws.json"),
    // Native shadow starts from a bounded ten-minute overlap. The existing
    // managed writer remains authoritative during migration; replaying the
    // legacy 72-hour bootstrap window would create needless duplicate work.
    DWS_PERSONAL_INITIAL_LOOKBACK_MS: "600000",
    DWS_PERSONAL_FALLBACK_MS: scalar(production.value, "DINGTALK_FALLBACK_MS", 300_000),
    DWS_PERSONAL_BUNDLE_QUIET_MS: scalar(production.value, "DINGTALK_QUIET_WINDOW_MS", 3_000),
    DWS_PERSONAL_BUNDLE_MAX_WAIT_MS: scalar(production.value, "AI_EMPLOYEE_BUNDLE_MAX_WAIT_MS", 8_000),
    DWS_PERSONAL_SEND_ENABLED: "false",
    CODEX_HOME: join(layout.userHome, ".codex"),
  };
  return {
    schema: "foursday-native-profile-config/v1",
    localRoot,
    stateRoot,
    targetConfig,
    targetRegistry,
    sourceConfig: production.absolute,
    sourceRegistry: registry.absolute,
    environment,
    envContent: `${Object.entries(environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => envLine(name, value))
      .join("\n")}\n`,
    secretsCopied: false,
    sendEnabled: false,
    mode: "shadow",
  };
}

export async function configureFoursdayNativeProfile(options = {}) {
  const plan = await buildFoursdayNativeProfileConfiguration(options);
  if (!options.apply) return { ...plan, apply: false, changed: false };
  await Promise.all([
    mkdir(plan.localRoot, { recursive: true, mode: 0o700 }),
    mkdir(plan.stateRoot, { recursive: true, mode: 0o700 }),
    mkdir(plan.environment.FOURSDAY_FALLBACK_WORKSPACE, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(plan.localRoot, 0o700),
    chmod(plan.stateRoot, 0o700),
    chmod(plan.environment.FOURSDAY_FALLBACK_WORKSPACE, 0o700),
  ]);
  const [configResult, registryResult, envResult] = await Promise.all([
    atomicWrite(
      plan.targetConfig,
      `${JSON.stringify(JSON.parse(await readFile(plan.sourceConfig, "utf8")), null, 2)}\n`,
      { replace: options.replace },
    ),
    atomicWrite(
      plan.targetRegistry,
      `${JSON.stringify(JSON.parse(await readFile(plan.sourceRegistry, "utf8")), null, 2)}\n`,
      { replace: options.replace },
    ),
    atomicWrite(join(options.layout.profileDirectory, ".env"), plan.envContent, {
      replace: options.replace,
    }),
  ]);
  return {
    ...plan,
    apply: true,
    changed: configResult.changed || registryResult.changed || envResult.changed,
    backupsCreated: [configResult.backup, registryResult.backup, envResult.backup]
      .filter(Boolean).length,
  };
}

function memoryPromoterJobMatches(job) {
  return Boolean(
    job?.name === memoryPromoterJobName &&
    job?.script === "foursday-memory-promoter.sh" &&
    job?.no_agent === true &&
    job?.enabled !== false &&
    job?.schedule?.kind === "interval" &&
    (Number(job?.schedule?.seconds) === 60 || Number(job?.schedule?.minutes) === 1)
  );
}

function cronJobs(document) {
  if (Array.isArray(document)) return document;
  if (
    document &&
    !Array.isArray(document) &&
    typeof document === "object" &&
    Array.isArray(document.jobs)
  ) return document.jobs;
  throw new Error("Hermes cron store is invalid");
}

export async function ensureFoursdayMemoryPromoterCron({
  layout,
  apply = false,
  run = execFileAsync,
} = {}) {
  const jobsPath = join(layout.profileDirectory, "cron", "jobs.json");
  const document = await readFile(jobsPath, "utf8").then(JSON.parse).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const existing = cronJobs(document);
  if (existing.length > 1_000) {
    throw new Error("Hermes cron store is invalid");
  }
  const owned = existing.filter((job) => job?.name === memoryPromoterJobName);
  if (owned.length > 1 || (owned[0] && !memoryPromoterJobMatches(owned[0]))) {
    throw new Error("Foursday memory promoter cron conflicts with an existing job");
  }
  if (owned.length === 1) {
    return { apply, created: false, verified: true, jobId: owned[0].id ?? null };
  }
  if (!apply) return { apply: false, created: false, verified: false, jobId: null };
  await run(layout.profileAlias, [
    "cron", "create", "every 1m",
    "--no-agent",
    "--script", "foursday-memory-promoter.sh",
    "--name", memoryPromoterJobName,
  ], {
    cwd: layout.profileDirectory,
    env: {
      HOME: layout.userHome,
      HERMES_HOME: layout.profileDirectory,
      PATH: `${join(layout.userHome, ".local", "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
      NO_COLOR: "1",
    },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const readBack = cronJobs(JSON.parse(await readFile(jobsPath, "utf8")));
  const created = readBack.filter((job) => job?.name === memoryPromoterJobName);
  if (created.length !== 1 || !memoryPromoterJobMatches(created[0])) {
    throw new Error("Foursday memory promoter cron read-back failed");
  }
  return { apply: true, created: true, verified: true, jobId: created[0].id ?? null };
}
