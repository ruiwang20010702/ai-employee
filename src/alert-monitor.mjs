import { createHash, createHmac } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { evaluateHealth } from "./health-check.mjs";
import { applyProductionConfigFile } from "./production-config-file.mjs";
import { createProductionStore } from "./production-store.mjs";
import { isMainModule } from "./main-module.mjs";

function alertCodes(health) {
  const codes = [];
  const checks = health.checks;
  if (!checks.database) codes.push("database_unavailable");
  if (!checks.dwsExecutable) codes.push("dws_unavailable");
  if (!checks.codexExecutable) codes.push("codex_unavailable");
  if (checks.paused) codes.push("system_paused");
  if (checks.deadTasks > 0) codes.push("dead_tasks");
  if (checks.unknownSends > 0) codes.push("unknown_sends");
  for (const [component, value] of Object.entries(checks.heartbeats ?? {})) {
    if (!value.healthy) codes.push(`heartbeat_stale:${component}`);
  }
  for (const [name, value] of Object.entries(checks.operationalChecks ?? {})) {
    if (!value.healthy) codes.push(`operational_check_failed:${name}`);
  }
  if (checks.messageCoverage?.required && !checks.messageCoverage.healthy) {
    codes.push("message_reconciliation_unhealthy");
  }
  return codes.sort();
}

function alertPayload(health, codes, now) {
  return {
    schema: "ai-employee-alert/v1",
    status: health.ready ? "recovered" : "degraded",
    occurredAt: now.toISOString(),
    codes,
    counts: {
      deadTasks: Number(health.checks.deadTasks ?? 0),
      unknownSends: Number(health.checks.unknownSends ?? 0),
      pendingMessages: Number(health.checks.pendingMessages ?? 0),
      remainingMissingMessages: Number(
        health.checks.messageCoverage?.remainingMissing ?? 0,
      ),
    },
  };
}

export async function runAlertCheck({
  store,
  config,
  now = new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (config.alertWebhookUrl && !config.alertWebhookSecret) {
    throw new Error("Alert webhook secret is required when webhook is configured");
  }
  const health = await evaluateHealth({ store, config, now });
  await store.recordAvailabilitySample?.(health.ready, {
    now,
    intervalMs: config.availabilitySampleIntervalMs,
    retentionMs: config.availabilityRetentionMs,
  });
  const codes = alertCodes(health);
  const statusKey = "alert:monitor:last-state";
  const deliveryKey = "alert:monitor:last-delivery";
  const currentState = health.ready ? "ready" : codes.join("|");
  const previousState = await store.getCheckpoint(statusKey);
  const previousDeliveryRaw = await store.getCheckpoint(deliveryKey);
  let previousDelivery = null;
  try {
    previousDelivery = previousDeliveryRaw ? JSON.parse(previousDeliveryRaw) : null;
  } catch {
    previousDelivery = null;
  }
  const stateChanged = previousState !== currentState;
  const cooldownExpired =
    !previousDelivery?.sentAt ||
    now.getTime() - new Date(previousDelivery.sentAt).getTime() >=
      config.alertCooldownMs;
  const shouldNotify =
    (stateChanged && previousState != null) || (!health.ready && cooldownExpired);
  await store.setCheckpoint(statusKey, currentState, now);
  if (!shouldNotify) return { notified: false, ready: health.ready, codes };

  const payload = alertPayload(health, codes, now);
  const body = JSON.stringify(payload);
  const fingerprint = createHash("sha256").update(body).digest("hex");
  if (!config.alertWebhookUrl) {
    console.warn(JSON.stringify({ type: "alert.local", ...payload }));
    await store.setCheckpoint(
      deliveryKey,
      JSON.stringify({ sentAt: now.toISOString(), fingerprint, channel: "local" }),
      now,
    );
    return { notified: true, channel: "local", ready: health.ready, codes };
  }

  const signature = createHmac("sha256", config.alertWebhookSecret)
    .update(body)
    .digest("hex");
  const response = await fetchImpl(config.alertWebhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ai-employee-signature": `sha256=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Alert webhook returned HTTP ${response.status}`);
  await store.setCheckpoint(
    deliveryKey,
    JSON.stringify({ sentAt: now.toISOString(), fingerprint, channel: "webhook" }),
    now,
  );
  return { notified: true, channel: "webhook", ready: health.ready, codes };
}

export async function startAlertMonitor({
  config = loadConfig({ requireTargets: false, production: true }),
  store = null,
} = {}) {
  store = store ?? (await createProductionStore(config));
  let stopped = false;
  let timer = null;
  const check = async () => {
    try {
      await runAlertCheck({ store, config });
    } catch (error) {
      console.error(JSON.stringify({ type: "alert.check_failed", error: error.message }));
    }
  };
  await check();
  timer = setInterval(() => {
    if (!stopped) void check();
  }, config.alertIntervalMs);
  console.log(JSON.stringify({
    type: "alert.started",
    externalWebhookEnabled: Boolean(config.alertWebhookUrl),
  }));
  return {
    isTimerReferenced() {
      return timer?.hasRef?.() ?? true;
    },
    async stop(signal = "manual") {
      stopped = true;
      clearInterval(timer);
      await store.close();
      console.log(JSON.stringify({ type: "alert.stopped", signal }));
    },
  };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  if (process.env.AI_EMPLOYEE_CONFIG_FILE) await applyProductionConfigFile();
  const service = await startAlertMonitor();
  const shutdown = async (signal) => {
    await service.stop(signal);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
