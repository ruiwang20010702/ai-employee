import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  inspectFoursdayNativeGateway,
  legacyFoursdayGatewayLabel,
} from "./foursday-native-gateway.mjs";
import { foursdayNativeHermesLayout } from "./foursday-hermes-native-install.mjs";
import { evaluateHealth } from "./health-check.mjs";

const execFileAsync = promisify(execFile);
const defaultProjectRoot = fileURLToPath(new URL("../", import.meta.url));

function plistString(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return content.match(new RegExp(
    `<key>${escaped}<\\/key>\\s*<string>([^<]+)<\\/string>`,
    "u",
  ))?.[1] ?? null;
}

async function privateFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Foursday runtime status file is unsafe");
  }
  return metadata;
}

export async function inspectManagedFoursdayGateway({
  userHome = homedir(),
  uid = process.getuid?.(),
  now = Date.now(),
  run = execFileAsync,
} = {}) {
  const plistPath = join(userHome, "Library", "LaunchAgents", `${legacyFoursdayGatewayLabel}.plist`);
  try {
    await privateFile(plistPath);
  } catch {
    return {
      runtime: "foursday_managed_hermes",
      label: legacyFoursdayGatewayLabel,
      installed: false,
      running: false,
      ready: false,
    };
  }
  const plist = await readFile(plistPath, "utf8");
  const mode = plistString(plist, "FOURSDAY_HERMES_MODE") ?? "unknown";
  const sendEnabled = plistString(plist, "DWS_PERSONAL_SEND_ENABLED") === "true";
  const checkpoint = plistString(plist, "DWS_PERSONAL_STATE_FILE");
  const fallbackMs = Number(plistString(plist, "DWS_PERSONAL_FALLBACK_MS") ?? 300_000);
  let running = false;
  let serviceEnabled = null;
  try {
    const { stdout } = await run("/bin/launchctl", [
      "print", `gui/${uid}/${legacyFoursdayGatewayLabel}`,
    ], { timeout: 10_000, maxBuffer: 512 * 1024 });
    running = /state\s*=\s*running/u.test(String(stdout));
  } catch {
    running = false;
  }
  try {
    const { stdout } = await run("/bin/launchctl", [
      "print-disabled", `gui/${uid}`,
    ], { timeout: 10_000, maxBuffer: 512 * 1024 });
    const escaped = legacyFoursdayGatewayLabel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    serviceEnabled = !new RegExp(`"${escaped}"\\s*=>\\s*disabled`, "u")
      .test(String(stdout));
  } catch {
    serviceEnabled = null;
  }
  let checkpointHealthy = false;
  if (checkpoint) {
    try {
      const metadata = await privateFile(checkpoint);
      const state = JSON.parse(await readFile(checkpoint, "utf8"));
      const fullSuccess = new Date(state.lastFullSuccessAt ?? "").getTime();
      const maxAge = Math.max(60_000, fallbackMs * 2);
      checkpointHealthy =
        Number.isFinite(fullSuccess) &&
        now - fullSuccess >= 0 && now - fullSuccess <= maxAge &&
        now - metadata.mtimeMs >= 0 && now - metadata.mtimeMs <= maxAge &&
        state.lastErrorCount === 0;
    } catch {
      checkpointHealthy = false;
    }
  }
  const modeConsistent =
    (mode === "active" && sendEnabled) ||
    (mode === "shadow" && !sendEnabled);
  const safeStopped = !running && serviceEnabled === false && mode === "shadow" && !sendEnabled;
  return {
    schema: "foursday-managed-gateway-status/v1",
    runtime: "foursday_managed_hermes",
    label: legacyFoursdayGatewayLabel,
    installed: true,
    mode,
    sendEnabled,
    running,
    serviceEnabled,
    checkpointHealthy,
    modeConsistent,
    safeStopped,
    ready: running && checkpointHealthy && modeConsistent,
  };
}

export async function inspectFoursdayRuntimeStatus({
  projectRoot = defaultProjectRoot,
  userHome = homedir(),
  inspectNative = inspectFoursdayNativeGateway,
  inspectManaged = inspectManagedFoursdayGateway,
} = {}) {
  const layout = foursdayNativeHermesLayout({ userHome, projectRoot });
  const [native, managed] = await Promise.all([
    inspectNative({ layout }).catch(() => ({
      runtime: "native_hermes_profile",
      label: "ai.hermes.gateway-foursday",
      installed: false,
      running: false,
      ready: false,
    })),
    inspectManaged({ userHome }),
  ]);
  const nativeActive = native.ready && native.mode === "active" && native.sendEnabled;
  const managedActive = managed.ready && managed.mode === "active" && managed.sendEnabled;
  const splitBrain = nativeActive && managedActive;
  const intentionallyStopped = native.safeStopped === true && managed.safeStopped === true;
  const current = splitBrain ? null : nativeActive ? native : managedActive ? managed :
    native.ready ? native : managed.ready ? managed : null;
  return {
    schema: "foursday-runtime-status/v1",
    ready: Boolean(current) && !splitBrain,
    splitBrain,
    intentionallyStopped,
    current,
    native,
    managed,
  };
}

export async function evaluateFoursdayHealth({
  store,
  config,
  now = new Date(),
  runtimeStatusProvider = inspectFoursdayRuntimeStatus,
  projectRoot,
  includeOperationalMetrics = false,
} = {}) {
  const [legacy, runtime] = await Promise.all([
    evaluateHealth({ store, config, now, includeOperationalMetrics }),
    runtimeStatusProvider({ projectRoot }),
  ]);
  if (!runtime.current) {
    return {
      ...legacy,
      checks: { ...legacy.checks, runtime },
      runtime,
    };
  }
  const checks = {
    ...legacy.checks,
    runtime,
    deadTasks: 0,
    unknownSends: 0,
    failedWorkPlans: 0,
    executingWorkPlans: 0,
    expiredExecutionLeases: 0,
    heartbeats: {},
    operationalChecks: {},
    messageCoverage: { ...legacy.checks.messageCoverage, required: false },
  };
  const ready =
    Boolean(checks.database) &&
    Boolean(checks.dwsExecutable) &&
    Boolean(checks.codexExecutable) &&
    !checks.paused &&
    Number(checks.pendingMemoryRetirements ?? 0) === 0 &&
    Number(checks.blockedMemoryCandidates ?? 0) === 0 &&
    runtime.ready;
  return {
    ready,
    checks,
    state: legacy.state,
    runtime,
    compatibility: {
      tasks: legacy.state.tasks,
      workPlans: legacy.state.workPlans,
    },
  };
}
