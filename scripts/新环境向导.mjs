#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initializeProductionConfig } from "./初始化生产配置.mjs";
import { provisionGeneratedKeychainSecrets } from "./初始化钥匙串密钥.mjs";
import { inspectReuseReadiness } from "../src/reuse-readiness.mjs";
import { isMainModule } from "../src/main-module.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const planSchema = "ai-employee-command-plan/v1";

const bundledCommands = Object.freeze({
  preflight: Object.freeze({
    script: "scripts/生产预检.mjs",
    effect: "联网只读检查配置、授权、工具和数据库迁移状态",
  }),
  doctor: Object.freeze({
    script: "scripts/只读生产诊断.mjs",
    effect: "联网只读检查生产依赖和数据库结构",
  }),
  backup: Object.freeze({
    script: "scripts/备份数据库.mjs",
    applyRequired: true,
    effect: "读取数据库并在配置的备份目录创建加密备份",
  }),
  migrate: Object.freeze({
    script: "src/migrate.mjs",
    applyRequired: true,
    effect: "对配置的 PostgreSQL 数据库应用尚未执行的迁移",
  }),
  probe: Object.freeze({
    script: "scripts/验证草稿生成.mjs",
    applyRequired: true,
    effect: "使用固定合成消息调用当前 AgentRuntime，不读取业务消息或数据库",
  }),
  verify: Object.freeze({
    script: "scripts/验证生产服务.mjs",
    effect: "只读检查严格业务就绪和本机管理台",
  }),
  shadow: Object.freeze({
    script: "scripts/影子模式验收.mjs",
    effect: "使用数据库只读会话检查健康、异常任务和人工质量门槛",
  }),
});

const serviceActions = Object.freeze({
  generate: Object.freeze({
    script: "scripts/管理常驻服务.mjs",
    args: ["generate"],
    applyRequired: true,
    effect: "在当前安装包运行目录生成 9 个 LaunchAgent 配置，不加载服务",
  }),
  install: Object.freeze({
    script: "scripts/管理常驻服务.mjs",
    args: ["install"],
    applyRequired: true,
    effect: "从当前安装包目录生成、安装并加载 9 个 LaunchAgent",
  }),
  uninstall: Object.freeze({
    script: "scripts/管理常驻服务.mjs",
    args: ["uninstall"],
    applyRequired: true,
    effect: "卸载 Foursday LaunchAgent；保留 plist 以便人工恢复",
  }),
  verify: Object.freeze({
    script: "scripts/验证服务部署.mjs",
    args: [],
    effect: "只读核对 9 个 LaunchAgent、健康接口和目标安装包目录",
  }),
});

function argumentValue(args, name) {
  const indexes = args.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length === 0) return null;
  if (indexes.length > 1) throw new Error(`${name} must be provided once`);
  const value = args[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parsedArguments(args) {
  argumentValue(args, "--config");
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run");
  if (apply && dryRun) throw new Error("--apply and --dry-run cannot be used together");
  const positionals = [];
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--config") {
      index += 1;
      continue;
    }
    if (value === "--apply" || value === "--dry-run") continue;
    if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    positionals.push(value);
  }
  return { apply, dryRun, positionals };
}

export function reuseConfigPath(args = process.argv.slice(2), cwd = process.cwd()) {
  const input = argumentValue(args, "--config") ??
    process.env.AI_EMPLOYEE_CONFIG_FILE ??
    ".runtime/production.json";
  return resolve(cwd, input);
}

function packageScript(relativePath) {
  return fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
}

async function defaultScriptRunner({ scriptPath, args, cwd, configPath }) {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: {
      ...process.env,
      AI_EMPLOYEE_CONFIG_FILE: configPath,
      AI_EMPLOYEE_EXPECTED_RELEASE_DIRECTORY: packageRoot,
    },
    timeout: 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = stdout.trim();
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return { output };
  }
}

function commandPlan({ command, action = null, definition, configPath, cwd }) {
  return {
    schema: planSchema,
    command,
    action,
    dryRun: true,
    executed: false,
    applyRequired: Boolean(definition.applyRequired),
    configPath,
    workingDirectory: resolve(cwd),
    packageRoot,
    packageScript: packageScript(definition.script),
    scriptArguments: definition.args ?? [],
    effect: definition.effect,
    boundary: command === "service"
      ? "服务会从当前安装包目录运行；生产升级、不可变版本切换和自动回退仍须使用受控发布流程。"
      : "预览不会调用包内脚本，不连接外部服务，也不写文件、数据库或 LaunchAgent。",
  };
}

async function runBundledCommand({
  command,
  action = null,
  definition,
  options,
  configPath,
  cwd,
  scriptRunner,
}) {
  if (options.positionals.length > 0) {
    throw new Error(`Unexpected argument: ${options.positionals[0]}`);
  }
  if (options.apply && !definition.applyRequired) {
    throw new Error(`${command}${action ? ` ${action}` : ""} is read-only and does not accept --apply`);
  }
  const plan = commandPlan({ command, action, definition, configPath, cwd });
  await access(plan.packageScript);
  if (options.dryRun || (definition.applyRequired && !options.apply)) return plan;
  return {
    ...plan,
    dryRun: false,
    executed: true,
    result: await scriptRunner({
      scriptPath: plan.packageScript,
      args: plan.scriptArguments,
      cwd: resolve(cwd),
      configPath,
    }),
  };
}

function help() {
  return {
    usage: [
      "foursday check [--config /absolute/path.json]",
      "foursday init [--apply] [--config /absolute/path.json]",
      "foursday secrets [--apply] [--config /absolute/path.json]",
      "foursday preflight [--dry-run] [--config /absolute/path.json]",
      "foursday doctor [--dry-run] [--config /absolute/path.json]",
      "foursday backup [--apply] [--config /absolute/path.json]",
      "foursday migrate [--apply] [--config /absolute/path.json]",
      "foursday probe [--apply] [--config /absolute/path.json]",
      "foursday service [generate|install|uninstall|verify] [--apply|--dry-run] [--config /absolute/path.json]",
      "foursday verify [--dry-run] [--config /absolute/path.json]",
      "foursday shadow [--dry-run] [--config /absolute/path.json]",
    ],
    sequence: [
      "init --apply",
      "secrets --apply",
      "check",
      "preflight",
      "backup --apply",
      "migrate --apply",
      "doctor",
      "probe --apply",
      "service install --apply",
      "service verify",
      "verify",
      "shadow",
    ],
    boundary: "check 和所有 --dry-run 只读取本机文件或生成执行计划，不连接钉钉、AgentRuntime 或数据库；init、secrets、backup、migrate、probe 及服务变更只有显式 --apply 才执行。生产放量仍需独立审批。",
  };
}

export async function runReuseGuide({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  keychainProvisioner = provisionGeneratedKeychainSecrets,
  configInitializer = initializeProductionConfig,
  scriptRunner = defaultScriptRunner,
} = {}) {
  const command = args[0] ?? "check";
  if (["help", "--help", "-h"].includes(command)) return help();
  const options = parsedArguments(args);
  const configPath = reuseConfigPath(args, cwd);

  if (command === "init") {
    if (options.positionals.length > 0) {
      throw new Error(`Unexpected argument: ${options.positionals[0]}`);
    }
    if (!options.apply) {
      return {
        schema: planSchema,
        command,
        dryRun: true,
        executed: false,
        applyRequired: true,
        configPath,
        configExists: await access(configPath).then(() => true).catch(() => false),
        effect: "创建权限为 600 且只含独立钥匙串引用的生产配置；已有文件绝不覆盖",
      };
    }
    const initialized = await configInitializer({ outputPath: configPath });
    return {
      command,
      dryRun: false,
      executed: true,
      ...initialized,
      next: "先运行 foursday secrets --apply，再填写 requiredEdits 并运行 foursday check",
    };
  }
  if (command === "secrets") {
    if (options.positionals.length > 0 || options.dryRun) {
      throw new Error("Usage: foursday secrets [--apply] [--config /absolute/path.json]");
    }
    return keychainProvisioner({ configPath, apply: options.apply });
  }
  if (command === "check") {
    if (options.positionals.length > 0 || options.apply || options.dryRun) {
      throw new Error("Usage: foursday check [--config /absolute/path.json]");
    }
    return inspectReuseReadiness({ configPath });
  }
  if (command === "service") {
    const action = options.positionals.shift() ?? "install";
    const definition = serviceActions[action];
    if (!definition) {
      throw new Error("Usage: foursday service [generate|install|uninstall|verify] [--apply|--dry-run] [--config /absolute/path.json]");
    }
    return runBundledCommand({
      command,
      action,
      definition,
      options,
      configPath,
      cwd,
      scriptRunner,
    });
  }
  const definition = bundledCommands[command];
  if (definition) {
    return runBundledCommand({
      command,
      definition,
      options,
      configPath,
      cwd,
      scriptRunner,
    });
  }
  throw new Error("Usage: foursday help (legacy alias: ai-employee help)");
}

if (isMainModule(import.meta.url)) {
  console.log(JSON.stringify(await runReuseGuide(), null, 2));
}
