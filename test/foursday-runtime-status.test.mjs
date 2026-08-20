import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  evaluateFoursdayHealth,
  inspectFoursdayRuntimeStatus,
  inspectManagedFoursdayGateway,
} from "../src/foursday-runtime-status.mjs";

test("runtime selection prefers the only active writer and detects split brain", async () => {
  const projectRoot = "/private/project";
  const native = { runtime: "native_hermes_profile", ready: true, mode: "active", sendEnabled: true };
  const managed = { runtime: "foursday_managed_hermes", ready: false, mode: "active", sendEnabled: true };
  const selected = await inspectFoursdayRuntimeStatus({
    projectRoot,
    userHome: "/private/home",
    inspectNative: async () => native,
    inspectManaged: async () => managed,
  });
  assert.equal(selected.current.runtime, "native_hermes_profile");
  assert.equal(selected.ready, true);
  const split = await inspectFoursdayRuntimeStatus({
    projectRoot,
    userHome: "/private/home",
    inspectNative: async () => native,
    inspectManaged: async () => ({ ...managed, ready: true }),
  });
  assert.equal(split.ready, false);
  assert.equal(split.splitBrain, true);
  assert.equal(split.current, null);
});

test("managed Gateway status requires launchd, private fresh checkpoint and consistent send mode", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-managed-status-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launchAgents = join(root, "Library", "LaunchAgents");
  await mkdir(launchAgents, { recursive: true });
  const checkpoint = join(root, "checkpoint.json");
  const now = Date.now();
  await writeFile(checkpoint, JSON.stringify({
    lastFullSuccessAt: new Date(now).toISOString(),
    lastErrorCount: 0,
  }), { mode: 0o600 });
  await writeFile(join(launchAgents, "com.foursday.hermes-gateway.plist"), [
    "<key>FOURSDAY_HERMES_MODE</key><string>active</string>",
    "<key>DWS_PERSONAL_SEND_ENABLED</key><string>true</string>",
    `<key>DWS_PERSONAL_STATE_FILE</key><string>${checkpoint}</string>`,
    "<key>DWS_PERSONAL_FALLBACK_MS</key><string>300000</string>",
  ].join("\n"), { mode: 0o600 });
  const status = await inspectManagedFoursdayGateway({
    userHome: root,
    uid: 501,
    now: now + 1_000,
    run: async (_path, args) => ({
      stdout: args[0] === "print-disabled"
        ? '"com.foursday.hermes-gateway" => disabled\n'
        : "state = running\n",
    }),
  });
  assert.equal(status.ready, true);
  assert.equal(status.sendEnabled, true);
  assert.equal(status.serviceEnabled, false);
});

test("unified health ignores stopped legacy queues only when a real Hermes writer is healthy", async () => {
  const store = {
    health: async () => ({
      database: true,
      paused: false,
      tasks: { dead: 2, send_unknown: 1 },
      workPlans: { failed: 1 },
      pendingMessages: 0,
      expiredExecutionLeases: 0,
      checkpoints: [],
      heartbeats: {},
    }),
  };
  const config = {
    dwsPath: process.execPath,
    codexPath: process.execPath,
    requiredComponents: ["listener", "worker"],
    requiredOperationalChecks: [],
    requireMessageReconciliation: false,
    heartbeatStaleMs: 1,
    externalCheckStaleMs: 1,
    reconciliationStaleMs: 1,
  };
  const health = await evaluateFoursdayHealth({
    store,
    config,
    projectRoot: "/private/project",
    runtimeStatusProvider: async () => ({
      ready: true,
      current: { runtime: "native_hermes_profile", mode: "active", sendEnabled: true },
    }),
  });
  assert.equal(health.ready, true);
  assert.equal(health.checks.deadTasks, 0);
  assert.equal(health.compatibility.tasks.dead, 2);
});

test("native runtime readiness still blocks on unresolved personal gbrain cleanup", async () => {
  const store = {
    health: async () => ({
      database: true,
      paused: false,
      tasks: {},
      workPlans: {},
      hermesMemoryCandidates: { retirement_pending: 1 },
      pendingMessages: 0,
      expiredExecutionLeases: 0,
      checkpoints: [],
      heartbeats: {},
    }),
  };
  const health = await evaluateFoursdayHealth({
    store,
    config: {
      dwsPath: process.execPath,
      codexPath: process.execPath,
      requiredComponents: [],
      requiredOperationalChecks: [],
      requireMessageReconciliation: false,
      heartbeatStaleMs: 1,
      externalCheckStaleMs: 1,
      reconciliationStaleMs: 1,
    },
    runtimeStatusProvider: async () => ({
      ready: true,
      splitBrain: false,
      current: { runtime: "native_hermes_profile", mode: "active", sendEnabled: true },
    }),
  });
  assert.equal(health.ready, false);
  assert.equal(health.checks.pendingMemoryRetirements, 1);
});

test("unified health exposes both stopped runtimes instead of hiding runtime state", async () => {
  const store = {
    health: async () => ({
      database: true,
      paused: true,
      tasks: {},
      workPlans: {},
      pendingMessages: 0,
      expiredExecutionLeases: 0,
      checkpoints: [],
      heartbeats: {},
    }),
  };
  const runtime = {
    ready: false,
    splitBrain: false,
    current: null,
    native: { installed: true, running: false, serviceEnabled: false, mode: "shadow", sendEnabled: false, safeStopped: true },
    managed: { installed: true, running: false, serviceEnabled: false, mode: "shadow", sendEnabled: false, safeStopped: true },
    intentionallyStopped: true,
  };
  const health = await evaluateFoursdayHealth({
    store,
    config: {
      dwsPath: process.execPath,
      codexPath: process.execPath,
      requiredComponents: [],
      requiredOperationalChecks: [],
      requireMessageReconciliation: false,
      heartbeatStaleMs: 1,
      externalCheckStaleMs: 1,
      reconciliationStaleMs: 1,
    },
    runtimeStatusProvider: async () => runtime,
  });
  assert.equal(health.ready, false);
  assert.equal(health.checks.runtime.current, null);
  assert.equal(health.checks.runtime.native.running, false);
  assert.equal(health.checks.runtime.managed.running, false);
  assert.equal(health.checks.runtime.intentionallyStopped, true);
});
