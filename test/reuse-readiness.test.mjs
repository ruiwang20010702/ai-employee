import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeProductionConfig } from "../scripts/初始化生产配置.mjs";
import {
  reuseConfigPath,
  runReuseGuide,
} from "../scripts/新环境向导.mjs";
import { inspectReuseReadiness } from "../src/reuse-readiness.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ai-reuse-readiness-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, configPath: join(directory, ".runtime", "production.json") };
}

test("新环境向导默认使用当前工作目录而不是安装包目录", () => {
  assert.equal(
    reuseConfigPath(["check"], "/workspace/new-owner"),
    "/workspace/new-owner/.runtime/production.json",
  );
  assert.equal(
    reuseConfigPath(["check", "--config", "custom.json"], "/workspace/new-owner"),
    "/workspace/new-owner/custom.json",
  );
});

test("缺少配置时只读检查给出初始化动作且不假装可预检", async (t) => {
  const { configPath } = await fixture(t);
  const result = await inspectReuseReadiness({
    configPath,
    platform: "darwin",
    nodeVersion: "v22.5.0",
    executableChecker: async () => true,
  });
  assert.equal(result.readOnly, true);
  assert.equal(result.config.exists, false);
  assert.equal(result.readyForPreflight, false);
  assert.ok(result.nextActions.includes("运行 ai-employee init 创建受保护配置"));
});

test("完整安全配置通过本地复用门禁但不会执行联网预检", async (t) => {
  const { configPath } = await fixture(t);
  await initializeProductionConfig({ outputPath: configPath });
  const values = JSON.parse(await readFile(configPath, "utf8"));
  Object.assign(values, {
    DATABASE_URL: "env://AI_EMPLOYEE_DATABASE_URL",
    AI_EMPLOYEE_TENANT_ID: "tenant-1",
    AI_EMPLOYEE_APPROVER: "operator-1",
    DINGTALK_TARGET_USER_IDS: "target-1",
    DINGTALK_SELF_USER_ID: "self-1",
  });
  await writeFile(configPath, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  const checked = [];
  const result = await inspectReuseReadiness({
    configPath,
    platform: "darwin",
    nodeVersion: "v24.0.0",
    executableChecker: async (path) => {
      checked.push(path);
      return true;
    },
  });
  assert.equal(result.readyForPreflight, true);
  assert.deepEqual(result.config.requiredEdits, []);
  assert.deepEqual(result.config.unsafeCapabilitiesEnabled, []);
  assert.equal(result.config.inlineSecretValues, 0);
  assert.equal(result.config.externalSecretReferences, 5);
  assert.deepEqual(checked, ["dws", "codex", "pg_dump", "pg_restore", "/usr/bin/git"]);
  assert.deepEqual(result.nextActions, ["运行 production:preflight 进行联网只读预检"]);
  assert.doesNotMatch(JSON.stringify(result), /AI_EMPLOYEE_DATABASE_URL|target-1|self-1/u);
});

test("危险能力、宽权限、旧 Node 和缺失工具都会明确阻断", async (t) => {
  const { configPath } = await fixture(t);
  await initializeProductionConfig({ outputPath: configPath });
  const values = JSON.parse(await readFile(configPath, "utf8"));
  Object.assign(values, {
    AI_EMPLOYEE_ALLOWED_CAPABILITIES: "draft_reply,send_message,work_plan_execution",
  });
  await writeFile(configPath, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o644 });
  await chmod(configPath, 0o644);
  const result = await inspectReuseReadiness({
    configPath,
    platform: "linux",
    nodeVersion: "v20.0.0",
    executableChecker: async (path) => path !== "dws",
  });
  assert.equal(result.readyForPreflight, false);
  assert.equal(result.config.protected, false);
  assert.ok(result.config.requiredEdits.includes("填写数据库连接"));
  assert.deepEqual(result.config.unsafeCapabilitiesEnabled, [
    "send_message",
    "work_plan_execution",
  ]);
  assert.ok(result.nextActions.includes("使用 macOS 主机运行生产服务"));
  assert.ok(result.nextActions.includes("安装 Node.js 22.5 或更高版本"));
  assert.ok(result.nextActions.includes("安装或配置：DWS"));
});

test("畸形外部引用和重复密钥不能通过本地配置检查", async (t) => {
  const { configPath } = await fixture(t);
  await initializeProductionConfig({ outputPath: configPath });
  const values = JSON.parse(await readFile(configPath, "utf8"));
  Object.assign(values, {
    DATABASE_URL: "env://bad-name",
    AI_EMPLOYEE_DATA_KEY: values.AI_EMPLOYEE_BACKUP_KEY,
    AI_EMPLOYEE_TENANT_ID: "tenant-1",
    AI_EMPLOYEE_APPROVER: "operator-1",
    DINGTALK_TARGET_USER_IDS: "target-1",
    DINGTALK_SELF_USER_ID: "self-1",
  });
  await writeFile(configPath, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  const result = await inspectReuseReadiness({
    configPath,
    platform: "darwin",
    nodeVersion: "v22.5.0",
    executableChecker: async () => true,
  });
  assert.equal(result.readyForPreflight, false);
  assert.ok(result.config.requiredEdits.includes("修复 DATABASE_URL 外部密钥引用"));
  assert.ok(result.config.requiredEdits.includes("数据密钥和备份密钥必须不同"));
});

test("初始化入口创建配置且拒绝覆盖", async (t) => {
  const { directory, configPath } = await fixture(t);
  const result = await runReuseGuide({ args: ["init"], cwd: directory });
  assert.equal(result.path, configPath);
  assert.equal(result.mode, "600");
  assert.equal(result.generatedSecrets.length, 0);
  assert.equal(result.externalSecretReferences.length, 4);
  await assert.rejects(
    runReuseGuide({ args: ["init"], cwd: directory }),
    (error) => error.code === "EEXIST",
  );
});

test("新环境钥匙串命令默认预览且显式应用参数单独传递", async (t) => {
  const { directory, configPath } = await fixture(t);
  await runReuseGuide({ args: ["init"], cwd: directory });
  const calls = [];
  const keychainProvisioner = async (options) => {
    calls.push(options);
    return { dryRun: !options.apply, secretsPrinted: false };
  };
  await runReuseGuide({ args: ["secrets"], cwd: directory, keychainProvisioner });
  await runReuseGuide({
    args: ["secrets", "--apply", "--config", configPath],
    cwd: directory,
    keychainProvisioner,
  });
  assert.deepEqual(calls, [
    { configPath, apply: false },
    { configPath, apply: true },
  ]);
});
