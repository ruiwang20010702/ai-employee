#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isMainModule } from "../src/main-module.mjs";

const repository = "ruiwang20010702/foursday";
const maximumWaitMs = 180_000;

export const publicInstallHelp = `Foursday public install verification

Usage:
  npm run public-install:verify -- --sha <40-character commit SHA>

This networked acceptance check installs the immutable public candidate with an
isolated HOME, empty Git/npm configuration, disabled SSH, no credential tokens,
and disabled lifecycle scripts. It starts only the loopback Web page, verifies
the public activation boundary, then removes its dedicated temporary workspace.
`;

function exactSha(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error("--sha must be a complete 40-character lowercase commit SHA");
  }
  return normalized;
}

export function publicInstallSha(args) {
  if (args.includes("--help")) return null;
  if (args.length !== 2 || args[0] !== "--sha") {
    throw new Error("Usage: npm run public-install:verify -- --sha <40-character commit SHA>");
  }
  return exactSha(args[1]);
}

export function publicInstallCommand({ npmCliPath, sourceSha }) {
  if (!isAbsolute(npmCliPath)) throw new Error("npm CLI path must be absolute");
  const sha = exactSha(sourceSha);
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([
      npmCliPath,
      "exec",
      "--yes",
      "--ignore-scripts",
      "--package",
      `github:${repository}#${sha}`,
      "--",
      "foursday",
      "start",
      "--pilot-sha",
      sha,
      "--port",
      "0",
    ]),
  });
}

export function publicInstallEnvironment({ workspace, source = process.env }) {
  if (!isAbsolute(workspace)) throw new Error("Public install workspace must be absolute");
  const allowed = ["LANG", "LC_ALL"];
  const environment = Object.fromEntries(
    allowed
      .filter((name) => typeof source[name] === "string" && source[name].length > 0)
      .map((name) => [name, source[name]]),
  );
  const nodeDirectory = dirname(process.execPath);
  return {
    ...environment,
    HOME: join(workspace, "home"),
    TMPDIR: join(workspace, "tmp"),
    PATH: process.platform === "win32"
      ? nodeDirectory
      : `${nodeDirectory}:/usr/bin:/bin:/usr/sbin:/sbin`,
    CI: "1",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...(process.platform === "win32" ? {} : { GIT_SSH_COMMAND: "/usr/bin/false" }),
    npm_config_cache: join(workspace, "npm-cache"),
    npm_config_userconfig: process.platform === "win32" ? "NUL" : "/dev/null",
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_ignore_scripts: "true",
  };
}

export function validatePublicActivationHtml(html) {
  const value = String(html ?? "");
  for (const required of [
    "Create your unique pilot task",
    "Copy privacy-safe readiness report",
    "Measured server-start-to-confirmed journey",
    "Package download time is not included",
  ]) {
    if (!value.includes(required)) {
      throw new Error("Public activation page is missing a required candidate boundary");
    }
  }
  return true;
}

function launchUrl(output) {
  const match = String(output).match(/"url"\s*:\s*"(http:\/\/127\.0\.0\.1:[0-9]+\/)"/u);
  if (!match || !/"externalSystemsTouched"\s*:\s*false/u.test(output)) {
    throw new Error("Public install did not report a zero-write loopback launch");
  }
  return match[1];
}

async function stopProcess(child) {
  if (child.exitCode !== null || !child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {}
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {}
}

async function launchPublicCandidate({ command, environment, workspace, fetchImpl }) {
  const child = spawn(command.executable, command.args, {
    cwd: workspace,
    env: environment,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-32_768); });
  child.stderr.on("data", () => {});
  try {
    const url = await new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        try {
          resolve(launchUrl(output));
          return;
        } catch {}
        if (child.exitCode !== null) {
          reject(new Error(`Public install exited before startup (${child.exitCode})`));
          return;
        }
        if (Date.now() - started >= maximumWaitMs) {
          reject(new Error("Public install did not start within the bounded wait"));
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Public activation page did not return HTTP success");
    validatePublicActivationHtml(await response.text());
    return {
      loopback: true,
      readinessSupportAvailable: true,
      externalSystemsTouched: false,
    };
  } finally {
    await stopProcess(child);
  }
}

async function trustedNpmCliPath(value) {
  if (!isAbsolute(value)) throw new Error("Run public install verification through npm");
  const resolved = await realpath(value);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error("npm CLI path must be a regular file");
  return resolved;
}

export async function verifyPublicInstall({
  sourceSha,
  npmCliPath = process.env.npm_execpath,
  fetchImpl = fetch,
  launch = launchPublicCandidate,
  temporaryRoot = tmpdir(),
} = {}) {
  const sha = exactSha(sourceSha);
  const npmCli = await trustedNpmCliPath(npmCliPath);
  const workspace = await mkdtemp(join(temporaryRoot, "foursday-public-install-"));
  try {
    await Promise.all([
      mkdir(join(workspace, "home"), { recursive: true, mode: 0o700 }),
      mkdir(join(workspace, "tmp"), { recursive: true, mode: 0o700 }),
    ]);
    const command = publicInstallCommand({ npmCliPath: npmCli, sourceSha: sha });
    const environment = publicInstallEnvironment({ workspace });
    const result = await launch({ command, environment, workspace, fetchImpl });
    if (
      result?.loopback !== true ||
      result.readinessSupportAvailable !== true ||
      result.externalSystemsTouched !== false
    ) {
      throw new Error("Public install launch result is invalid");
    }
    return {
      valid: true,
      schema: "foursday-public-install-verification/v1",
      repository,
      sourceSha: sha,
      isolatedHome: true,
      gitConfigurationDisabled: true,
      sshDisabled: process.platform !== "win32",
      credentialTokensForwarded: 0,
      lifecycleScriptsEnabled: false,
      loopbackWebPage: true,
      readinessSupportAvailable: true,
      externalSystemsTouched: false,
      productionWrite: false,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function runPublicInstallVerification({
  args = process.argv.slice(2),
  output = process.stdout,
} = {}) {
  const sourceSha = publicInstallSha(args);
  if (sourceSha === null) {
    output.write(publicInstallHelp);
    return null;
  }
  const result = await verifyPublicInstall({ sourceSha });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) await runPublicInstallVerification();
