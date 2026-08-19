#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.mjs";
import {
  assertHermesShadowReady,
  assertHermesShadowAcceptance,
  assertLegacyCutoverReady,
  executeHermesCutover,
  hermesCutoverConfirmation,
} from "../src/hermes-cutover.mjs";
import { evaluateHealth } from "../src/health-check.mjs";
import { isMainModule } from "../src/main-module.mjs";
import { verifyHermesReleaseIdentity } from "../src/hermes-release-identity.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { createProductionStore } from "../src/production-store.mjs";
import {
  serviceDefinitions,
  stopLaunchAgentsForMaintenance,
} from "./管理常驻服务.mjs";
import {
  createHermesServiceContext,
  hermesGatewayStatus,
  installHermesGateway,
  uninstallHermesGateway,
} from "./管理Hermes常驻服务.mjs";

const execFileAsync = promisify(execFile);
const fullSha = /^[a-f0-9]{40}$/u;
const writerComponents = new Set(["listener", "worker", "executor", "proactive"]);
const writerDefinitions = serviceDefinitions.filter(
  ({ component }) => writerComponents.has(component),
);
const domain = `gui/${process.getuid()}`;
const launchAgentsDirectory = join(homedir(), "Library", "LaunchAgents");

function argument(args, name, { required = true } = {}) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (required && !value) throw new Error(`${name} is required`);
  return value;
}

function absolute(value, name) {
  if (!isAbsolute(String(value ?? ""))) throw new Error(`${name} must be absolute`);
  return resolve(value);
}

async function privateJson(path, name) {
  const lexical = absolute(path, name);
  const metadata = await lstat(lexical);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${name} must be a private regular file`);
  }
  return JSON.parse(await readFile(lexical, "utf8"));
}

async function launchctl(args) {
  return execFileAsync("/bin/launchctl", args, {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

async function labelLoaded(label) {
  return launchctl(["print", `${domain}/${label}`])
    .then(() => true)
    .catch(() => false);
}

async function snapshotLegacyWriters() {
  const services = [];
  for (const definition of writerDefinitions) {
    const path = join(launchAgentsDirectory, `${definition.label}.plist`);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new Error(`Legacy writer plist is not protected: ${definition.label}`);
    }
    const content = await readFile(path);
    services.push({
      component: definition.component,
      label: definition.label,
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  return services;
}

async function stopLegacyWriters() {
  const services = await snapshotLegacyWriters();
  const stopped = await stopLaunchAgentsForMaintenance({
    serviceDefinitions: writerDefinitions,
  });
  return {
    services,
    states: Object.fromEntries(writerDefinitions.map(
      ({ component, label }) => [
        component,
        stopped.failedLabels.includes(label) ? "running" : "stopped",
      ],
    )),
  };
}

async function restoreLegacyWriters({ legacySnapshot }) {
  for (const service of legacySnapshot.services) {
    const content = await readFile(service.path);
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== service.sha256) {
      throw new Error(`Legacy writer plist changed during cutover: ${service.label}`);
    }
    await launchctl(["bootout", domain, service.path]).catch(() => {});
    await launchctl(["bootstrap", domain, service.path]);
    await launchctl(["print", `${domain}/${service.label}`]);
  }
}

async function waitForLegacyHealth({ store, config, timeoutMs = 90_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const labelsReady = (await Promise.all(
      writerDefinitions.map(({ label }) => labelLoaded(label)),
    )).every(Boolean);
    if (labelsReady) {
      const health = await evaluateHealth({ store, config });
      if (health.ready) return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  return false;
}

async function writeReceipt(path, value) {
  const target = absolute(path, "Hermes cutover receipt");
  const parent = dirname(target);
  const parentMetadata = await lstat(parent);
  if (
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    (parentMetadata.mode & 0o077) !== 0 ||
    await realpath(parent) !== parent
  ) {
    throw new Error("Hermes cutover receipt parent must be a directory");
  }
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
  return { path: target, sha256: createHash("sha256").update(
    await readFile(target),
  ).digest("hex") };
}

export async function runHermesCutoverCommand({
  args = process.argv.slice(2),
  environment = process.env,
} = {}) {
  const command = args[0] ?? "plan";
  if (!new Set(["plan", "activate", "rollback"]).has(command)) {
    throw new Error("Usage: 切换Hermes生产运行时.mjs plan|activate|rollback [options]");
  }
  if (command === "rollback") {
    const receiptPath = absolute(argument(args, "--receipt"), "--receipt");
    const receiptBytes = await readFile(receiptPath);
    const receipt = await privateJson(receiptPath, "Hermes active cutover receipt");
    if (
      receipt.schema !== "foursday-hermes-cutover-receipt/v1" ||
      !fullSha.test(String(receipt.releaseSha ?? "")) ||
      !Array.isArray(receipt.legacyWriters) ||
      receipt.legacyWriters.length !== writerDefinitions.length
    ) throw new Error("Hermes active cutover receipt is invalid");
    for (const definition of writerDefinitions) {
      const matches = receipt.legacyWriters.filter((item) =>
        item?.component === definition.component &&
        item?.label === definition.label &&
        /^[a-f0-9]{64}$/u.test(String(item?.sha256 ?? ""))
      );
      if (matches.length !== 1) {
        throw new Error("Hermes active cutover receipt has invalid legacy writers");
      }
    }
    const receiptDigest = createHash("sha256").update(receiptBytes).digest("hex");
    const confirmation = `ROLLBACK-HERMES:${receipt.releaseSha}:${receiptDigest.slice(0, 16)}`;
    const plan = {
      schema: "foursday-hermes-rollback-plan/v1",
      releaseSha: receipt.releaseSha,
      stopOrder: ["hermes-active"],
      restoreOrder: writerDefinitions.map(({ component }) => component),
      finalMode: "legacy-sender-plus-hermes-shadow",
      confirmation,
      applyRequired: true,
      executed: false,
    };
    if (!args.includes("--apply")) return plan;
    if (argument(args, "--confirm") !== confirmation) {
      throw new Error("Hermes rollback confirmation does not match current receipt");
    }
    const configPath = absolute(
      environment.AI_EMPLOYEE_CONFIG_FILE,
      "AI_EMPLOYEE_CONFIG_FILE",
    );
    await applyProductionConfigFile({ path: configPath, environment });
    const config = loadConfig({ production: true });
    const store = await createProductionStore(config);
    const legacySnapshot = {
      services: receipt.legacyWriters.map(({ component, label, sha256 }) => ({
        component,
        label,
        sha256,
        path: join(launchAgentsDirectory, `${label}.plist`),
      })),
    };
    try {
      const activeContext = await createHermesServiceContext({
        environment,
        mode: "active",
        legacyServiceStates: Object.fromEntries(writerDefinitions.map(
          ({ component }) => [component, "stopped"],
        )),
      });
      await uninstallHermesGateway(activeContext);
      await restoreLegacyWriters({ legacySnapshot });
      if (!await waitForLegacyHealth({ store, config })) {
        throw new Error("Legacy runtime did not recover after Hermes rollback");
      }
      const shadowContext = await createHermesServiceContext({
        environment,
        mode: "shadow",
      });
      await installHermesGateway(shadowContext);
      const shadow = await hermesGatewayStatus(shadowContext);
      if (
        !shadow.running ||
        shadow.mode !== "shadow" ||
        shadow.sendEnabled !== false ||
        !shadow.checkpointHealthy
      ) throw new Error("Hermes shadow did not recover after legacy rollback");
      const rollbackReceipt = await writeReceipt(
        join(shadowContext.paths.stateDirectory, "cutover.rollback.json"),
        {
          schema: "foursday-hermes-rollback-receipt/v1",
          releaseSha: receipt.releaseSha,
          rolledBackAt: new Date().toISOString(),
          legacyReady: true,
          hermesMode: "shadow",
          hermesSendEnabled: false,
        },
      );
      return { rolledBack: true, rollbackReceipt };
    } finally {
      await store.close();
    }
  }
  const releaseSha = argument(args, "--release-sha");
  if (!fullSha.test(releaseSha)) throw new Error("--release-sha must be a full SHA");
  const releaseRoot = absolute(argument(args, "--release-root"), "--release-root");
  const identityPath = absolute(argument(args, "--identity"), "--identity");
  const identity = await verifyHermesReleaseIdentity({
    identity: await privateJson(identityPath, "Hermes release identity"),
    releaseSha,
    releaseRoot,
  });
  const acceptancePath = absolute(argument(args, "--acceptance"), "--acceptance");
  const acceptance = assertHermesShadowAcceptance(
    await privateJson(acceptancePath, "Hermes shadow acceptance"),
    { releaseSha },
  );
  const expectedConfirmation = hermesCutoverConfirmation(acceptance);
  const configPath = absolute(
    environment.AI_EMPLOYEE_CONFIG_FILE,
    "AI_EMPLOYEE_CONFIG_FILE",
  );
  await applyProductionConfigFile({ path: configPath, environment });
  const config = loadConfig({ production: true });
  const store = await createProductionStore(config);
  const shadowContext = await createHermesServiceContext({
    environment,
    mode: "shadow",
  });
  try {
    const legacy = await store.health();
    const shadow = await hermesGatewayStatus(shadowContext);
    const stoppedStates = Object.fromEntries(writerDefinitions.map(
      ({ component }) => [component, "stopped"],
    ));
    const activeContext = await createHermesServiceContext({
      environment,
      mode: "active",
      legacyServiceStates: stoppedStates,
    });
    const blockers = [];
    try {
      assertLegacyCutoverReady(legacy);
    } catch (error) {
      blockers.push(error.message);
    }
    try {
      assertHermesShadowReady(shadow);
    } catch (error) {
      blockers.push(error.message);
    }
    const plan = {
      schema: "foursday-hermes-cutover-plan/v1",
      releaseSha,
      acceptance: {
        scenarioCount: acceptance.scenarioCount,
        evidenceDigest: acceptance.evidenceDigest,
      },
      releaseIdentity: identity,
      legacy: {
        pendingMessages: legacy.pendingMessages,
        taskStatuses: legacy.tasks,
        workPlanStatuses: legacy.workPlans,
        expiredExecutionLeases: legacy.expiredExecutionLeases,
      },
      shadow: {
        running: shadow.running,
        sendEnabled: shadow.sendEnabled,
        checkpointHealthy: shadow.checkpointHealthy,
      },
      activeRegistry: {
        projectCount: activeContext.registry.projectCount,
        sendEnabled: activeContext.gatewayEnvironment.DWS_PERSONAL_SEND_ENABLED === "true",
      },
      ready: blockers.length === 0,
      blockers,
      stopOrder: writerDefinitions.map(({ component }) => component),
      confirmation: blockers.length === 0 ? expectedConfirmation : null,
      applyRequired: true,
      executed: false,
    };
    if (command === "plan" || !args.includes("--apply")) return plan;
    if (blockers.length > 0) {
      throw new Error(`Hermes cutover is blocked: ${blockers.join(";")}`);
    }
    if (argument(args, "--confirm") !== expectedConfirmation) {
      throw new Error("Hermes cutover confirmation does not match current evidence");
    }
    const receiptPath = environment.FOURSDAY_HERMES_CUTOVER_RECEIPT ?? join(
      activeContext.paths.stateDirectory,
      "cutover.active.json",
    );
    return executeHermesCutover({
      async inspectLegacy() { return store.health(); },
      async inspectShadow() { return hermesGatewayStatus(shadowContext); },
      stopLegacyWriters,
      async startActiveHermes() { return installHermesGateway(activeContext); },
      async inspectActive() { return hermesGatewayStatus(activeContext); },
      stopHermes: () => uninstallHermesGateway(activeContext),
      restoreLegacyWriters,
      async verifyLegacyRestored() {
        return waitForLegacyHealth({ store, config });
      },
      async writeReceipt({ activatedAt, legacySnapshot, active }) {
        return writeReceipt(receiptPath, {
          schema: "foursday-hermes-cutover-receipt/v1",
          releaseSha,
          evidenceDigest: acceptance.evidenceDigest,
          activatedAt,
          mode: active.mode,
          sendEnabled: active.sendEnabled,
          legacyWriters: legacySnapshot.services.map(
            ({ component, label, sha256 }) => ({ component, label, sha256 }),
          ),
        });
      },
    });
  } finally {
    await store.close();
  }
}

if (isMainModule(import.meta.url)) {
  console.log(JSON.stringify(await runHermesCutoverCommand(), null, 2));
}
