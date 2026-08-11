import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdtemp,
  readdir,
  rm,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isMainModule } from "../src/main-module.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const testDirectoryPrefix = "ai-employee-pgtest-";

export function assertSafeTemporaryTestDirectory(path, systemTemporaryDirectory = tmpdir()) {
  const target = resolve(path);
  const parent = resolve(systemTemporaryDirectory);
  if (
    dirname(target) !== parent ||
    !basename(target).startsWith(testDirectoryPrefix) ||
    basename(target).length <= testDirectoryPrefix.length
  ) {
    throw new Error("临时 PostgreSQL 测试目录不在允许范围内");
  }
  return target;
}

export function isolatedTestEnvironment(environment, databaseUrl) {
  const result = {};
  const exactBlocked = new Set([
    "DATABASE_URL",
    "DATABASE_SSL",
    "DWS_PATH",
    "CODEX_PATH",
    "CLAUDE_CODE_PATH",
    "GBRAIN_PATH",
    "TEST_DATABASE_URL",
    "TEST_DATABASE_TEMP",
  ]);
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (
      exactBlocked.has(key) ||
      key.startsWith("AI_EMPLOYEE_") ||
      key.startsWith("DINGTALK_") ||
      key.startsWith("ANTHROPIC_") ||
      key.startsWith("PG")
    ) continue;
    result[key] = value;
  }
  return {
    ...result,
    TEST_DATABASE_URL: databaseUrl,
    TEST_DATABASE_TEMP: "false",
  };
}

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function versionedDirectories(root) {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) =>
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        /^postgresql@\d+$/u.test(entry.name),
      )
      .map((entry) => join(root, entry.name, "bin"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export async function findPostgresBin({ environment = process.env } = {}) {
  const candidates = [];
  if (environment.PG_TEST_BIN) candidates.push(resolve(environment.PG_TEST_BIN));
  try {
    const { stdout } = await execFileAsync("pg_config", ["--bindir"], {
      env: environment,
      encoding: "utf8",
    });
    if (stdout.trim()) candidates.push(resolve(stdout.trim()));
  } catch {}
  candidates.push(
    ...await versionedDirectories("/opt/homebrew/opt"),
    ...await versionedDirectories("/usr/local/opt"),
  );
  for (const candidate of [...new Set(candidates)]) {
    if (
      await executable(join(candidate, "initdb")) &&
      await executable(join(candidate, "pg_ctl")) &&
      await executable(join(candidate, "createdb"))
    ) return candidate;
  }
  throw new Error("未找到本机 PostgreSQL 测试工具；请安装 PostgreSQL，或设置 PG_TEST_BIN 指向 bin 目录");
}

async function availablePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error("无法分配本机测试端口");
  return port;
}

function runInherited(command, args, options) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    let interrupted = null;
    const forward = (signal) => {
      interrupted = signal;
      child.kill(signal);
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const finish = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    child.once("error", (error) => {
      finish();
      reject(error);
    });
    child.once("close", (code, signal) => {
      finish();
      if (code === 0) accept();
      else reject(new Error(
        interrupted || signal
          ? `完整测试被 ${interrupted ?? signal} 中断`
          : `完整测试失败，退出码 ${code}`,
      ));
    });
  });
}

export async function runCompleteTest({
  environment = process.env,
  root = projectRoot,
  postgresBin,
  systemTemporaryDirectory = tmpdir(),
} = {}) {
  const testFiles = await readdir(join(resolve(root), "test"))
    .then((entries) => entries.filter((name) => name.endsWith(".test.mjs")))
    .catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  if (testFiles.length === 0) {
    throw new Error("完整测试只能在包含 test 目录的源码仓库中运行");
  }
  const bin = postgresBin ?? await findPostgresBin({ environment });
  const temporaryRoot = assertSafeTemporaryTestDirectory(
    await mkdtemp(join(systemTemporaryDirectory, testDirectoryPrefix)),
    systemTemporaryDirectory,
  );
  const dataDirectory = join(temporaryRoot, "data");
  const logPath = join(temporaryRoot, "postgres.log");
  const port = await availablePort();
  const databaseUser = "ai_employee_test_admin";
  const databaseName = "ai_employee_test";
  const databaseUrl = `postgresql://${databaseUser}@127.0.0.1:${port}/${databaseName}`;
  let started = false;
  try {
    await execFileAsync(join(bin, "initdb"), [
      "-D", dataDirectory,
      `--username=${databaseUser}`,
      "--auth=trust",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    await execFileAsync(join(bin, "pg_ctl"), [
      "-D", dataDirectory,
      "-o", `-p ${port} -h 127.0.0.1`,
      "-l", logPath,
      "-w", "start",
    ]);
    started = true;
    await execFileAsync(join(bin, "createdb"), [
      "-h", "127.0.0.1",
      "-p", String(port),
      "-U", databaseUser,
      databaseName,
    ]);
    await runInherited(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "check"],
      {
        cwd: resolve(root),
        env: isolatedTestEnvironment(environment, databaseUrl),
      },
    );
    return { valid: true, database: "isolated-temporary", cleanup: true };
  } finally {
    if (started) {
      try {
        await execFileAsync(join(bin, "pg_ctl"), [
          "-D", dataDirectory,
          "-m", "fast",
          "-w", "stop",
        ]);
        started = false;
      } catch {
        await execFileAsync(join(bin, "pg_ctl"), [
          "-D", dataDirectory,
          "-m", "immediate",
          "-w", "stop",
        ]);
        started = false;
      }
    }
    if (!started) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  console.log(JSON.stringify(await runCompleteTest(), null, 2));
}
