#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isMainModule } from "../src/main-module.mjs";

const execFileAsync = promisify(execFile);
const defaultProjectRoot = fileURLToPath(new URL("../", import.meta.url));
const schema = "foursday-hermes-install/v1";

export const hermesInstallSteps = Object.freeze([
  Object.freeze({
    id: "prepare-upstream",
    script: "scripts/准备Hermes候选.mjs",
    description: "取得锁定的 Hermes 上游并创建隔离 Python 环境",
  }),
  Object.freeze({
    id: "apply-patches",
    script: "scripts/准备Hermes补丁层.mjs",
    description: "在独立副本应用并验证锁定的最小补丁",
  }),
  Object.freeze({
    id: "install-distribution",
    script: "scripts/安装Hermes发行层.mjs",
    description: "安装 DWS、项目路由、边界插件、Profile 与 Skill",
  }),
]);

function supportedNodeVersion(value) {
  const match = String(value ?? "").match(/^v?(\d+)\.(\d+)\./u);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 5);
}

async function executable(path, accessImpl = access) {
  try {
    await accessImpl(path);
    return true;
  } catch {
    return false;
  }
}

export async function inspectHermesInstallPrerequisites({
  platform = process.platform,
  nodeVersion = process.version,
  accessImpl = access,
} = {}) {
  const uvCandidates = ["/opt/homebrew/bin/uv", "/usr/local/bin/uv"];
  const uvPath = (await Promise.all(uvCandidates.map(async (path) => ({
    path,
    available: await executable(path, accessImpl),
  })))).find(({ available }) => available)?.path ?? null;
  const gitAvailable = await executable("/usr/bin/git", accessImpl);
  const requirements = Object.freeze({
    macOS: platform === "darwin",
    node: supportedNodeVersion(nodeVersion),
    git: gitAvailable,
    uv: Boolean(uvPath),
  });
  return Object.freeze({
    ready: Object.values(requirements).every(Boolean),
    requirements,
    uvPath,
    missing: Object.entries(requirements)
      .filter(([, available]) => !available)
      .map(([name]) => name),
  });
}

function installerEnvironment(source = process.env) {
  const allowed = [
    "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
    "https_proxy", "http_proxy", "all_proxy", "no_proxy",
  ];
  return {
    ...Object.fromEntries(allowed.flatMap((name) =>
      typeof source[name] === "string" ? [[name, source[name]]] : []
    )),
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    CI: "1",
    NO_COLOR: "1",
  };
}

async function defaultStepRunner({ projectRoot, step }) {
  const scriptPath = join(projectRoot, step.script);
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [scriptPath, "--apply"], {
      cwd: projectRoot,
      env: installerEnvironment(),
      timeout: 30 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    const exit = Number.isInteger(error?.code) ? error.code : "unknown";
    throw new Error(`Hermes install step ${step.id} failed (exit ${exit})`);
  }
  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Hermes install step ${step.id} returned invalid output`);
  }
  if (result?.valid !== true || result?.productionWrite !== false) {
    throw new Error(`Hermes install step ${step.id} did not prove a safe result`);
  }
  return result;
}

export async function runHermesOneClickInstall({
  apply = false,
  projectRoot = defaultProjectRoot,
  prerequisiteInspector = inspectHermesInstallPrerequisites,
  stepRunner = defaultStepRunner,
} = {}) {
  if (!isAbsolute(projectRoot)) throw new Error("projectRoot must be absolute");
  const prerequisites = await prerequisiteInspector();
  const plan = {
    schema,
    apply,
    ready: prerequisites.ready,
    prerequisites,
    projectRoot,
    runtimeDirectory: join(projectRoot, ".runtime", "hermes-poc"),
    steps: hermesInstallSteps.map(({ id, description }) => ({ id, description })),
    productionWrite: false,
    gatewayStarted: false,
    messagesSent: 0,
  };
  if (!apply) {
    return {
      ...plan,
      installed: false,
      next: prerequisites.ready
        ? "Repeat with --apply to install the complete local Hermes distribution"
        : `Install missing prerequisites: ${prerequisites.missing.join(", ")}`,
    };
  }
  if (!prerequisites.ready) {
    throw new Error(`Hermes install prerequisites are missing: ${prerequisites.missing.join(", ")}`);
  }
  const completed = [];
  for (const step of hermesInstallSteps) {
    const result = await stepRunner({ projectRoot, step });
    completed.push({ id: step.id, valid: true, summary: {
      release: result.release ?? null,
      version: result.version ?? null,
      patchCount: result.patchCount ?? null,
      installedComponents: result.installed ?? null,
    } });
  }
  return {
    ...plan,
    installed: true,
    completed,
    next: [
      "Authenticate Codex for model access",
      "Configure a message adapter and personal gbrain access",
      "Start with a send-disabled Hermes shadow before enabling active mode",
    ],
  };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--apply")) {
    throw new Error("Usage: 一键安装Hermes.mjs [--apply]");
  }
  console.log(JSON.stringify(await runHermesOneClickInstall({
    apply: args.includes("--apply"),
  }), null, 2));
}
