#!/usr/bin/env node
import { resolve } from "node:path";
import { initializeProductionConfig } from "./初始化生产配置.mjs";
import { provisionGeneratedKeychainSecrets } from "./初始化钥匙串密钥.mjs";
import { inspectReuseReadiness } from "../src/reuse-readiness.mjs";
import { isMainModule } from "../src/main-module.mjs";

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function reuseConfigPath(args = process.argv.slice(2), cwd = process.cwd()) {
  const input = argumentValue(args, "--config") ??
    process.env.AI_EMPLOYEE_CONFIG_FILE ??
    ".runtime/production.json";
  return resolve(cwd, input);
}

export async function runReuseGuide({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  keychainProvisioner = provisionGeneratedKeychainSecrets,
} = {}) {
  const command = args[0] ?? "check";
  const configPath = reuseConfigPath(args, cwd);
  if (command === "init") {
    const initialized = await initializeProductionConfig({ outputPath: configPath });
    return {
      command,
      ...initialized,
      next: "先运行 ai-employee secrets --apply，再填写 requiredEdits 并运行 ai-employee check",
    };
  }
  if (command === "secrets") {
    return keychainProvisioner({
      configPath,
      apply: args.includes("--apply"),
    });
  }
  if (command === "check") {
    return inspectReuseReadiness({ configPath });
  }
  if (["help", "--help", "-h"].includes(command)) {
    return {
      usage: [
        "ai-employee check [--config /absolute/path.json]",
        "ai-employee init [--config /absolute/path.json]",
        "ai-employee secrets [--apply] [--config /absolute/path.json]",
      ],
      boundary: "check 只读取本机文件与可执行程序，不连接钉钉、Codex 或数据库；init 只创建钥匙串引用且不覆盖生产配置；secrets 仅在显式 --apply 时写入四项独立钥匙串密钥。",
    };
  }
  throw new Error("Usage: ai-employee check|init|secrets [--apply] [--config /absolute/path.json]");
}

if (isMainModule(import.meta.url)) {
  console.log(JSON.stringify(await runReuseGuide(), null, 2));
}
