import { access, constants } from "node:fs/promises";

async function executable(path) {
  return access(path, constants.X_OK)
    .then(() => true)
    .catch(() => false);
}

export async function evaluateHealth({ store, config, now = new Date() }) {
  const state = await store.health();
  const heartbeats = Object.fromEntries(
    config.requiredComponents.map((component) => {
      const value = state.heartbeats?.[component] ?? null;
      const ageMs = value ? now.getTime() - new Date(value).getTime() : null;
      return [
        component,
        {
          lastSeenAt: value,
          ageMs,
          healthy:
            ageMs != null &&
            Number.isFinite(ageMs) &&
            ageMs >= 0 &&
            ageMs <= config.heartbeatStaleMs,
        },
      ];
    }),
  );
  const checks = {
    database: Boolean(state.database),
    dwsExecutable: await executable(config.dwsPath),
    codexExecutable: await executable(config.codexPath),
    paused: state.paused,
    deadTasks: state.tasks.dead ?? 0,
    unknownSends: state.tasks.send_unknown ?? 0,
    pendingMessages: state.pendingMessages,
    checkpoints: state.checkpoints.length,
    heartbeats,
  };
  const ready =
    checks.database &&
    checks.dwsExecutable &&
    checks.codexExecutable &&
    checks.deadTasks === 0 &&
    checks.unknownSends === 0 &&
    Object.values(heartbeats).every((heartbeat) => heartbeat.healthy);
  return { ready, checks, state };
}

export function prometheusMetrics(health) {
  const lines = [
    "# HELP ai_employee_ready Whether all production dependencies are ready.",
    "# TYPE ai_employee_ready gauge",
    `ai_employee_ready ${health.ready ? 1 : 0}`,
    "# HELP ai_employee_dead_tasks Tasks that exhausted all retries.",
    "# TYPE ai_employee_dead_tasks gauge",
    `ai_employee_dead_tasks ${health.checks.deadTasks}`,
    "# HELP ai_employee_unknown_sends Sends requiring manual reconciliation.",
    "# TYPE ai_employee_unknown_sends gauge",
    `ai_employee_unknown_sends ${health.checks.unknownSends}`,
    "# HELP ai_employee_pending_messages Messages waiting for bundling.",
    "# TYPE ai_employee_pending_messages gauge",
    `ai_employee_pending_messages ${health.checks.pendingMessages}`,
  ];
  for (const [component, heartbeat] of Object.entries(
    health.checks.heartbeats,
  )) {
    lines.push(
      `ai_employee_component_heartbeat_healthy{component="${component}"} ${
        heartbeat.healthy ? 1 : 0
      }`,
    );
    if (heartbeat.ageMs != null) {
      lines.push(
        `ai_employee_component_heartbeat_age_seconds{component="${component}"} ${(
          heartbeat.ageMs / 1000
        ).toFixed(3)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
