#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  realpathSync,
  statSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import {
  validateCommitSha,
  verifyGitHubReleaseCommit,
} from "../src/github-ci-verifier.mjs";
import { isMainModule } from "../src/main-module.mjs";
import {
  activateVersionedRelease,
  prepareVersionedRelease,
} from "./准备版本化发布.mjs";

const execFileAsync = promisify(execFile);
const commandTimeoutMs = 20 * 60_000;
const pendingReleaseFilename = ".pending-release.json";
const pendingReleaseSchema = "ai-employee-pending-release/v1";
const capabilityBudgetMigration = "018_能力次数预算.sql";
const ordinaryReleaseForwardOnlyError =
  "普通本机发布已阻止：目标版本支持第 018 号能力次数预算迁移，但上一版本不支持；必须另行采用经显式授权的维护/前滚流程，本脚本当前不提供前滚旁路。";
const pendingReleasePhases = new Set([
  "service_switch_started",
  "service_verified",
]);
export const productionRepository = "ruiwang20010702/ai-employee";
export const npmInstallArguments = Object.freeze(["ci", "--ignore-scripts"]);
const requiredKeychainKeys = Object.freeze([
  "DATABASE_URL",
  "AI_EMPLOYEE_DATA_KEY",
  "AI_EMPLOYEE_BACKUP_KEY",
  "AI_EMPLOYEE_ADMIN_READ_TOKEN",
  "AI_EMPLOYEE_ADMIN_WRITE_TOKEN",
]);
const optionalKeychainKeys = Object.freeze([
  "AI_EMPLOYEE_HEALTH_AUTH_TOKEN",
  "AI_EMPLOYEE_ALERT_WEBHOOK_URL",
  "AI_EMPLOYEE_ALERT_WEBHOOK_SECRET",
]);
const keychainReference = /^keychain:\/\/[^\s/]+\/[^\s/]+$/u;
const runtimeIdentityKeys = Object.freeze([
  "DATABASE_URL",
  "AI_EMPLOYEE_DATA_KEY",
  "AI_EMPLOYEE_TENANT_ID",
]);
const systemGitPath = "/usr/bin/git";
const systemGitSafetyArguments = Object.freeze([
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
]);
const trustedToolCandidates = Object.freeze({
  gh: Object.freeze([
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
  ]),
  node: Object.freeze([
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    process.execPath,
  ]),
  npm: Object.freeze([
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
    "/usr/bin/npm",
  ]),
});
const trustedToolRoots = Object.freeze([
  "/opt/homebrew",
  "/usr/local",
  "/usr",
]);

export const localReleaseSteps = Object.freeze([
  "验证登录会话",
  "验证干净签出与目标提交",
  "验证目标提交的检查与安全扫描",
  "取得生产发布独占锁",
  "核对并恢复中断发布",
  "准备不可变版本目录",
  "写入目标提交并完成包内检查",
  "核对第 018 号前滚边界",
  "复制受保护生产配置",
  "只读生产预检与回退目标门禁",
  "创建加密数据库备份",
  "执行前向数据库迁移",
  "运行严格诊断与合成 Codex 探针",
  "安装、清理并验证常驻服务",
  "原子激活成功版本",
]);

function safeError(message, error) {
  const code = Number(error?.code);
  const suffix = Number.isInteger(code) ? `（退出码 ${code}）` : "";
  return new Error(`${message}${suffix}`);
}

async function runQuiet(command, args, {
  cwd,
  env = process.env,
  description = basename(command),
} = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: commandTimeoutMs,
      windowsHide: true,
    });
    return String(result.stdout ?? "").trim();
  } catch (error) {
    throw safeError(`${description}失败`, error);
  }
}

function runQuietSync(command, args, {
  cwd,
  env,
  description = basename(command),
} = {}) {
  try {
    return execFileSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: commandTimeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw safeError(`${description}失败`, error);
  }
}

function safeEnvironmentValue(value, pattern, maxLength = 2_048) {
  const normalized = String(value ?? "");
  return normalized &&
    normalized.length <= maxLength &&
    !/[\0\r\n]/u.test(normalized) &&
    pattern.test(normalized)
    ? normalized
    : "";
}

function pathIsWithin(root, target) {
  const remainder = relative(root, target);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

export function resolveTrustedReleaseTool(name) {
  const candidates = trustedToolCandidates[name];
  if (!candidates) throw new Error(`未知的本机发布工具：${name}`);
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const canonical = realpathSync(candidate);
      const metadata = statSync(canonical);
      if (
        metadata.isFile() &&
        (metadata.mode & 0o111) !== 0 &&
        trustedToolRoots.some((root) => pathIsWithin(root, canonical))
      ) {
        return canonical;
      }
    } catch {
      // Continue through the fixed candidate list. PATH is never consulted.
    }
  }
  throw new Error(`没有找到固定受信目录中的 ${name} 工具`);
}

function baseReleaseEnvironment({ source = process.env, home = homedir() } = {}) {
  const nodeDirectory = dirname(resolveTrustedReleaseTool("node"));
  const environment = {
    HOME: home,
    PATH: [nodeDirectory, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    TMPDIR: safeEnvironmentValue(source.TMPDIR, /^\//u) || tmpdir(),
  };
  environment.TMP = safeEnvironmentValue(source.TMP, /^\//u) || environment.TMPDIR;
  environment.TEMP = safeEnvironmentValue(source.TEMP, /^\//u) || environment.TMPDIR;
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"]) {
    const value = safeEnvironmentValue(source[key], /^[A-Za-z0-9_.+/:@-]+$/u, 256);
    if (value) environment[key] = value;
  }
  return environment;
}

export function releaseVerificationEnvironment(source = process.env) {
  return baseReleaseEnvironment({ source, home: "/var/empty" });
}

function trustedGitArguments(args) {
  return [...systemGitSafetyArguments, ...args];
}

export function minimalRuntimeEnvironment({
  source = process.env,
  configPath = "",
  releaseDirectory = "",
} = {}) {
  const environment = baseReleaseEnvironment({ source });
  const pathKeys = [
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
  ];
  for (const key of pathKeys) {
    const value = safeEnvironmentValue(source[key], /^\//u);
    if (value) environment[key] = value;
  }
  const proxyKeys = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "no_proxy",
  ];
  for (const key of proxyKeys) {
    const value = safeEnvironmentValue(source[key], /^.+$/u);
    if (value) environment[key] = value;
  }
  if (configPath || releaseDirectory) {
    if (!configPath || !releaseDirectory) {
      throw new Error("生产脚本环境必须同时绑定配置和版本目录");
    }
    environment.AI_EMPLOYEE_CONFIG_FILE = configPath;
    environment.AI_EMPLOYEE_EXPECTED_RELEASE_DIRECTORY = releaseDirectory;
  }
  return environment;
}

export function normalizeGitHubRepository(remoteInput) {
  const remote = String(remoteInput ?? "").trim();
  if (!remote || /[\0\r\n]/u.test(remote) || remote.includes("%")) {
    throw new Error("origin 地址不是受支持的 GitHub 仓库地址");
  }
  let path = "";
  const scp = remote.match(/^git@github\.com:([^?#]+)$/iu);
  if (scp) {
    path = scp[1];
  } else {
    let url;
    try {
      url = new URL(remote);
    } catch {
      throw new Error("origin 地址不是受支持的 GitHub 仓库地址");
    }
    if (
      !["https:", "ssh:", "git:"].includes(url.protocol) ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port ||
      url.password ||
      url.search ||
      url.hash ||
      (url.username && !(url.protocol === "ssh:" && url.username === "git"))
    ) {
      throw new Error("origin 地址不是受支持的 GitHub 仓库地址");
    }
    path = url.pathname;
  }
  const parts = path.replace(/^\/+|\/+$/gu, "").split("/");
  if (parts.length !== 2) {
    throw new Error("origin 地址必须精确指向一个 GitHub 仓库");
  }
  const owner = parts[0].toLowerCase();
  const repository = parts[1].replace(/\.git$/iu, "").toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,38})$/u.test(owner) ||
    !/^[a-z0-9._-]+$/u.test(repository) ||
    repository.includes("..")
  ) {
    throw new Error("origin 地址包含不合法的仓库名称");
  }
  return `${owner}/${repository}`;
}

export function productionGitHubArguments(args = []) {
  if (args.includes("--repo") || args.includes("-R")) {
    throw new Error("GitHub 命令不能覆盖固定生产仓库");
  }
  if (args[0] === "api") return [...args];
  if (args[0] === "run" || args[0] === "workflow") {
    return [...args, "--repo", productionRepository];
  }
  throw new Error("GitHub 命令不在固定生产仓库白名单内");
}

export function githubCliEnvironment(source = process.env) {
  const environment = releaseVerificationEnvironment(source);
  const token = safeEnvironmentValue(
    source.GH_TOKEN ?? source.GITHUB_TOKEN,
    /^.+$/u,
    8_192,
  );
  if (token) environment.GH_TOKEN = token;
  environment.GH_HOST = "github.com";
  environment.GH_REPO = productionRepository;
  return environment;
}

function deploymentRoot(value) {
  const root = resolve(String(value ?? ""));
  if (
    !value ||
    !isAbsolute(String(value)) ||
    /[\0\r\n]/u.test(String(value)) ||
    root === parse(root).root ||
    root === resolve(homedir()) ||
    basename(root) !== "ai-employee-production"
  ) {
    throw new Error("部署根目录必须是名称为 ai-employee-production 的专用绝对目录");
  }
  return root;
}

async function canonicalDeploymentRootBeforeWrite(rootInput) {
  const root = deploymentRoot(rootInput);
  const parent = dirname(root);
  const canonicalParent = await realpath(parent).catch(() => {
    throw new Error("部署根目录的父目录必须已存在且可验证");
  });
  if (canonicalParent !== parent) {
    throw new Error("部署根目录的父目录不能经过符号链接");
  }
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return root;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("部署根目录必须是普通目录，不能是符号链接");
  }
  if (await realpath(root) !== root) {
    throw new Error("部署根目录解析后发生变化");
  }
  return root;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return null;
  }
}

export async function acquireLocalReleaseLock({
  root: rootInput,
  sha,
  runId,
  now = () => new Date(),
} = {}) {
  const root = await canonicalDeploymentRootBeforeWrite(rootInput);
  await mkdir(root, { mode: 0o700 }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("部署根目录创建后身份发生变化");
  }
  if (await realpath(root) !== root) {
    throw new Error("部署根目录创建后解析发生变化");
  }
  await chmod(root, 0o700);
  const lockDirectory = join(root, ".local-release-lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let created = false;
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      created = true;
      await writeFile(
        join(lockDirectory, "owner.json"),
        `${JSON.stringify({ token, pid: process.pid, sha, runId, createdAt: now().toISOString() })}\n`,
        { mode: 0o600, flag: "wx" },
      );
      return {
        async release() {
          let owner;
          try {
            owner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"));
          } catch {
            throw new Error("生产发布锁所有者无法验证，未自动清理");
          }
          if (owner?.token !== token) {
            throw new Error("生产发布锁已被其他进程接管，未自动清理");
          }
          await rm(lockDirectory, { recursive: true, force: false });
        },
      };
    } catch (error) {
      if (created) {
        await rm(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(
          await readFile(join(lockDirectory, "owner.json"), "utf8"),
        );
      } catch {
        throw new Error("已有生产发布锁且状态不可验证，必须人工核对");
      }
      if (processIsAlive(Number(owner?.pid)) !== false) {
        throw new Error("已有生产发布正在进行，拒绝并发发布");
      }
      const staleDirectory = join(root, `.stale-local-release-lock-${token}`);
      try {
        await rename(lockDirectory, staleDirectory);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw new Error("过期生产发布锁无法安全接管，必须人工核对");
      }
      await rm(staleDirectory, { recursive: true, force: false });
    }
  }
  throw new Error("无法取得生产发布独占锁");
}

function insideDirectory(parent, child) {
  const difference = relative(parent, child);
  return Boolean(difference) &&
    !difference.startsWith("..") &&
    !isAbsolute(difference);
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function releaseIntegrityDigest(entries) {
  return createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function releaseDirectorySha(releaseDirectory, description = "版本目录") {
  const match = basename(resolve(String(releaseDirectory ?? ""))).match(
    /^([0-9a-f]{40})-[0-9]{1,30}-[0-9]{1,10}$/u,
  );
  if (!match) {
    throw new Error(`${description}未绑定 40 位提交身份`);
  }
  return match[1];
}

async function canonicalReleasePath(root, input, description) {
  if (!isAbsolute(String(input ?? "")) || /[\0\r\n]/u.test(String(input))) {
    throw new Error(`${description}必须是安全绝对路径`);
  }
  const releases = await realpath(join(root, "releases"));
  const release = await realpath(resolve(input)).catch(() => {
    throw new Error(`${description}不可读取`);
  });
  if (!insideDirectory(releases, release)) {
    throw new Error(`${description}越出受控版本目录`);
  }
  const runtimePath = join(release, ".runtime");
  const configPath = join(runtimePath, "production.json");
  const [
    packageMetadata,
    runtimeMetadata,
    configMetadata,
    canonicalRuntime,
    canonicalConfig,
  ] = await Promise.all([
    lstat(join(release, "package.json")),
    lstat(runtimePath),
    lstat(configPath),
    realpath(runtimePath),
    realpath(configPath),
  ]);
  if (
    !packageMetadata.isFile() ||
    packageMetadata.isSymbolicLink() ||
    !runtimeMetadata.isDirectory() ||
    runtimeMetadata.isSymbolicLink() ||
    canonicalRuntime !== runtimePath ||
    !configMetadata.isFile() ||
    configMetadata.isSymbolicLink() ||
    canonicalConfig !== configPath ||
    (configMetadata.mode & 0o077) !== 0
  ) {
    throw new Error(`${description}缺少受保护的版本文件`);
  }
  return release;
}

async function normalizePendingReleaseRecord(rootInput, record) {
  const root = await realpath(deploymentRoot(rootInput)).catch(() => {
    throw new Error("生产发布根目录不可读取");
  });
  if (
    !record ||
    Array.isArray(record) ||
    record.schema !== pendingReleaseSchema ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      String(record.token ?? ""),
    ) ||
    !pendingReleasePhases.has(record.phase) ||
    !/^[0-9a-f]{64}$/u.test(String(record.integrityDigest ?? "")) ||
    !/^[0-9a-f]{40}$/u.test(String(record.previousSha ?? "")) ||
    !/^[0-9a-f]{64}$/u.test(String(record.previousIntegrityDigest ?? "")) ||
    !/^[0-9a-f]{64}$/u.test(String(record.targetConfigDigest ?? "")) ||
    !/^[0-9a-f]{64}$/u.test(String(record.previousConfigDigest ?? "")) ||
    !/^[0-9a-f]{64}$/u.test(String(record.targetIdentityDigest ?? "")) ||
    !/^[0-9a-f]{64}$/u.test(String(record.previousIdentityDigest ?? "")) ||
    !/^[0-9]{1,30}$/u.test(String(record.runId ?? "")) ||
    !/^[0-9]{1,10}$/u.test(String(record.attempt ?? "")) ||
    !Number.isFinite(Date.parse(String(record.createdAt ?? "")))
  ) {
    throw new Error("中断发布记录格式无效");
  }
  const sha = validateCommitSha(record.sha);
  const previousRelease = await canonicalReleasePath(
    root,
    record.previousRelease,
    "上一版本",
  );
  const targetRelease = await canonicalReleasePath(
    root,
    record.targetRelease,
    "目标版本",
  );
  if (
    previousRelease === targetRelease ||
    basename(targetRelease) !== `${sha}-${record.runId}-${record.attempt}` ||
    releaseDirectorySha(previousRelease, "上一版本目录") !== record.previousSha ||
    record.targetIdentityDigest !== record.previousIdentityDigest
  ) {
    throw new Error("中断发布记录与不可变版本目录不一致");
  }
  return {
    schema: pendingReleaseSchema,
    token: record.token,
    phase: record.phase,
    integrityDigest: record.integrityDigest,
    previousSha: record.previousSha,
    previousIntegrityDigest: record.previousIntegrityDigest,
    targetConfigDigest: record.targetConfigDigest,
    previousConfigDigest: record.previousConfigDigest,
    targetIdentityDigest: record.targetIdentityDigest,
    previousIdentityDigest: record.previousIdentityDigest,
    sha,
    runId: String(record.runId),
    attempt: String(record.attempt),
    previousRelease,
    targetRelease,
    createdAt: new Date(record.createdAt).toISOString(),
  };
}

export async function inspectPendingReleaseJournal({ root: rootInput } = {}) {
  const root = await realpath(deploymentRoot(rootInput)).catch(() => {
    throw new Error("生产发布根目录不可读取");
  });
  const journalPath = join(root, pendingReleaseFilename);
  let metadata;
  try {
    metadata = await lstat(journalPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size > 4_096
  ) {
    throw new Error("中断发布记录权限或文件类型不安全");
  }
  let record;
  try {
    record = JSON.parse(await readFile(journalPath, "utf8"));
  } catch {
    throw new Error("中断发布记录不是有效 JSON");
  }
  return normalizePendingReleaseRecord(root, record);
}

async function atomicWritePendingRelease(root, record, { replaceToken = "" } = {}) {
  const journalPath = join(root, pendingReleaseFilename);
  const existing = await inspectPendingReleaseJournal({ root });
  if (replaceToken) {
    if (!existing || existing.token !== replaceToken) {
      throw new Error("中断发布记录已变化，拒绝覆盖");
    }
  } else if (existing) {
    throw new Error("仍有未完成的中断发布记录，拒绝创建新记录");
  }
  const normalized = await normalizePendingReleaseRecord(root, record);
  const temporary = join(root, `.pending-release-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(normalized)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, journalPath);
    await chmod(journalPath, 0o600);
    await syncDirectory(root);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return normalized;
}

export async function writePendingReleaseJournal({
  root: rootInput,
  sha,
  runId,
  attempt,
  previousRelease,
  targetRelease,
  integrityDigest,
  previousSha,
  previousIntegrityDigest,
  targetConfigDigest,
  previousConfigDigest,
  targetIdentityDigest,
  previousIdentityDigest,
  now = () => new Date(),
} = {}) {
  const root = await realpath(deploymentRoot(rootInput)).catch(() => {
    throw new Error("生产发布根目录不可读取");
  });
  return atomicWritePendingRelease(root, {
    schema: pendingReleaseSchema,
    token: randomUUID(),
    phase: "service_switch_started",
    integrityDigest,
    previousSha,
    previousIntegrityDigest,
    targetConfigDigest,
    previousConfigDigest,
    targetIdentityDigest,
    previousIdentityDigest,
    sha,
    runId: String(runId),
    attempt: String(attempt),
    previousRelease,
    targetRelease,
    createdAt: now().toISOString(),
  });
}

export async function updatePendingReleaseJournal({
  root: rootInput,
  token,
  phase,
} = {}) {
  const root = await realpath(deploymentRoot(rootInput)).catch(() => {
    throw new Error("生产发布根目录不可读取");
  });
  const existing = await inspectPendingReleaseJournal({ root });
  if (!existing || existing.token !== token) {
    throw new Error("中断发布记录已变化，拒绝更新");
  }
  return atomicWritePendingRelease(
    root,
    { ...existing, phase },
    { replaceToken: token },
  );
}

export async function clearPendingReleaseJournal({
  root: rootInput,
  token,
} = {}) {
  const root = await realpath(deploymentRoot(rootInput)).catch(() => {
    throw new Error("生产发布根目录不可读取");
  });
  const existing = await inspectPendingReleaseJournal({ root });
  if (!existing || existing.token !== token) {
    throw new Error("中断发布记录已变化，拒绝清理");
  }
  await unlink(join(root, pendingReleaseFilename));
  await syncDirectory(root);
  return { cleared: true };
}

export async function readCurrentRelease({ root: rootInput } = {}) {
  const root = await realpath(deploymentRoot(rootInput)).catch(() => {
    throw new Error("生产发布根目录不可读取");
  });
  const current = join(root, "current");
  const metadata = await lstat(current).catch(() => {
    throw new Error("current 版本标记不可读取");
  });
  if (!metadata.isSymbolicLink()) {
    throw new Error("current 版本标记必须是符号链接");
  }
  const release = await realpath(current).catch(() => {
    throw new Error("current 版本标记已损坏");
  });
  const releases = await realpath(join(root, "releases"));
  if (!insideDirectory(releases, release)) {
    throw new Error("current 版本越出受控版本目录");
  }
  return release;
}

async function inspectRuntimeIdentityConfig(configPath) {
  const normalizedConfigPath = resolve(String(configPath ?? ""));
  const runtimePath = dirname(normalizedConfigPath);
  let runtimeMetadata;
  let canonicalRuntime;
  let canonicalConfig;
  try {
    [runtimeMetadata, canonicalRuntime, canonicalConfig] = await Promise.all([
      lstat(runtimePath),
      realpath(runtimePath),
      realpath(normalizedConfigPath),
    ]);
  } catch {
    throw new Error("关键运行身份配置不可安全读取");
  }
  if (
    basename(runtimePath) !== ".runtime" ||
    !runtimeMetadata.isDirectory() ||
    runtimeMetadata.isSymbolicLink() ||
    canonicalRuntime !== runtimePath ||
    canonicalConfig !== normalizedConfigPath
  ) {
    throw new Error("关键运行身份配置路径不在受控运行目录");
  }
  let handle;
  try {
    handle = await open(
      normalizedConfigPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch {
    throw new Error("关键运行身份配置不可安全读取");
  }
  let content;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size <= 0 ||
      metadata.size > 1024 * 1024
    ) {
      throw new Error("关键运行身份配置的文件类型或权限不安全");
    }
    content = await handle.readFile();
  } finally {
    await handle.close();
  }
  let values;
  try {
    values = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("关键运行身份配置格式无效");
  }
  if (!values || Array.isArray(values) || typeof values !== "object") {
    throw new Error("关键运行身份配置格式无效");
  }
  const databaseReference = values.DATABASE_URL;
  const dataKeyReference = values.AI_EMPLOYEE_DATA_KEY;
  const tenantValue = values.AI_EMPLOYEE_TENANT_ID;
  const tenantId = typeof tenantValue === "string" ? tenantValue.trim() : "";
  if (
    !keychainReference.test(String(databaseReference ?? "")) ||
    !keychainReference.test(String(dataKeyReference ?? "")) ||
    !tenantId ||
    tenantId.length > 512 ||
    /[\0\r\n]/u.test(tenantId) ||
    /^(?:replace_with|change_me)(?:_|$)/iu.test(tenantId) ||
    tenantId.startsWith("keychain://") ||
    tenantId.startsWith("env://")
  ) {
    throw new Error("关键运行身份配置缺失或引用格式无效");
  }
  const identity = Object.fromEntries(runtimeIdentityKeys.map((key) => [
    key,
    key === "AI_EMPLOYEE_TENANT_ID" ? tenantId : String(values[key]),
  ]));
  return {
    configDigest: sha256(content),
    identityDigest: sha256(JSON.stringify(identity)),
  };
}

export async function compareReleaseRuntimeIdentity({
  targetConfigPath,
  previousConfigPath,
} = {}) {
  const [target, previous] = await Promise.all([
    inspectRuntimeIdentityConfig(targetConfigPath),
    inspectRuntimeIdentityConfig(previousConfigPath),
  ]);
  if (target.identityDigest !== previous.identityDigest) {
    throw new Error("目标版本与上一版本的关键运行身份不一致");
  }
  return {
    targetConfigDigest: target.configDigest,
    previousConfigDigest: previous.configDigest,
    targetIdentityDigest: target.identityDigest,
    previousIdentityDigest: previous.identityDigest,
  };
}

export async function verifyReleaseRuntimeIdentityBinding({
  targetConfigPath,
  previousConfigPath,
  expected,
} = {}) {
  const names = [
    "targetConfigDigest",
    "previousConfigDigest",
    "targetIdentityDigest",
    "previousIdentityDigest",
  ];
  if (
    !expected ||
    names.some((name) => !/^[0-9a-f]{64}$/u.test(String(expected[name] ?? ""))) ||
    expected.targetIdentityDigest !== expected.previousIdentityDigest
  ) {
    throw new Error("关键运行身份绑定摘要无效");
  }
  const actual = await compareReleaseRuntimeIdentity({
    targetConfigPath,
    previousConfigPath,
  });
  if (names.some((name) => actual[name] !== expected[name])) {
    throw new Error("版本配置或关键运行身份已发生变化");
  }
  return { valid: true, ...actual };
}

export async function reconcilePendingLocalRelease({
  root: rootInput,
  expectedSha: shaInput,
  sourceDirectory = process.cwd(),
  runId,
  attempt,
  dependencies = createLocalReleaseDependencies(),
} = {}) {
  const root = deploymentRoot(rootInput);
  const expectedSha = validateCommitSha(shaInput);
  const activationRunId = String(runId ?? "");
  const activationAttempt = String(attempt ?? "");
  if (
    !/^[0-9]{1,30}$/u.test(activationRunId) ||
    !/^[0-9]{1,10}$/u.test(activationAttempt)
  ) {
    throw new Error("中断发布对账要求安全的运行编号和尝试次数");
  }
  const pending = await dependencies.inspectPendingRelease({ root });
  if (!pending) {
    return { recovered: false, status: "none" };
  }
  if (pending.sha !== expectedSha) {
    throw new Error(
      "中断发布记录属于另一个目标提交；必须先签出并验证记录中的精确 SHA",
    );
  }
  const currentRelease = await dependencies.readCurrentRelease({ root });
  if (
    currentRelease !== pending.previousRelease &&
    currentRelease !== pending.targetRelease
  ) {
    throw new Error("current 与中断发布记录不一致，已保留现场并拒绝自动恢复");
  }
  await dependencies.verifyPendingReleaseIntegrity({
    releaseDirectory: pending.targetRelease,
    expectedDigest: pending.integrityDigest,
  });
  const previousCommit = await dependencies.verifyPreviousReleaseAgainstCommit({
    releaseDirectory: pending.previousRelease,
    sourceDirectory,
    sha: pending.previousSha,
  });
  if (
    previousCommit?.sha !== pending.previousSha ||
    previousCommit?.integrityDigest !== pending.previousIntegrityDigest
  ) {
    throw new Error("上一版本的提交身份或完整性基线不一致");
  }

  const activationContext = {
    root,
    runId: activationRunId,
    attempt: activationAttempt,
  };
  const targetContext = {
    releaseDirectory: pending.targetRelease,
    configPath: join(pending.targetRelease, ".runtime", "production.json"),
  };
  const previousContext = {
    releaseDirectory: pending.previousRelease,
    configPath: join(pending.previousRelease, ".runtime", "production.json"),
  };
  const runtimeBindingContext = {
    targetConfigPath: targetContext.configPath,
    previousConfigPath: previousContext.configPath,
    expected: pending,
  };
  await dependencies.verifyReleaseRuntimeIdentityBinding(
    runtimeBindingContext,
  );
  let targetFailure = null;
  try {
    await dependencies.verifyService(targetContext);
    await dependencies.cleanupServices(targetContext);
    await dependencies.verifyService(targetContext);
    await dependencies.verifyPendingReleaseIntegrity({
      releaseDirectory: pending.targetRelease,
      expectedDigest: pending.integrityDigest,
    });
    await dependencies.verifyReleaseRuntimeIdentityBinding(
      runtimeBindingContext,
    );
    if (currentRelease !== pending.targetRelease) {
      await dependencies.activateRelease({
        ...targetContext,
        ...activationContext,
      });
    }
  } catch (error) {
    targetFailure = error;
  }
  if (!targetFailure) {
    try {
      await dependencies.clearPendingRelease({
        root,
        token: pending.token,
      });
    } catch (error) {
      throw new AggregateError(
        [error],
        "目标版本已安全恢复，但中断发布记录未清理；已保留记录并停止",
      );
    }
    return {
      recovered: true,
      status: "target_recovered",
      releaseDirectory: pending.targetRelease,
      previousRelease: pending.previousRelease,
      sha: pending.sha,
    };
  }

  try {
    await dependencies.verifyPendingReleaseIntegrity({
      releaseDirectory: pending.targetRelease,
      expectedDigest: pending.integrityDigest,
    });
    await dependencies.verifyReleaseRuntimeIdentityBinding(
      runtimeBindingContext,
    );
    await dependencies.verifyPreviousReleaseIntegrity({
      releaseDirectory: pending.previousRelease,
      expectedDigest: pending.previousIntegrityDigest,
    });
    await dependencies.rollbackStateGuard({
      ...targetContext,
      previousRelease: pending.previousRelease,
    });
    await dependencies.verifyPreviousReleaseIntegrity({
      releaseDirectory: pending.previousRelease,
      expectedDigest: pending.previousIntegrityDigest,
    });
    await dependencies.installService(previousContext);
    await dependencies.cleanupServices(previousContext);
    await dependencies.verifyService(previousContext);
    await dependencies.activateRelease({
      ...previousContext,
      ...activationContext,
    });
  } catch (rollbackError) {
    throw new AggregateError(
      [targetFailure, rollbackError],
      "中断发布无法安全恢复；已保留记录和数据库状态并停止",
    );
  }
  try {
    await dependencies.clearPendingRelease({
      root,
      token: pending.token,
    });
  } catch (error) {
    throw new AggregateError(
      [targetFailure, error],
      "上一版本服务已恢复，但中断发布记录未清理；已保留记录并停止",
    );
  }
  return {
    recovered: true,
    status: "previous_restored",
    releaseDirectory: pending.previousRelease,
    failedTargetRelease: pending.targetRelease,
    sha: pending.sha,
  };
}

function sanitizedReleaseEnvironment({ configPath, releaseDirectory }) {
  return minimalRuntimeEnvironment({ configPath, releaseDirectory });
}

export async function verifyLocalReleaseCheckout({
  sha,
  sourceDirectory,
  command = runQuiet,
  loadRollbackBaseline = async () => JSON.parse(await command(
    systemGitPath,
    trustedGitArguments([
      "show",
      "refs/remotes/origin/main:deploy/回退基线.json",
    ]),
    {
      cwd: sourceDirectory,
      env: releaseVerificationEnvironment(),
      description: "读取主分支固定回退基线",
    },
  )),
} = {}) {
  const verificationEnvironment = releaseVerificationEnvironment();
  const origin = normalizeGitHubRepository(await command(
    systemGitPath,
    trustedGitArguments(["remote", "get-url", "origin"]),
    {
      cwd: sourceDirectory,
      env: verificationEnvironment,
      description: "读取 origin 仓库身份",
    },
  ));
  if (origin !== productionRepository) {
    throw new Error(`本机生产发布只接受官方仓库 ${productionRepository}`);
  }
  const status = await command(
    systemGitPath,
    trustedGitArguments([
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ]),
    {
      cwd: sourceDirectory,
      env: verificationEnvironment,
      description: "读取 Git 工作区状态",
    },
  );
  if (status) throw new Error("工作区不干净，不能发布未提交内容");
  const head = await command(systemGitPath, trustedGitArguments([
    "rev-parse",
    "HEAD",
  ]), {
    cwd: sourceDirectory,
    env: verificationEnvironment,
    description: "读取当前 Git 提交",
  });
  if (head !== sha) throw new Error("当前签出与目标提交不一致");
  const commit = await command(
    systemGitPath,
    trustedGitArguments(["rev-parse", "--verify", `${sha}^{commit}`]),
    {
      cwd: sourceDirectory,
      env: verificationEnvironment,
      description: "验证目标 Git 提交",
    },
  );
  if (commit !== sha) throw new Error("目标提交不是当前仓库中的完整提交对象");
  await command(
    systemGitPath,
    trustedGitArguments([
      "fetch",
      "--quiet",
      "--no-tags",
      `https://github.com/${productionRepository}.git`,
      "+refs/heads/main:refs/remotes/origin/main",
    ]),
    {
      cwd: sourceDirectory,
      env: verificationEnvironment,
      description: "刷新 origin/main",
    },
  );
  let mainHistory = false;
  try {
    await command(
      systemGitPath,
      trustedGitArguments([
        "merge-base",
        "--is-ancestor",
        sha,
        "refs/remotes/origin/main",
      ]),
      {
        cwd: sourceDirectory,
        env: verificationEnvironment,
        description: "验证目标提交属于 origin/main 历史",
      },
    );
    mainHistory = true;
  } catch {
    mainHistory = false;
  }
  if (!mainHistory) {
    let baselineSha = "";
    try {
      baselineSha = validateCommitSha((await loadRollbackBaseline()).commit);
    } catch {
      throw new Error("目标提交不属于 origin/main 历史，且固定回退基线不可验证");
    }
    if (baselineSha !== sha) {
      throw new Error("目标提交不属于 origin/main 历史，也不是固定回退基线");
    }
  }
  return {
    clean: true,
    headSha: sha,
    repository: productionRepository,
    authorizedBy: mainHistory ? "origin/main" : "rollback_baseline",
  };
}

async function prepareRelease({ root, sha, runId, attempt }) {
  const temporary = await mkdtemp(join(tmpdir(), "ai-employee-local-release-"));
  const environmentFile = join(temporary, "release-environment");
  await writeFile(environmentFile, "", { mode: 0o600, flag: "wx" });
  try {
    const prepared = await prepareVersionedRelease({
      root,
      sha,
      runId,
      attempt,
      environmentFile,
    });
    const environment = await readFile(environmentFile, "utf8");
    const previousPrefix = "AI_EMPLOYEE_PREVIOUS_RELEASE=";
    const previousRelease = environment
      .split("\n")
      .find((line) => line.startsWith(previousPrefix))
      ?.slice(previousPrefix.length) ?? "";
    return { ...prepared, previousRelease };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function materializeRelease({ sha, sourceDirectory, releaseDirectory }) {
  const temporary = await mkdtemp(join(tmpdir(), "ai-employee-source-"));
  const archive = join(temporary, "source.tar");
  try {
    await runQuiet(
      systemGitPath,
      trustedGitArguments([
        "archive",
        "--format=tar",
        "--output",
        archive,
        sha,
      ]),
      {
        cwd: sourceDirectory,
        env: releaseVerificationEnvironment(),
        description: "导出目标提交",
      },
    );
    await runQuiet("/usr/bin/tar", ["-xf", archive, "-C", releaseDirectory], {
      cwd: sourceDirectory,
      env: releaseVerificationEnvironment(),
      description: "写入目标版本文件",
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function releaseIntegrityEntries(releaseDirectory) {
  const root = resolve(releaseDirectory);
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("目标版本目录不是可验证的普通目录");
  }
  if (await realpath(root) !== root) {
    throw new Error("目标版本目录解析后发生变化");
  }
  const entries = [];
  async function walk(directory) {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const path = join(directory, name);
      const pathRelative = relative(root, path);
      if (pathRelative === "node_modules" || pathRelative === ".runtime") {
        continue;
      }
      const entry = await lstat(path);
      if (entry.isDirectory()) {
        entries.push({ path: pathRelative, type: "directory" });
        await walk(path);
      } else if (entry.isFile()) {
        entries.push({
          path: pathRelative,
          type: "file",
          executable: Boolean(entry.mode & 0o111),
          digest: createHash("sha256").update(await readFile(path)).digest("hex"),
        });
      } else if (entry.isSymbolicLink()) {
        throw new Error("目标版本不允许包含符号链接");
      } else {
        throw new Error("目标版本包含不可验证的特殊文件");
      }
    }
  }
  await walk(root);
  return entries;
}

export async function captureReleaseIntegrity({ releaseDirectory } = {}) {
  return {
    schema: "ai-employee-release-integrity/v1",
    entries: await releaseIntegrityEntries(releaseDirectory),
  };
}

export async function verifyReleaseIntegrity({
  releaseDirectory,
  expected,
} = {}) {
  if (expected?.schema !== "ai-employee-release-integrity/v1") {
    throw new Error("目标版本完整性基线无效");
  }
  const actual = await releaseIntegrityEntries(releaseDirectory);
  if (JSON.stringify(actual) !== JSON.stringify(expected.entries)) {
    throw new Error("目标版本文件已偏离门禁通过的精确提交");
  }
  return { valid: true, trackedEntries: actual.length };
}

export async function verifyReleaseIntegrityDigest({
  releaseDirectory,
  expectedDigest,
} = {}) {
  if (!/^[0-9a-f]{64}$/u.test(String(expectedDigest ?? ""))) {
    throw new Error("中断发布的目标版本完整性基线无效");
  }
  const entries = await releaseIntegrityEntries(releaseDirectory);
  if (releaseIntegrityDigest(entries) !== expectedDigest) {
    throw new Error("中断发布的目标版本已偏离服务切换前的精确内容");
  }
  return { valid: true, trackedEntries: entries.length };
}

export async function verifyReleaseAgainstCommit({
  releaseDirectory,
  sourceDirectory,
  sha: shaInput,
} = {}) {
  const directorySha = releaseDirectorySha(releaseDirectory, "上一版本目录");
  const sha = shaInput == null ? directorySha : validateCommitSha(shaInput);
  if (directorySha !== sha) {
    throw new Error("上一版本目录与其 40 位提交身份不一致");
  }
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-previous-release-")),
  );
  try {
    await materializeRelease({
      sha,
      sourceDirectory: resolve(sourceDirectory),
      releaseDirectory: temporary,
    });
    const [expected, actual] = await Promise.all([
      releaseIntegrityEntries(temporary),
      releaseIntegrityEntries(releaseDirectory),
    ]);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("上一版本目录已偏离其固定的 40 位提交");
    }
    return {
      valid: true,
      sha,
      integrityDigest: releaseIntegrityDigest(expected),
      trackedEntries: actual.length,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function inspectCanonicalDirectory(path, label, { optional = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return false;
    throw new Error(`${label}无法验证`);
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label}不能是符号链接`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${label}不是普通目录`);
  }
  let canonical;
  try {
    canonical = await realpath(path);
  } catch {
    throw new Error(`${label}无法验证`);
  }
  if (canonical !== path) {
    throw new Error(`${label}的规范路径与词法路径不一致`);
  }
  return true;
}

async function verifiedReleaseIncludesCapabilityBudget(releaseDirectory, label) {
  if (
    typeof releaseDirectory !== "string" ||
    !isAbsolute(releaseDirectory) ||
    resolve(releaseDirectory) !== releaseDirectory ||
    /[\0\r\n]/u.test(releaseDirectory)
  ) {
    throw new Error(`${label}版本目录不是已验证的绝对路径`);
  }
  await inspectCanonicalDirectory(releaseDirectory, `${label}版本目录`);
  const databaseDirectory = join(releaseDirectory, "db");
  if (!(await inspectCanonicalDirectory(
    databaseDirectory,
    `${label}版本 db 目录`,
    { optional: true },
  ))) return false;
  const migrationsDirectory = join(databaseDirectory, "migrations");
  if (!(await inspectCanonicalDirectory(
    migrationsDirectory,
    `${label}版本 migrations 目录`,
    { optional: true },
  ))) return false;
  const migrationPath = join(
    migrationsDirectory,
    capabilityBudgetMigration,
  );
  let metadata;
  try {
    metadata = await lstat(migrationPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label}版本的第 018 号固定迁移文件不能是符号链接`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${label}版本的第 018 号固定迁移文件不是普通文件`);
  }
  let canonicalMigration;
  try {
    canonicalMigration = await realpath(migrationPath);
  } catch {
    throw new Error(`${label}版本的第 018 号固定迁移文件无法验证`);
  }
  if (canonicalMigration !== migrationPath) {
    throw new Error(
      `${label}版本的第 018 号固定迁移文件规范路径与词法路径不一致`,
    );
  }
  return true;
}

export async function assertOrdinaryReleaseMigrationBoundary({
  releaseDirectory,
  previousRelease,
} = {}) {
  const [targetSupports018, previousSupports018] = await Promise.all([
    verifiedReleaseIncludesCapabilityBudget(releaseDirectory, "目标"),
    verifiedReleaseIncludesCapabilityBudget(previousRelease, "上一"),
  ]);
  if (targetSupports018 && !previousSupports018) {
    throw new Error(ordinaryReleaseForwardOnlyError);
  }
  return { targetSupports018, previousSupports018 };
}

export async function validateAndCopyProductionConfig({
  configPath,
  releaseDirectory,
}) {
  const metadata = await lstat(configPath);
  if (!metadata.isFile()) throw new Error("生产配置必须是普通文件");
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("生产配置不能被同组或其他用户读取");
  }
  let values;
  try {
    values = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error("生产配置不是有效 JSON");
  }
  if (!values || Array.isArray(values) || typeof values !== "object") {
    throw new Error("生产配置必须是 JSON 对象");
  }
  for (const key of requiredKeychainKeys) {
    if (!keychainReference.test(String(values[key] ?? ""))) {
      throw new Error(`本机生产发布要求 ${key} 使用 macOS 钥匙串引用`);
    }
  }
  for (const key of optionalKeychainKeys) {
    if (
      Object.hasOwn(values, key) &&
      !keychainReference.test(String(values[key] ?? ""))
    ) {
      throw new Error(`本机生产发布要求可选密钥 ${key} 使用 macOS 钥匙串引用`);
    }
  }
  const runtime = join(releaseDirectory, ".runtime");
  const runtimeExists = await lstat(runtime)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
  if (runtimeExists) {
    throw new Error("目标检查提前创建了运行目录，拒绝注入生产配置");
  }
  const destination = join(runtime, "production.json");
  await mkdir(runtime, { mode: 0o700 });
  await chmod(runtime, 0o700);
  await copyFile(configPath, destination, fsConstants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
  return destination;
}

async function runReleaseScript({
  releaseDirectory,
  configPath,
  relativePath,
  args = [],
  description,
}) {
  await runQuiet(
    resolveTrustedReleaseTool("node"),
    [join(releaseDirectory, relativePath), ...args],
    {
      cwd: releaseDirectory,
      env: sanitizedReleaseEnvironment({ configPath, releaseDirectory }),
      description,
    },
  );
}

export function createLocalReleaseDependencies({
  command = runQuiet,
  syncCommand = runQuietSync,
  environmentSource = process.env,
  resolveTool = resolveTrustedReleaseTool,
} = {}) {
  return {
    async verifyLoginSession() {
      if (process.platform !== "darwin") {
        throw new Error("本机版本发布只允许在 macOS 登录会话执行");
      }
      await command(
        "/bin/launchctl",
        ["print", `gui/${process.getuid()}`],
        { description: "验证 macOS 登录会话" },
      );
    },
    verifyCheckout: verifyLocalReleaseCheckout,
    async verifyCloudGate({ sha, sourceDirectory }) {
      return verifyGitHubReleaseCommit({
        cwd: sourceDirectory,
        sha,
        run(command, args, { cwd }) {
          if (command !== "gh") {
            throw new Error("云端发布门禁只允许 GitHub CLI");
          }
          return syncCommand(
            resolveTool("gh"),
            productionGitHubArguments(args),
            {
              cwd,
              env: githubCliEnvironment(environmentSource),
              description: "核对固定仓库的 GitHub 工作流",
            },
          );
        },
      });
    },
    acquireReleaseLock: acquireLocalReleaseLock,
    prepareRelease,
    materializeRelease,
    captureReleaseIntegrity,
    verifyReleaseIntegrity,
    verifyPendingReleaseIntegrity: verifyReleaseIntegrityDigest,
    verifyPreviousReleaseAgainstCommit: verifyReleaseAgainstCommit,
    verifyPreviousReleaseIntegrity: verifyReleaseIntegrityDigest,
    compareReleaseRuntimeIdentity,
    verifyReleaseRuntimeIdentityBinding,
    inspectPendingRelease: inspectPendingReleaseJournal,
    writePendingRelease: writePendingReleaseJournal,
    updatePendingRelease: updatePendingReleaseJournal,
    clearPendingRelease: clearPendingReleaseJournal,
    readCurrentRelease,
    async installDependencies({ releaseDirectory }) {
      await command(resolveTool("node"), [
        resolveTool("npm"),
        ...npmInstallArguments,
      ], {
        cwd: releaseDirectory,
        env: minimalRuntimeEnvironment({ source: environmentSource }),
        description: "安装目标版本依赖",
      });
    },
    async auditRelease({ releaseDirectory }) {
      await command(resolveTool("node"), [
        resolveTool("npm"),
        "audit",
        "--audit-level=high",
      ], {
        cwd: releaseDirectory,
        env: minimalRuntimeEnvironment({ source: environmentSource }),
        description: "审计目标版本依赖",
      });
    },
    async checkRelease({ releaseDirectory }) {
      await command(resolveTool("node"), [
        resolveTool("npm"),
        "run",
        "check",
      ], {
        cwd: releaseDirectory,
        env: minimalRuntimeEnvironment({ source: environmentSource }),
        description: "检查目标版本代码",
      });
    },
    copyProductionConfig: validateAndCopyProductionConfig,
    async validateRollbackTarget({ releaseDirectory, previousRelease, configPath }) {
      await runReleaseScript({
        releaseDirectory,
        configPath,
        relativePath: "scripts/验证发布回退目标.mjs",
        args: previousRelease ? ["--release", releaseDirectory, "--previous", previousRelease] : ["--release", releaseDirectory],
        description: "验证生产预检和服务回退目标",
      });
    },
    async backupDatabase(context) {
      await runReleaseScript({
        ...context,
        relativePath: "scripts/备份数据库.mjs",
        description: "创建加密数据库备份",
      });
    },
    async migrateDatabase(context) {
      await runReleaseScript({
        ...context,
        relativePath: "src/migrate.mjs",
        description: "执行前向数据库迁移",
      });
    },
    async runDoctor(context) {
      await runReleaseScript({
        ...context,
        relativePath: "scripts/只读生产诊断.mjs",
        description: "运行严格生产诊断",
      });
    },
    async runCodexProbe(context) {
      await runReleaseScript({
        ...context,
        relativePath: "scripts/验证草稿生成.mjs",
        description: "运行合成 Codex 探针",
      });
    },
    async installService(context) {
      await runReleaseScript({
        ...context,
        relativePath: "scripts/管理常驻服务.mjs",
        args: ["install"],
        description: "安装常驻服务",
      });
    },
    async cleanupServices(context) {
      await runReleaseScript({
        ...context,
        relativePath: "scripts/清理版本外常驻服务.mjs",
        args: ["--release", context.releaseDirectory],
        description: "清理版本外常驻服务",
      });
    },
    async verifyService(context) {
      await runReleaseScript({
        ...context,
        relativePath: "scripts/验证服务部署.mjs",
        description: "验证常驻服务版本",
      });
    },
    async activateRelease(context) {
      return activateVersionedRelease({
        root: context.root,
        releaseDirectory: context.releaseDirectory,
        runId: context.runId,
        attempt: context.attempt,
      });
    },
    async rollbackStateGuard(context) {
      await runReleaseScript({
        ...context,
        relativePath: "scripts/验证服务回退状态.mjs",
        args: context.previousRelease
          ? ["--previous", context.previousRelease]
          : [],
        description: "验证服务回退运行状态",
      });
    },
  };
}

function releasePlan({ sha, root, sourceDirectory, configPath }) {
  return {
    schema: "ai-employee-local-release-plan/v1",
    dryRun: true,
    executed: false,
    applyRequired: true,
    sha,
    deploymentRoot: root,
    sourceDirectory,
    configPath,
    steps: localReleaseSteps,
    forwardOnlyBoundary:
      "普通 --apply 若目标版本支持第 018 号迁移而上一版本不支持，会在复制生产配置、备份、迁移和服务动作前停止；本脚本不提供前滚旁路。",
    rollback: "服务切换后失败时，先检查新结构状态，再只恢复上一版本服务；绝不自动恢复或反向迁移数据库。",
  };
}

export async function runLocalAtomicRelease({
  sha: shaInput,
  root: rootInput,
  sourceDirectory: sourceInput = process.cwd(),
  configPath: configInput,
  apply = false,
  runId = `${Date.now()}${process.pid}`,
  attempt = "1",
  dependencies = createLocalReleaseDependencies(),
} = {}) {
  const sha = validateCommitSha(shaInput);
  const root = deploymentRoot(rootInput);
  const sourceDirectory = resolve(sourceInput);
  if (!configInput) throw new Error("必须明确指定生产配置文件");
  const configPath = resolve(configInput);
  const plan = releasePlan({ sha, root, sourceDirectory, configPath });
  if (!apply) return plan;

  let releaseDirectory = "";
  let releaseConfigPath = "";
  let previousRelease = "";
  let previousSha = "";
  let previousIntegrityDigest = "";
  let runtimeIdentityBinding = null;
  let serviceSwitchAttempted = false;
  let currentActivated = false;
  let pendingRelease = null;
  let releaseLock = null;
  const completedSteps = [];
  const complete = (step) => completedSteps.push(step);
  try {
    await dependencies.verifyLoginSession();
    complete("验证登录会话");
    await dependencies.verifyCheckout({ sha, sourceDirectory });
    complete("验证干净签出与目标提交");
    const cloudGate = await dependencies.verifyCloudGate({ sha, sourceDirectory });
    if (cloudGate?.valid !== true || cloudGate?.headSha !== sha) {
      throw new Error("目标提交的云端门禁未通过精确 SHA 核对");
    }
    complete("验证目标提交的检查与安全扫描");
    releaseLock = await dependencies.acquireReleaseLock({
      root,
      sha,
      runId: String(runId),
    });
    complete("取得生产发布独占锁");

    const recovery = await reconcilePendingLocalRelease({
      root,
      expectedSha: sha,
      runId: String(runId),
      attempt: String(attempt),
      sourceDirectory,
      dependencies,
    });
    complete("核对并恢复中断发布");
    if (recovery.recovered) {
      return {
        schema: "ai-employee-local-release-result/v1",
        dryRun: false,
        executed: true,
        released: recovery.status === "target_recovered",
        recoveredInterruptedRelease: true,
        recoveryStatus: recovery.status,
        sha,
        releaseDirectory: recovery.releaseDirectory,
        previousReleaseAvailable: true,
        completedSteps,
        databaseRollbackPerformed: false,
      };
    }

    const prepared = await dependencies.prepareRelease({
      root,
      sha,
      runId: String(runId),
      attempt: String(attempt),
    });
    releaseDirectory = prepared.releaseDirectory;
    previousRelease = prepared.previousRelease ?? "";
    complete("准备不可变版本目录");
    if (!previousRelease) {
      throw new Error("没有可回退的上一版本，禁止进入本机原子服务切换");
    }
    const previousVerification =
      await dependencies.verifyPreviousReleaseAgainstCommit({
        releaseDirectory: previousRelease,
        sourceDirectory,
      });
    previousSha = validateCommitSha(previousVerification?.sha);
    if (
      previousVerification?.sha !== previousSha ||
      !/^[0-9a-f]{64}$/u.test(
        String(previousVerification?.integrityDigest ?? ""),
      )
    ) {
      throw new Error("上一版本的 40 位提交身份或完整性验证无效");
    }
    previousIntegrityDigest = previousVerification.integrityDigest;
    await dependencies.materializeRelease({
      sha,
      sourceDirectory,
      releaseDirectory,
    });
    const releaseIntegrity = await dependencies.captureReleaseIntegrity({
      releaseDirectory,
    });
    await dependencies.installDependencies({ releaseDirectory });
    await dependencies.auditRelease({ releaseDirectory });
    await dependencies.checkRelease({ releaseDirectory });
    await dependencies.verifyReleaseIntegrity({
      releaseDirectory,
      expected: releaseIntegrity,
    });
    await dependencies.installDependencies({ releaseDirectory });
    await dependencies.verifyReleaseIntegrity({
      releaseDirectory,
      expected: releaseIntegrity,
    });
    complete("写入目标提交并完成包内检查");

    await dependencies.verifyPreviousReleaseIntegrity({
      releaseDirectory: previousRelease,
      expectedDigest: previousIntegrityDigest,
    });
    await assertOrdinaryReleaseMigrationBoundary({
      releaseDirectory,
      previousRelease,
    });
    complete("核对第 018 号前滚边界");

    releaseConfigPath = await dependencies.copyProductionConfig({
      configPath,
      releaseDirectory,
    });
    complete("复制受保护生产配置");
    const releaseContext = { releaseDirectory, configPath: releaseConfigPath };
    const previousConfigPath = join(
      previousRelease,
      ".runtime",
      "production.json",
    );
    runtimeIdentityBinding =
      await dependencies.compareReleaseRuntimeIdentity({
        targetConfigPath: releaseConfigPath,
        previousConfigPath,
      });
    await dependencies.validateRollbackTarget({
      ...releaseContext,
      previousRelease,
    });
    complete("只读生产预检与回退目标门禁");
    await dependencies.backupDatabase(releaseContext);
    complete("创建加密数据库备份");
    await dependencies.migrateDatabase(releaseContext);
    complete("执行前向数据库迁移");
    await dependencies.runDoctor(releaseContext);
    await dependencies.runCodexProbe(releaseContext);
    await dependencies.verifyReleaseIntegrity({
      releaseDirectory,
      expected: releaseIntegrity,
    });
    await dependencies.installDependencies({ releaseDirectory });
    await dependencies.verifyReleaseIntegrity({
      releaseDirectory,
      expected: releaseIntegrity,
    });
    complete("运行严格诊断与合成 Codex 探针");

    await dependencies.verifyPreviousReleaseIntegrity({
      releaseDirectory: previousRelease,
      expectedDigest: previousIntegrityDigest,
    });
    await dependencies.verifyReleaseRuntimeIdentityBinding({
      targetConfigPath: releaseConfigPath,
      previousConfigPath,
      expected: runtimeIdentityBinding,
    });
    pendingRelease = await dependencies.writePendingRelease({
      root,
      sha,
      runId: String(runId),
      attempt: String(attempt),
      previousRelease,
      targetRelease: releaseDirectory,
      integrityDigest: releaseIntegrityDigest(releaseIntegrity.entries),
      previousSha,
      previousIntegrityDigest,
      ...runtimeIdentityBinding,
    });
    serviceSwitchAttempted = true;
    await dependencies.installService(releaseContext);
    await dependencies.cleanupServices(releaseContext);
    await dependencies.verifyService(releaseContext);
    await dependencies.verifyReleaseIntegrity({
      releaseDirectory,
      expected: releaseIntegrity,
    });
    await dependencies.verifyPreviousReleaseIntegrity({
      releaseDirectory: previousRelease,
      expectedDigest: previousIntegrityDigest,
    });
    await dependencies.verifyReleaseRuntimeIdentityBinding({
      targetConfigPath: releaseConfigPath,
      previousConfigPath,
      expected: pendingRelease,
    });
    pendingRelease = await dependencies.updatePendingRelease({
      root,
      token: pendingRelease.token,
      phase: "service_verified",
    });
    complete("安装、清理并验证常驻服务");
    await dependencies.activateRelease({
      ...releaseContext,
      root,
      runId: String(runId),
      attempt: String(attempt),
    });
    currentActivated = true;
    await dependencies.clearPendingRelease({
      root,
      token: pendingRelease.token,
    });
    pendingRelease = null;
    complete("原子激活成功版本");
    return {
      schema: "ai-employee-local-release-result/v1",
      dryRun: false,
      executed: true,
      released: true,
      sha,
      releaseDirectory,
      previousReleaseAvailable: Boolean(previousRelease),
      completedSteps,
      databaseRollbackPerformed: false,
    };
  } catch (error) {
    if (serviceSwitchAttempted && previousRelease && releaseConfigPath) {
      if (currentActivated) {
        throw new AggregateError(
          [error],
          "目标版本已激活但中断发布记录未清理；已保留记录并停止",
        );
      }
      try {
        await dependencies.verifyPendingReleaseIntegrity({
          releaseDirectory,
          expectedDigest: pendingRelease.integrityDigest,
        });
        await dependencies.verifyReleaseRuntimeIdentityBinding({
          targetConfigPath: releaseConfigPath,
          previousConfigPath: join(
            previousRelease,
            ".runtime",
            "production.json",
          ),
          expected: pendingRelease,
        });
        await dependencies.verifyPreviousReleaseIntegrity({
          releaseDirectory: previousRelease,
          expectedDigest: pendingRelease.previousIntegrityDigest,
        });
        await dependencies.rollbackStateGuard({
          releaseDirectory,
          configPath: releaseConfigPath,
          previousRelease,
        });
        const previousContext = {
          releaseDirectory: previousRelease,
          configPath: join(previousRelease, ".runtime", "production.json"),
        };
        await dependencies.verifyPreviousReleaseIntegrity({
          releaseDirectory: previousRelease,
          expectedDigest: pendingRelease.previousIntegrityDigest,
        });
        await dependencies.installService(previousContext);
        await dependencies.cleanupServices(previousContext);
        await dependencies.verifyService(previousContext);
        await dependencies.activateRelease({
          ...previousContext,
          root,
          runId: String(runId),
          attempt: String(attempt),
        });
        if (pendingRelease) {
          await dependencies.clearPendingRelease({
            root,
            token: pendingRelease.token,
          });
          pendingRelease = null;
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "本机版本发布失败，上一版本服务回退也未完整通过；数据库未自动回退",
        );
      }
    }
    throw error;
  } finally {
    await releaseLock?.release();
  }
}

function option(args, name, { required = false } = {}) {
  const indexes = args.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} 只能提供一次`);
  const value = indexes.length === 1 ? args[indexes[0] + 1] : undefined;
  if (indexes.length === 1 && (!value || value.startsWith("--"))) {
    throw new Error(`${name} 缺少参数值`);
  }
  if (required && !value) throw new Error(`缺少参数：${name}`);
  return value;
}

function parseArguments(args) {
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run");
  if (apply && dryRun) throw new Error("--apply 和 --dry-run 不能同时使用");
  const known = new Set([
    "--sha",
    "--root",
    "--config",
    "--source",
    "--run-id",
    "--attempt",
    "--apply",
    "--dry-run",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!known.has(value)) throw new Error(`未知参数：${value}`);
    if (!["--apply", "--dry-run"].includes(value)) index += 1;
  }
  return {
    sha: option(args, "--sha", { required: true }),
    root: option(args, "--root") ?? process.env.AI_EMPLOYEE_DEPLOY_ROOT,
    configPath: option(args, "--config") ?? process.env.AI_EMPLOYEE_CONFIG_FILE,
    sourceDirectory: option(args, "--source") ?? process.cwd(),
    runId: option(args, "--run-id") ?? `${Date.now()}${process.pid}`,
    attempt: option(args, "--attempt") ?? "1",
    apply,
  };
}

if (isMainModule(import.meta.url)) {
  try {
    const result = await runLocalAtomicRelease(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      released: false,
      error: error.message,
      databaseRollbackPerformed: false,
    }, null, 2));
    process.exitCode = 1;
  }
}
