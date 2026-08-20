import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveAlertWebhookDestination,
  runAlertCheck,
  startAlertMonitor,
  validateAlertWebhookUrl,
} from "../src/alert-monitor.mjs";

function fixture() {
  const checkpoints = new Map();
  const availabilitySamples = [];
  const store = {
    state: { database: true, paused: false, tasks: { dead: 2 }, pendingMessages: 3, checkpoints: [], heartbeats: {} },
    async health() { return this.state; },
    async getCheckpoint(key) { return checkpoints.get(key); },
    async setCheckpoint(key, value) { checkpoints.set(key, value); },
    async recordAvailabilitySample(ready, options) {
      availabilitySamples.push({ ready, options });
    },
  };
  const config = {
    dwsPath: "/bin/sh", codexPath: "/bin/sh", requiredComponents: [], requiredOperationalChecks: [],
    heartbeatStaleMs: 90_000, externalCheckStaleMs: 60_000,
    alertWebhookUrl: "https://alerts.invalid/hook", alertWebhookSecret: "signing-secret",
    alertCooldownMs: 900_000,
  };
  return { store, config, availabilitySamples };
}

test("异常告警只发送脱敏状态并执行冷却", async () => {
  const { store, config, availabilitySamples } = fixture();
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200 };
  };
  const now = new Date("2026-08-04T10:00:00Z");
  const first = await runAlertCheck({ store, config, now, fetchImpl });
  assert.equal(first.notified, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.redirect, "error");
  const payload = JSON.parse(requests[0].init.body);
  assert.deepEqual(payload.codes, ["dead_tasks"]);
  assert.equal(payload.counts.deadTasks, 2);
  assert.doesNotMatch(requests[0].init.body, /signing-secret|alerts\.invalid/u);
  assert.match(requests[0].init.headers["x-ai-employee-signature"], /^sha256=[a-f0-9]{64}$/u);
  assert.equal(
    requests[0].init.headers["x-foursday-signature"],
    requests[0].init.headers["x-ai-employee-signature"],
  );
  assert.deepEqual(availabilitySamples[0], {
    ready: false,
    options: { now, intervalMs: undefined, retentionMs: undefined },
  });

  const second = await runAlertCheck({ store, config, now: new Date(now.getTime() + 1000), fetchImpl });
  assert.equal(second.notified, false);
  assert.equal(requests.length, 1);

  store.state.tasks = {};
  const recovered = await runAlertCheck({ store, config, now: new Date(now.getTime() + 2000), fetchImpl });
  assert.equal(recovered.notified, true);
  assert.equal(JSON.parse(requests[1].init.body).status, "recovered");
});

test("配置外部告警时必须使用签名密钥", async () => {
  const { store, config } = fixture();
  config.alertWebhookSecret = null;
  await assert.rejects(runAlertCheck({ store, config }), /secret is required/u);
});

test("Webhook 拒绝明文、凭据、本机和内网目标", async () => {
  assert.throws(
    () => validateAlertWebhookUrl("http://alerts.example/hook"),
    /HTTPS/u,
  );
  assert.throws(
    () => validateAlertWebhookUrl("https://user:pass@alerts.example/hook"),
    /credentials/u,
  );
  assert.throws(
    () => validateAlertWebhookUrl("https://localhost/hook"),
    /local hostname/u,
  );
  assert.throws(
    () => validateAlertWebhookUrl("https://127.0.0.1/hook"),
    /private or reserved/u,
  );
  assert.throws(
    () => validateAlertWebhookUrl("https://[::1]/hook"),
    /private or reserved/u,
  );
  await assert.rejects(
    resolveAlertWebhookDestination(
      "https://alerts.example/hook",
      async () => [{ address: "10.0.0.7", family: 4 }],
    ),
    /DNS resolved to a private or reserved address/u,
  );
  const publicTarget = await resolveAlertWebhookDestination(
    "https://alerts.example/hook",
    async () => [{ address: "8.8.8.8", family: 4 }],
  );
  assert.equal(publicTarget.address, "8.8.8.8");
});

test("所有导致未就绪的工作计划状态都有明确告警原因", async () => {
  const { store, config } = fixture();
  store.state.tasks = {};
  store.state.workPlans = { failed: 2, executing: 1, verifying: 1 };
  store.state.expiredExecutionLeases = 3;
  store.state.hermesMemoryCandidates = { retirement_pending: 1, blocked: 2 };
  const requests = [];
  const fetchImpl = async (_url, init) => {
    requests.push(init);
    return { ok: true, status: 200 };
  };
  const result = await runAlertCheck({
    store,
    config,
    fetchImpl,
    now: new Date("2026-08-04T10:00:00Z"),
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.codes, [
    "blocked_memory_candidates",
    "executing_work_plans",
    "expired_execution_leases",
    "failed_work_plans",
    "pending_memory_retirements",
  ]);
  const payload = JSON.parse(requests[0].body);
  assert.deepEqual(payload.counts, {
    deadTasks: 0,
    unknownSends: 0,
    failedWorkPlans: 2,
    executingWorkPlans: 2,
    expiredExecutionLeases: 3,
    pendingMemoryRetirements: 1,
    blockedMemoryCandidates: 2,
    pendingMessages: 3,
    remainingMissingMessages: 0,
  });
});

test("Webhook 失败不会进入冷却，下一次检查仍会重试", async () => {
  const { store, config } = fixture();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 503 };
  };
  await assert.rejects(
    runAlertCheck({ store, config, fetchImpl, now: new Date("2026-08-04T10:00:00Z") }),
    /HTTP 503/u,
  );
  await assert.rejects(
    runAlertCheck({ store, config, fetchImpl, now: new Date("2026-08-04T10:00:01Z") }),
    /HTTP 503/u,
  );
  assert.equal(calls, 2);
});

test("常驻告警采样定时器会保持进程存活", async () => {
  const { store, config } = fixture();
  store.close = async () => {};
  config.alertWebhookUrl = null;
  config.alertWebhookSecret = null;
  config.alertIntervalMs = 60_000;
  const monitor = await startAlertMonitor({ store, config });
  try {
    assert.equal(monitor.isTimerReferenced(), true);
  } finally {
    await monitor.stop("test");
  }
});
