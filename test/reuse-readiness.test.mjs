import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("新环境向导用一个 install 命令安装 Hermes 且默认只预览", async () => {
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const calls = [];
  const hermesInstaller = async (input) => {
    calls.push(input);
    return { schema: "foursday-hermes-install/v1", installed: input.apply };
  };
  const preview = await runReuseGuide({
    args: ["install"],
    cwd: "/workspace/new-owner",
    hermesInstaller,
  });
  const applied = await runReuseGuide({
    args: ["install", "--apply"],
    cwd: "/workspace/new-owner",
    hermesInstaller,
  });
  assert.equal(preview.installed, false);
  assert.equal(applied.installed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].apply, false);
  assert.equal(calls[1].apply, true);
  assert.equal(calls[0].projectRoot, packageRoot);
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
  assert.ok(result.nextActions.includes("运行 foursday init --apply 创建受保护配置"));
});

test("完整安全配置通过本地复用门禁但不会执行联网预检", async (t) => {
  const { configPath } = await fixture(t);
  await initializeProductionConfig({ outputPath: configPath });
  const values = JSON.parse(await readFile(configPath, "utf8"));
  Object.assign(values, {
    DATABASE_URL: "env://AI_EMPLOYEE_DATABASE_URL",
    AI_EMPLOYEE_PERSONAL_MEMORY_ENABLED: true,
    AI_EMPLOYEE_PERSONAL_MEMORY_MCP_URL: "https://memory.example.test/mcp",
    AI_EMPLOYEE_PERSONAL_MEMORY_ISSUER_URL: "https://memory.example.test",
    AI_EMPLOYEE_PERSONAL_MEMORY_CLIENT_ID: "foursday-reader",
    AI_EMPLOYEE_PERSONAL_MEMORY_CLIENT_SECRET:
      "env://FOURSDAY_PERSONAL_MEMORY_CLIENT_SECRET",
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
  assert.equal(result.config.externalSecretReferences, 6);
  assert.deepEqual(checked, ["dws", "codex", "pg_dump", "pg_restore", "/usr/bin/git"]);
  assert.deepEqual(result.nextActions, ["运行 foursday preflight 进行联网只读预检"]);
  assert.doesNotMatch(JSON.stringify(result), /AI_EMPLOYEE_DATABASE_URL|target-1|self-1/u);
});

test("复用检查按配置选择 Claude Code 而不再强制 Codex", async (t) => {
  const { configPath } = await fixture(t);
  await initializeProductionConfig({ outputPath: configPath });
  const values = JSON.parse(await readFile(configPath, "utf8"));
  Object.assign(values, {
    DATABASE_URL: "env://AI_EMPLOYEE_DATABASE_URL",
    AI_EMPLOYEE_PERSONAL_MEMORY_ENABLED: true,
    AI_EMPLOYEE_PERSONAL_MEMORY_MCP_URL: "https://memory.example.test/mcp",
    AI_EMPLOYEE_PERSONAL_MEMORY_ISSUER_URL: "https://memory.example.test",
    AI_EMPLOYEE_PERSONAL_MEMORY_CLIENT_ID: "foursday-reader",
    AI_EMPLOYEE_PERSONAL_MEMORY_CLIENT_SECRET:
      "env://FOURSDAY_PERSONAL_MEMORY_CLIENT_SECRET",
    AI_EMPLOYEE_TENANT_ID: "tenant-1",
    AI_EMPLOYEE_APPROVER: "operator-1",
    DINGTALK_TARGET_USER_IDS: "target-1",
    DINGTALK_SELF_USER_ID: "self-1",
    AI_EMPLOYEE_AGENT_RUNTIME: "claude-code",
    CLAUDE_CODE_PATH: "/trusted/claude",
  });
  await writeFile(configPath, JSON.stringify(values, null, 2) + "\n", { mode: 0o600 });
  const checked = [];
  const result = await inspectReuseReadiness({
    configPath,
    platform: "darwin",
    nodeVersion: "v22.5.0",
    executableChecker: async (path) => {
      checked.push(path);
      return true;
    },
  });
  assert.equal(result.readyForPreflight, true);
  assert.equal(checked.includes("/trusted/claude"), true);
  assert.equal(checked.includes("codex"), false);
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

test("管理台用户名密码配置必须成对有效且会话时长有界", async (t) => {
  const { configPath } = await fixture(t);
  await initializeProductionConfig({ outputPath: configPath });
  const values = JSON.parse(await readFile(configPath, "utf8"));
  Object.assign(values, {
    DATABASE_URL: "env://AI_EMPLOYEE_DATABASE_URL",
    AI_EMPLOYEE_TENANT_ID: "tenant-1",
    AI_EMPLOYEE_APPROVER: "operator-1",
    DINGTALK_TARGET_USER_IDS: "target-1",
    DINGTALK_SELF_USER_ID: "self-1",
    AI_EMPLOYEE_ADMIN_LOGIN_IDENTIFIERS: "owner@example.com",
    AI_EMPLOYEE_ADMIN_PASSWORD_HASH: "",
    AI_EMPLOYEE_ADMIN_SESSION_TTL_MS: 1000,
  });
  await writeFile(configPath, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  const result = await inspectReuseReadiness({
    configPath,
    platform: "darwin",
    nodeVersion: "v22.5.0",
    executableChecker: async () => true,
  });
  assert.equal(result.readyForPreflight, false);
  assert.ok(result.config.requiredEdits.includes("修复管理台用户名密码登录配置"));
});

test("初始化入口默认只预览，显式应用后创建配置且拒绝覆盖", async (t) => {
  const { directory, configPath } = await fixture(t);
  const preview = await runReuseGuide({ args: ["init"], cwd: directory });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.executed, false);
  assert.equal(preview.configExists, false);
  await assert.rejects(readFile(configPath), (error) => error.code === "ENOENT");

  const result = await runReuseGuide({
    args: ["init", "--apply"],
    cwd: directory,
  });
  assert.equal(result.path, configPath);
  assert.equal(result.mode, "600");
  assert.equal(result.executed, true);
  assert.equal(result.generatedSecrets.length, 0);
  assert.equal(result.externalSecretReferences.length, 4);
  assert.equal(result.memorySource, undefined);
  await assert.rejects(
    readFile(join(directory, ".runtime", "gbrain", "brain", "README.md")),
    (error) => error.code === "ENOENT",
  );
  await assert.rejects(
    runReuseGuide({
      args: ["init", "--apply"],
      cwd: directory,
    }),
    (error) => error.code === "EEXIST",
  );
});

test("安装包的一条命令入口启动同一套回环 Web 接入页", async () => {
  const calls = [];
  const result = await runReuseGuide({
    args: ["start", "--port", "4317"],
    cwd: "/workspace/new-owner",
    activationRunner: async (options) => {
      calls.push(options);
      return { url: "http://127.0.0.1:4317" };
    },
  });
  assert.equal(result.schema, "foursday-activation-launch/v1");
  assert.equal(result.url, "http://127.0.0.1:4317");
  assert.equal(result.workingDirectory, "/workspace/new-owner");
  assert.equal(result.externalSystemsTouched, false);
  assert.match(result.boundary, /完整计划再次审批/u);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["--port", "4317"]);
  assert.equal(calls[0].workingDirectory, "/workspace/new-owner");

  const help = await runReuseGuide({
    args: ["start", "--help"],
    cwd: "/workspace/new-owner",
    activationRunner: async () => { throw new Error("help must not start a listener"); },
  });
  assert.match(help.help, /foursday start \[options\]/u);
  await assert.rejects(
    runReuseGuide({
      args: ["start", "--config", "production.json"],
      cwd: "/workspace/new-owner",
      activationRunner: async () => ({ url: "unexpected" }),
    }),
    /Usage: foursday start/u,
  );
});

test("新环境钥匙串命令默认预览且显式应用参数单独传递", async (t) => {
  const { directory, configPath } = await fixture(t);
  await runReuseGuide({
    args: ["init", "--apply"],
    cwd: directory,
  });
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

test("安装包上线命令默认计划写操作并只从固定包内脚本执行", async (t) => {
  const { directory, configPath } = await fixture(t);
  const calls = [];
  const scriptRunner = async (options) => {
    calls.push(options);
    return { applied: [] };
  };

  const migrationPlan = await runReuseGuide({
    args: ["migrate", "--config", configPath],
    cwd: directory,
    scriptRunner,
  });
  assert.equal(migrationPlan.schema, "ai-employee-command-plan/v1");
  assert.equal(migrationPlan.dryRun, true);
  assert.equal(migrationPlan.executed, false);
  assert.equal(migrationPlan.applyRequired, true);
  assert.match(migrationPlan.packageScript, /\/src\/migrate\.mjs$/u);
  assert.equal(calls.length, 0);

  const servicePlan = await runReuseGuide({
    args: ["service", "install", "--config", configPath],
    cwd: directory,
    scriptRunner,
  });
  assert.equal(servicePlan.action, "install");
  assert.equal(servicePlan.executed, false);
  assert.match(servicePlan.boundary, /受控发布流程/u);
  assert.equal(calls.length, 0);

  const applied = await runReuseGuide({
    args: ["migrate", "--apply", "--config", configPath],
    cwd: directory,
    scriptRunner,
  });
  assert.equal(applied.executed, true);
  assert.deepEqual(applied.result, { applied: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].configPath, configPath);
  assert.deepEqual(calls[0].args, []);

  const preflightPlan = await runReuseGuide({
    args: ["preflight", "--dry-run", "--config", configPath],
    cwd: directory,
    scriptRunner,
  });
  assert.equal(preflightPlan.executed, false);
  assert.equal(preflightPlan.applyRequired, false);
  assert.match(preflightPlan.packageScript, /\/scripts\/生产预检\.mjs$/u);
  assert.equal(calls.length, 1);

  await assert.rejects(
    runReuseGuide({
      args: ["doctor", "--apply", "--config", configPath],
      cwd: directory,
      scriptRunner,
    }),
    /read-only/u,
  );
  await assert.rejects(
    runReuseGuide({
      args: ["migrate", "--apply", "--dry-run", "--config", configPath],
      cwd: directory,
      scriptRunner,
    }),
    /cannot be used together/u,
  );
});
