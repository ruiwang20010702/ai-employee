import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createStructuredArtifactRuntime } from "../src/artifact-runtime.mjs";
import { isMainModule } from "../src/main-module.mjs";
import {
  confirmProjectRecipeShadowReview,
  previewProjectRecipeShadow,
  runProjectRecipeShadow,
} from "../src/project-recipe-shadow.mjs";

const help = `项目配方影子验证

默认只生成无写入预览：
  npm run projects:shadow -- --bundle /absolute/import.json --recipe project-follow-up --values /absolute/values.json

显式运行本地只读模型并写入隔离证据包：
  npm run projects:shadow -- --bundle /absolute/import.json --recipe project-follow-up --values /absolute/values.json --output /absolute/new-directory --runtime codex --run

本人审阅交付物后，只在隔离证据账本确认实际耗时：
  npm run projects:shadow -- --review /absolute/evidence-directory --evidence-sha256 64_HEX --human-minutes 10 --confirm REVIEW-FIRST12

该命令不读取生产配置、不连接生产数据库、不发送消息、不修改仓库。影子运行不写记忆或时间返还；审阅确认只更新隔离证据账本，不写生产时间返还。`;

function parseArguments(args) {
  if (args.some((value) => ["--help", "-h"].includes(value))) {
    return { help: true };
  }
  const known = new Set([
    "--bundle",
    "--recipe",
    "--values",
    "--output",
    "--runtime",
    "--run",
    "--review",
    "--evidence-sha256",
    "--human-minutes",
    "--confirm",
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!known.has(name)) throw new Error(`Unknown option: ${name}`);
    if (name === "--run") {
      if (options.run) throw new Error("--run can only be supplied once");
      options.run = true;
      continue;
    }
    if (Object.hasOwn(options, name)) throw new Error(`${name} can only be supplied once`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    options[name] = value;
    index += 1;
  }
  if (options["--review"]) {
    for (const name of ["--bundle", "--recipe", "--values", "--output", "--runtime", "--run"]) {
      if (options[name]) throw new Error(`${name} cannot be combined with --review`);
    }
    for (const name of ["--evidence-sha256", "--human-minutes", "--confirm"]) {
      if (!options[name]) throw new Error(`${name} is required with --review`);
    }
    const humanActiveMinutes = Number(options["--human-minutes"]);
    if (!Number.isSafeInteger(humanActiveMinutes) || humanActiveMinutes < 0 || humanActiveMinutes > 10_080) {
      throw new Error("--human-minutes must be an integer between 0 and 10080");
    }
    return {
      help: false,
      mode: "review",
      evidenceDirectory: options["--review"],
      evidenceSha256: options["--evidence-sha256"],
      humanActiveMinutes,
      confirmation: options["--confirm"],
    };
  }
  for (const name of ["--evidence-sha256", "--human-minutes", "--confirm"]) {
    if (options[name]) throw new Error(`${name} requires --review`);
  }
  const runtime = options["--runtime"] ?? "codex";
  if (!["codex", "claude-code"].includes(runtime)) {
    throw new Error("--runtime must be codex or claude-code");
  }
  for (const name of ["--bundle", "--recipe", "--values"]) {
    if (!options[name]) throw new Error(`${name} is required`);
  }
  if (options.run && !options["--output"]) {
    throw new Error("--output is required with --run");
  }
  if (!options.run && options["--output"]) {
    throw new Error("--output is only accepted with --run");
  }
  return {
    help: false,
    mode: options.run ? "run" : "preview",
    run: options.run === true,
    bundlePath: options["--bundle"],
    recipeId: options["--recipe"],
    valuesPath: options["--values"],
    outputDirectory: options["--output"] ?? null,
    runtime,
  };
}

async function readProtectedJson(path, name, maximumBytes = 1024 * 1024) {
  if (!isAbsolute(path)) throw new Error(`${name} must use an absolute path`);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new Error(`${name} must be a regular JSON file up to ${maximumBytes} bytes`);
  }
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${name} must not traverse a symbolic link`);
  const content = await readFile(canonical);
  const finalMetadata = await lstat(path);
  if (
    !finalMetadata.isFile() ||
    finalMetadata.isSymbolicLink() ||
    finalMetadata.dev !== metadata.dev ||
    finalMetadata.ino !== metadata.ino ||
    finalMetadata.size !== metadata.size ||
    finalMetadata.mtimeMs !== metadata.mtimeMs ||
    finalMetadata.ctimeMs !== metadata.ctimeMs
  ) {
    throw new Error(`${name} changed while it was being read`);
  }
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

export async function runProjectRecipeShadowCli(args = process.argv.slice(2), {
  output = process.stdout,
  previewer = previewProjectRecipeShadow,
  runner = runProjectRecipeShadow,
  reviewer = confirmProjectRecipeShadowReview,
  runtimeFactory = createStructuredArtifactRuntime,
} = {}) {
  const options = parseArguments(args);
  if (options.help) {
    output.write(`${help}\n`);
    return { help: true };
  }
  if (options.mode === "review") {
    const result = await reviewer({
      evidenceDirectory: options.evidenceDirectory,
      evidenceSha256: options.evidenceSha256,
      humanActiveMinutes: options.humanActiveMinutes,
      confirmation: options.confirmation,
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const [bundle, values] = await Promise.all([
    readProtectedJson(options.bundlePath, "--bundle"),
    readProtectedJson(options.valuesPath, "--values", 256 * 1024),
  ]);
  const recipesDirectory = new URL("../deploy/recipes/", import.meta.url);
  if (!options.run) {
    const preview = await previewer({
      bundle,
      recipeId: options.recipeId,
      values,
      recipesDirectory,
    });
    const {
      assessment: _assessment,
      manifest: _manifest,
      recipeDefinition: _recipeDefinition,
      ...publicPreview
    } = preview;
    output.write(`${JSON.stringify(publicPreview, null, 2)}\n`);
    return publicPreview;
  }
  const artifactRuntime = runtimeFactory({
    runtime: options.runtime,
    codexPath: process.env.CODEX_PATH ?? "codex",
    claudeCodePath: process.env.CLAUDE_CODE_PATH ?? "claude",
  });
  const result = await runner({
    bundle,
    recipeId: options.recipeId,
    values,
    recipesDirectory,
    outputDirectory: options.outputDirectory,
    artifactRuntime,
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) {
  runProjectRecipeShadowCli().catch((error) => {
    console.error(JSON.stringify({
      completed: false,
      error: error.message,
      productionDatabaseConnected: false,
      externalBusinessSystemsTouched: false,
    }, null, 2));
    process.exitCode = 1;
  });
}
