#!/usr/bin/env node
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.mjs";
import {
  buildHermesGatewayEnvironment,
  hermesCheckpointCurrentlyHealthy,
  hermesCheckpointFresh,
  hermesGatewayPid,
  hermesGatewayOwnedByService,
  hermesGatewayLabel,
  hermesGatewayPlan,
  narrowHermesTargets,
  renderHermesGatewayLaunchAgent,
  validateHermesProjectRegistry,
  validateHermesProductionPaths,
} from "../src/hermes-production-service.mjs";
import { hermesRuntimeLayout } from "../src/hermes-upstream.mjs";
import { isMainModule } from "../src/main-module.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const domain = `gui/${process.getuid()}`;
const launchAgentsDirectory = join(homedir(), "Library", "LaunchAgents");
const destination = join(launchAgentsDirectory, `${hermesGatewayLabel}.plist`);

function requiredAbsolute(value, name) {
  const normalized = String(value ?? "").trim();
  if (!isAbsolute(normalized)) throw new Error(`${name} must be an absolute path`);
  return resolve(normalized);
}

async function exists(path) {
  return lstat(path).then(() => true).catch((error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function serviceNodePath(environment) {
  for (const candidate of [
    environment.FOURSDAY_HERMES_NODE_PATH,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    process.execPath,
  ]) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed candidate.
    }
  }
  throw new Error("A stable Node executable is required for Hermes launchd");
}

export async function createHermesServiceContext({
  environment = process.env,
  mode = "shadow",
  legacyServiceStates = {},
} = {}) {
  const configPath = requiredAbsolute(
    environment.AI_EMPLOYEE_CONFIG_FILE,
    "AI_EMPLOYEE_CONFIG_FILE",
  );
  await applyProductionConfigFile({ path: configPath, environment });
  const config = loadConfig({ production: true });
  const foursdayRoot = environment.FOURSDAY_HERMES_FOURSDAY_ROOT
    ? requiredAbsolute(
        environment.FOURSDAY_HERMES_FOURSDAY_ROOT,
        "FOURSDAY_HERMES_FOURSDAY_ROOT",
      )
    : projectRoot;
  const runtimeRoot = environment.FOURSDAY_HERMES_RUNTIME_ROOT
    ? requiredAbsolute(environment.FOURSDAY_HERMES_RUNTIME_ROOT, "FOURSDAY_HERMES_RUNTIME_ROOT")
    : hermesRuntimeLayout(projectRoot).root;
  const stateDirectory = join(runtimeRoot, "state");
  const registrySetting = mode === "active"
    ? environment.FOURSDAY_HERMES_ACTIVE_PROJECT_REGISTRY
    : environment.FOURSDAY_HERMES_PROJECT_REGISTRY;
  const paths = await validateHermesProductionPaths({
    runtimeRoot,
    projectRegistry: requiredAbsolute(
      registrySetting ?? join(
        stateDirectory,
        mode === "active" ? "projects.active.json" : "projects.production.json",
      ),
      mode === "active"
        ? "FOURSDAY_HERMES_ACTIVE_PROJECT_REGISTRY"
        : "FOURSDAY_HERMES_PROJECT_REGISTRY",
    ),
    fallbackWorkspace: requiredAbsolute(
      environment.FOURSDAY_HERMES_FALLBACK_WORKSPACE ?? projectRoot,
      "FOURSDAY_HERMES_FALLBACK_WORKSPACE",
    ),
    productionConfig: configPath,
    nodePath: await serviceNodePath(environment),
    dwsPath: config.dwsPath,
    dwsSidecar: join(foursdayRoot, "src", "hermes-dws-sidecar.mjs"),
    memorySidecar: join(foursdayRoot, "src", "hermes-personal-memory-context.mjs"),
    gatewayLauncher: join(foursdayRoot, "src", "hermes-gateway-launcher.mjs"),
  });
  const gatewayEnvironment = buildHermesGatewayEnvironment({
    mode,
    paths,
    config: {
      ...config,
      targetUserIds: mode === "shadow"
        ? narrowHermesTargets(
            config.targetUserIds,
            environment.FOURSDAY_HERMES_SHADOW_USERS,
            "FOURSDAY_HERMES_SHADOW_USERS",
          )
        : config.targetUserIds,
      targetGroupIds: mode === "shadow"
        ? narrowHermesTargets(
            config.targetGroupIds,
            environment.FOURSDAY_HERMES_SHADOW_GROUPS,
            "FOURSDAY_HERMES_SHADOW_GROUPS",
          )
        : config.targetGroupIds,
      initialLookbackMs: environment.FOURSDAY_HERMES_INITIAL_LOOKBACK_MS == null
        ? Math.max(config.overlapMs ?? 0, 10 * 60 * 1_000)
        : Number(environment.FOURSDAY_HERMES_INITIAL_LOOKBACK_MS),
    },
    baseEnvironment: environment,
    legacyServiceStates,
  });
  const registry = await validateHermesProjectRegistry({
    projectRegistry: paths.projectRegistry,
    fallbackWorkspace: paths.fallbackWorkspace,
    mode,
  });
  const serviceDirectory = join(paths.hermesHome, "plugin-data", "foursday-production");
  const logsDirectory = join(paths.hermesHome, "logs", "foursday-production");
  const generatedPlist = join(serviceDirectory, `${hermesGatewayLabel}.plist`);
  const stdoutPath = join(logsDirectory, "gateway.log");
  const stderrPath = join(logsDirectory, "gateway.error.log");
  return {
    config,
    mode,
    configPath,
    paths,
    gatewayEnvironment,
    registry,
    serviceDirectory,
    logsDirectory,
    generatedPlist,
    stdoutPath,
    stderrPath,
  };
}

async function generate(context) {
  await mkdir(context.serviceDirectory, { recursive: true, mode: 0o700 });
  await mkdir(context.logsDirectory, { recursive: true, mode: 0o700 });
  await chmod(context.serviceDirectory, 0o700);
  await chmod(context.logsDirectory, 0o700);
  for (const path of [context.stdoutPath, context.stderrPath]) {
    if (!await exists(path)) await writeFile(path, "", { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
  }
  await writeFile(
    context.generatedPlist,
    renderHermesGatewayLaunchAgent({
      paths: context.paths,
      environment: context.gatewayEnvironment,
      stdoutPath: context.stdoutPath,
      stderrPath: context.stderrPath,
    }),
    { mode: 0o600 },
  );
  await chmod(context.generatedPlist, 0o600);
  return context.generatedPlist;
}

async function launchctl(args) {
  return execFileAsync("/bin/launchctl", args, {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

async function loaded() {
  return launchctlState().then((value) => value.loaded);
}

async function launchctlState() {
  try {
    const { stdout } = await launchctl(["print", `${domain}/${hermesGatewayLabel}`]);
    const pid = Number(stdout.match(/^\s*pid = (\d+)\s*$/mu)?.[1]);
    return {
      loaded: true,
      pid: Number.isSafeInteger(pid) && pid > 1 ? pid : null,
    };
  } catch {
    return { loaded: false, pid: null };
  }
}

async function parentPid(pid) {
  try {
    const { stdout } = await execFileAsync("/bin/ps", [
      "-o",
      "ppid=",
      "-p",
      String(pid),
    ], { timeout: 5_000, maxBuffer: 1024 });
    const parsed = Number(stdout.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function gatewayProcess(context) {
  const record = await readFile(
    join(context.paths.hermesHome, "gateway.pid"),
    "utf8",
  ).then((value) => JSON.parse(value)).catch(() => null);
  const pid = hermesGatewayPid(record, context.paths.hermesHome);
  if (!pid) return { pid: null, alive: false };
  try {
    process.kill(pid, 0);
    return { pid, alive: true };
  } catch {
    return { pid, alive: false };
  }
}

async function waitForGatewayStopped(context, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [service, gateway] = await Promise.all([
      launchctlState(),
      gatewayProcess(context),
    ]);
    if (!service.loaded && !gateway.alive) return { stopped: true };
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error("Hermes Gateway did not stop completely");
}

async function waitForGateway(context, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  const pidPath = join(context.paths.hermesHome, "gateway.pid");
  const checkpointPath = context.gatewayEnvironment.DWS_PERSONAL_STATE_FILE;
  while (Date.now() < deadline) {
    const service = await launchctlState();
    if (service.loaded && service.pid) {
      const pidRecord = await readFile(pidPath, "utf8")
        .then((value) => JSON.parse(value))
        .catch(() => null);
      const pid = hermesGatewayPid(pidRecord, context.paths.hermesHome);
      if (Number.isSafeInteger(pid) && pid > 1) {
        try {
          process.kill(pid, 0);
          const ownerPid = await parentPid(pid);
          if (!hermesGatewayOwnedByService({
            gatewayPid: pid,
            servicePid: service.pid,
            parentPid: ownerPid,
          })) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
            continue;
          }
          const checkpoint = await stat(checkpointPath).catch(() => null);
          const checkpointState = await readFile(checkpointPath, "utf8")
            .then((value) => JSON.parse(value))
            .catch(() => null);
          if (hermesCheckpointFresh({
            metadata: checkpoint,
            state: checkpointState,
            startedAt,
          })) {
            return { running: true, pid, dwsCheckpointFresh: true };
          }
        } catch {
          // Retry until the external supervisor settles.
        }
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error("Hermes Gateway did not become healthy under launchd");
}

export async function installHermesGateway(context) {
  const generated = await generate(context);
  await mkdir(launchAgentsDirectory, { recursive: true });
  const hadPrevious = await exists(destination);
  const backupDirectory = join(
    context.serviceDirectory,
    "launchd-backups",
    new Date().toISOString().replaceAll(/[:.]/gu, "-"),
  );
  const backup = join(backupDirectory, `${hermesGatewayLabel}.plist`);
  if (hadPrevious) {
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    await chmod(backupDirectory, 0o700);
    await copyFile(destination, backup);
    await chmod(backup, 0o600);
  }
  try {
    await launchctl(["bootout", domain, destination]).catch(() => {});
    await waitForGatewayStopped(context);
    await copyFile(generated, destination);
    await chmod(destination, 0o600);
    await launchctl(["bootstrap", domain, destination]);
    const health = await waitForGateway(context);
    return {
      installed: true,
      mode: context.mode,
      backupCreated: hadPrevious,
      ...health,
    };
  } catch (error) {
    await launchctl(["bootout", domain, destination]).catch(() => {});
    await waitForGatewayStopped(context);
    if (hadPrevious) {
      await copyFile(backup, destination);
      await chmod(destination, 0o600);
      await launchctl(["bootstrap", domain, destination]).catch(() => {});
    } else {
      await unlink(destination).catch(() => {});
    }
    throw error;
  }
}

export async function hermesGatewayStatus(context) {
  const service = await launchctlState();
  const checkpoint = context.gatewayEnvironment.DWS_PERSONAL_STATE_FILE;
  const checkpointMetadata = await stat(checkpoint).catch(() => null);
  const checkpointState = await readFile(checkpoint, "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => null);
  const installedPlist = await readFile(destination, "utf8").catch(() => "");
  const modeMatch = installedPlist.match(
    /<key>FOURSDAY_HERMES_MODE<\/key>\s*<string>([^<]+)<\/string>/u,
  );
  const sendMatch = installedPlist.match(
    /<key>DWS_PERSONAL_SEND_ENABLED<\/key>\s*<string>(true|false)<\/string>/u,
  );
  const pidRecord = await readFile(join(context.paths.hermesHome, "gateway.pid"), "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => null);
  const gatewayPid = hermesGatewayPid(pidRecord, context.paths.hermesHome);
  const ownerPid = gatewayPid ? await parentPid(gatewayPid) : null;
  const fallbackMs = Number(
    context.gatewayEnvironment.DWS_PERSONAL_FALLBACK_MS ?? 300_000,
  );
  return {
    schema: "foursday-hermes-gateway-status/v1",
    label: hermesGatewayLabel,
    mode: modeMatch?.[1] ?? "unknown",
    running: hermesGatewayOwnedByService({
      gatewayPid,
      servicePid: service.pid,
      parentPid: ownerPid,
    }),
    sendEnabled: sendMatch ? sendMatch[1] === "true" : null,
    checkpointPresent: Boolean(checkpointMetadata),
    checkpointHealthy: hermesCheckpointCurrentlyHealthy({
      metadata: checkpointMetadata,
      state: checkpointState,
      maxAgeMs: Math.max(60_000, fallbackMs * 2),
    }),
    checkpointAgeMs: checkpointMetadata ? Date.now() - checkpointMetadata.mtimeMs : null,
    productionWrite: false,
  };
}

export async function uninstallHermesGateway(context) {
  await launchctl(["bootout", domain, destination]).catch(() => {});
  await waitForGatewayStopped(context);
  await unlink(destination).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return { uninstalled: true, label: hermesGatewayLabel };
}

export async function runHermesServiceCommand({
  command = "plan",
  apply = false,
  environment = process.env,
} = {}) {
  const context = await createHermesServiceContext({ environment });
  if (command === "plan") {
    return hermesGatewayPlan({
      mode: "shadow",
      paths: context.paths,
      environment: context.gatewayEnvironment,
    });
  }
  if (command === "status") return hermesGatewayStatus(context);
  if (command === "install-shadow") {
    if (!apply) return {
      ...hermesGatewayPlan({
        mode: "shadow",
        paths: context.paths,
        environment: context.gatewayEnvironment,
      }),
      applyRequired: true,
    };
    return installHermesGateway(context);
  }
  if (command === "uninstall") {
    if (!apply) return { uninstalled: false, applyRequired: true, label: hermesGatewayLabel };
    return uninstallHermesGateway(context);
  }
  if (command === "activate") {
    throw new Error("Hermes active mode is unavailable until the single-writer cutover receipt is implemented");
  }
  throw new Error("Usage: 管理Hermes常驻服务.mjs plan|status|install-shadow|activate|uninstall [--apply]");
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const command = args.find((value) => value !== "--apply") ?? "plan";
  const unknown = args.filter((value) => value !== "--apply" && value !== command);
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  console.log(JSON.stringify(await runHermesServiceCommand({
    command,
    apply: args.includes("--apply"),
  }), null, 2));
}
