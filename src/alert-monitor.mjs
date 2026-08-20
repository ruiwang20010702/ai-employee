import { createHash, createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { loadConfig } from "./config.mjs";
import { evaluateHealth } from "./health-check.mjs";
import {
  evaluateFoursdayHealth,
  inspectFoursdayRuntimeStatus,
} from "./foursday-runtime-status.mjs";
import { applyProductionConfigFile } from "./production-config-file.mjs";
import { createProductionStore } from "./production-store.mjs";
import { isMainModule } from "./main-module.mjs";

function alertCodes(health) {
  const codes = [];
  const checks = health.checks;
  if (!checks.database) codes.push("database_unavailable");
  if (!checks.dwsExecutable) codes.push("dws_unavailable");
  if (!checks.codexExecutable) codes.push("codex_unavailable");
  if (checks.runtime?.splitBrain) codes.push("runtime_split_brain");
  else if (checks.runtime?.intentionallyStopped) codes.push("runtime_intentionally_stopped");
  else if (checks.runtime && !checks.runtime.ready) codes.push("hermes_runtime_unhealthy");
  if (checks.paused) codes.push("system_paused");
  if (checks.deadTasks > 0) codes.push("dead_tasks");
  if (checks.unknownSends > 0) codes.push("unknown_sends");
  if (checks.failedWorkPlans > 0) codes.push("failed_work_plans");
  if (checks.executingWorkPlans > 0) codes.push("executing_work_plans");
  if (checks.expiredExecutionLeases > 0) codes.push("expired_execution_leases");
  if (checks.pendingMemoryRetirements > 0) codes.push("pending_memory_retirements");
  if (checks.blockedMemoryCandidates > 0) codes.push("blocked_memory_candidates");
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
      failedWorkPlans: Number(health.checks.failedWorkPlans ?? 0),
      executingWorkPlans: Number(health.checks.executingWorkPlans ?? 0),
      expiredExecutionLeases: Number(
        health.checks.expiredExecutionLeases ?? 0,
      ),
      pendingMemoryRetirements: Number(health.checks.pendingMemoryRetirements ?? 0),
      blockedMemoryCandidates: Number(health.checks.blockedMemoryCandidates ?? 0),
      pendingMessages: Number(health.checks.pendingMessages ?? 0),
      remainingMissingMessages: Number(
        health.checks.messageCoverage?.remainingMissing ?? 0,
      ),
    },
  };
}

function normalizedHostname(hostname) {
  return String(hostname).replace(/^\[|\]$/gu, "").toLowerCase();
}

function publicIpv4(address) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function publicIpAddress(address) {
  const normalized = normalizedHostname(address);
  const family = isIP(normalized);
  if (family === 4) return publicIpv4(normalized);
  if (family !== 6) return false;
  if (normalized.startsWith("::ffff:")) {
    return publicIpv4(normalized.slice("::ffff:".length));
  }
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  ) return false;
  const first = Number.parseInt(normalized.split(":")[0], 16);
  return Number.isInteger(first) && first >= 0x2000 && first <= 0x3fff;
}

export function validateAlertWebhookUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Alert webhook URL is invalid");
  }
  const hostname = normalizedHostname(url.hostname);
  if (url.protocol !== "https:") {
    throw new Error("Alert webhook URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Alert webhook URL cannot include credentials");
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Alert webhook cannot target a local hostname");
  }
  if (isIP(hostname) && !publicIpAddress(hostname)) {
    throw new Error("Alert webhook cannot target a private or reserved address");
  }
  return url;
}

export async function resolveAlertWebhookDestination(
  value,
  lookupImpl = dnsLookup,
) {
  const url = validateAlertWebhookUrl(value);
  const hostname = normalizedHostname(url.hostname);
  if (isIP(hostname)) {
    return { url, address: hostname, family: isIP(hostname) };
  }
  const resolved = await lookupImpl(hostname, { all: true, verbatim: true });
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !publicIpAddress(address))
  ) {
    throw new Error("Alert webhook DNS resolved to a private or reserved address");
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

async function postAlertWebhook({
  url,
  body,
  signature,
  lookupImpl = dnsLookup,
  requestImpl = httpsRequest,
}) {
  const destination = await resolveAlertWebhookDestination(url, lookupImpl);
  return new Promise((resolve, reject) => {
    const request = requestImpl(destination.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-foursday-signature": `sha256=${signature}`,
        "x-ai-employee-signature": `sha256=${signature}`,
      },
      lookup(_hostname, options, callback) {
        if (options?.all) {
          callback(null, [{
            address: destination.address,
            family: destination.family,
          }]);
          return;
        }
        callback(null, destination.address, destination.family);
      },
    }, (response) => {
      response.resume();
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
      });
    });
    request.setTimeout(10_000, () => {
      request.destroy(new Error("Alert webhook request timed out"));
    });
    request.on("error", reject);
    request.end(body);
  });
}

export async function runAlertCheck({
  store,
  config,
  now = new Date(),
  fetchImpl = null,
  lookupImpl = dnsLookup,
  requestImpl = httpsRequest,
  runtimeStatusProvider = null,
} = {}) {
  if (config.alertWebhookUrl && !config.alertWebhookSecret) {
    throw new Error("Alert webhook secret is required when webhook is configured");
  }
  const health = runtimeStatusProvider
    ? await evaluateFoursdayHealth({ store, config, now, runtimeStatusProvider })
    : await evaluateHealth({ store, config, now });
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
  const validatedUrl = validateAlertWebhookUrl(config.alertWebhookUrl);
  const response = fetchImpl
    ? await fetchImpl(validatedUrl.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-foursday-signature": `sha256=${signature}`,
          "x-ai-employee-signature": `sha256=${signature}`,
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      })
    : await postAlertWebhook({
        url: validatedUrl,
        body,
        signature,
        lookupImpl,
        requestImpl,
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
  runtimeStatusProvider = inspectFoursdayRuntimeStatus,
} = {}) {
  store = store ?? (await createProductionStore(config));
  let stopped = false;
  let timer = null;
  const check = async () => {
    try {
      await runAlertCheck({ store, config, runtimeStatusProvider });
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
