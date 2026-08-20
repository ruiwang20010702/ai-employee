import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateHealth,
  prometheusMetrics,
} from "../src/health-check.mjs";
import { startHealthServer } from "../src/health-server.mjs";

const config = {
  requiredComponents: ["listener", "worker"],
  heartbeatStaleMs: 90_000,
  externalCheckStaleMs: 600_000,
  requiredOperationalChecks: [
    "listener:last-full-success",
    "worker:manual-reply:last-success",
  ],
  dwsPath: "/bin/sh",
  codexPath: "/bin/sh",
};

function store(state) {
  return {
    async health() {
      return {
        database: { database: "test" },
        paused: false,
        tasks: {},
        workPlans: {},
        expiredExecutionLeases: 0,
        pendingMessages: 0,
        checkpoints: [],
        heartbeats: {},
        ...state,
      };
    },
    async operationalMetrics() {
      return state.operationalMetrics ?? null;
    },
  };
}

test("深度健康检查要求数据库、工具和所有组件心跳正常", async () => {
  const now = new Date("2026-07-31T10:00:00.000Z");
  const health = await evaluateHealth({
    store: store({
      checkpoints: [
        {
          key: "listener:last-full-success",
          updated_at: "2026-07-31T09:59:30.000Z",
        },
        {
          key: "worker:manual-reply:last-success",
          updated_at: "2026-07-31T09:59:45.000Z",
        },
      ],
      heartbeats: {
        listener: "2026-07-31T09:59:30.000Z",
        worker: "2026-07-31T09:59:45.000Z",
      },
    }),
    config,
    now,
  });
  assert.equal(health.ready, true);
  assert.match(prometheusMetrics(health), /ai_employee_ready 1/);
  assert.match(prometheusMetrics(health), /foursday_ready 1/);
});

test("过期心跳、死信或未知发送会阻断就绪状态", async () => {
  const now = new Date("2026-07-31T10:00:00.000Z");
  const health = await evaluateHealth({
    store: store({
      tasks: { dead: 1, send_unknown: 1 },
      heartbeats: {
        listener: "2026-07-31T09:50:00.000Z",
        worker: "2026-07-31T09:59:45.000Z",
      },
    }),
    config,
    now,
  });
  assert.equal(health.ready, false);
  assert.equal(health.checks.heartbeats.listener.healthy, false);
  assert.match(prometheusMetrics(health), /ai_employee_ready 0/);
});

test("过期计划执行租约阻断就绪并进入指标", async () => {
  const health = await evaluateHealth({
    store: store({ expiredExecutionLeases: 1 }),
    config: { ...config, requiredComponents: [], requiredOperationalChecks: [] },
    now: new Date("2026-07-31T10:00:00.000Z"),
  });
  assert.equal(health.ready, false);
  assert.match(prometheusMetrics(health), /ai_employee_expired_execution_leases 1/u);
});

test("个人 gbrain 回收积压和阻塞候选阻断就绪并进入指标", async () => {
  const health = await evaluateHealth({
    store: store({
      hermesMemoryCandidates: { retirement_pending: 2, retiring: 1, blocked: 4 },
    }),
    config: { ...config, requiredComponents: [], requiredOperationalChecks: [] },
    now: new Date("2026-07-31T10:00:00.000Z"),
  });
  assert.equal(health.ready, false);
  assert.equal(health.checks.pendingMemoryRetirements, 3);
  assert.equal(health.checks.blockedMemoryCandidates, 4);
  const metrics = prometheusMetrics(health);
  assert.match(metrics, /foursday_pending_memory_retirements 3/u);
  assert.match(metrics, /foursday_blocked_memory_candidates 4/u);
});

test("失败或执行中的计划阻断严格业务就绪", async () => {
  for (const workPlans of [{ failed: 1 }, { executing: 1 }, { verifying: 1 }]) {
    const health = await evaluateHealth({
      store: store({ workPlans }),
      config: { ...config, requiredComponents: [], requiredOperationalChecks: [] },
      now: new Date("2026-07-31T10:00:00.000Z"),
    });
    assert.equal(health.ready, false);
  }
});

test("Prometheus 输出运营 SLO 且无样本不会伪造数值", async () => {
  const operationalMetrics = {
    availability: {
      trackingCoverage: 0.5,
      expectedSamples: 120,
      recordedSamples: 119,
      missingSamples: 1,
      availability: 0.99,
      windowComplete: false,
    },
    memoryConflicts: {
      conflictCandidates: 2,
      duplicateCandidates: 1,
      activeConflictGroups: 0,
      conflictRate: 0.5,
    },
    window: { dataComplete: true },
    messageDetection: { samples: 2, p95Ms: 4_500 },
    messageCoverage: { dataComplete: true, sourceMessages: 20, missedBeforeRepair: 1, repairedMessages: 1, remainingMissing: 0, observedMissRate: 0.05, finalMissRate: 0 },
    lowRiskTasks: { samples: 3, successRate: 1, durationSamples: 2, durationP95Ms: 90_000, lifecycleSamples: 3, lifecycleP95Ms: 180_000 },
    approvalWait: { samples: 1, p95Ms: 30_000 },
    reliability: {
      duplicateSideEffects: 0,
      unknownSideEffects: 0,
      completedSideEffects: 1,
      sideEffectAuditCoverage: 1,
      codexTimeouts: 0,
      deadTasks: 0,
    },
  };
  const health = await evaluateHealth({
    store: store({ operationalMetrics }),
    config: { ...config, requiredComponents: [], requiredOperationalChecks: [] },
    now: new Date("2026-07-31T10:00:00.000Z"),
    includeOperationalMetrics: true,
  });
  const metrics = prometheusMetrics(health);
  assert.match(metrics, /ai_employee_message_detection_p95_seconds 4\.500/u);
  assert.match(metrics, /ai_employee_source_reconciliation_observed_miss_ratio 0\.050000/u);
  assert.match(metrics, /ai_employee_source_reconciliation_remaining_missing 0/u);
  assert.match(metrics, /ai_employee_low_risk_task_success_ratio 1\.000000/u);
  assert.match(metrics, /ai_employee_low_risk_task_duration_samples 2/u);
  assert.match(metrics, /ai_employee_low_risk_task_lifecycle_p95_seconds 180\.000/u);
  assert.match(metrics, /ai_employee_side_effect_audit_coverage_ratio 1\.000000/u);
  assert.match(metrics, /ai_employee_monthly_availability_ratio 0\.990000/u);
  assert.match(metrics, /ai_employee_availability_missing_samples 1/u);
  assert.match(metrics, /ai_employee_availability_window_complete 0/u);
  assert.match(metrics, /ai_employee_memory_conflict_candidates 2/u);
  assert.match(metrics, /ai_employee_memory_candidate_conflict_ratio 0\.500000/u);
});

test("外部读取过期或最新一次失败会阻断就绪状态", async () => {
  const now = new Date("2026-07-31T10:00:00.000Z");
  const health = await evaluateHealth({
    store: store({
      checkpoints: [
        {
          key: "listener:last-full-success",
          updated_at: "2026-07-31T09:40:00.000Z",
        },
        {
          key: "worker:manual-reply:last-success",
          updated_at: "2026-07-31T09:59:00.000Z",
        },
        {
          key: "worker:manual-reply:last-failure",
          updated_at: "2026-07-31T09:59:30.000Z",
        },
      ],
      heartbeats: {
        listener: "2026-07-31T09:59:30.000Z",
        worker: "2026-07-31T09:59:45.000Z",
      },
    }),
    config,
    now,
  });
  assert.equal(health.ready, false);
  assert.equal(
    health.checks.operationalChecks["listener:last-full-success"].healthy,
    false,
  );
  assert.equal(
    health.checks.operationalChecks["worker:manual-reply:last-success"].healthy,
    false,
  );
});

test("启用消息源对账门禁后仍有缺失会阻断就绪", async () => {
  const now = new Date("2026-07-31T10:00:00.000Z");
  const health = await evaluateHealth({
    store: store({
      checkpoints: [{
        key: "reconciliation:message-coverage:last-success",
        value: JSON.stringify({
          checkedAt: "2026-07-31T09:59:00.000Z",
          windowStart: "2026-07-30T09:57:00.000Z",
          windowEnd: "2026-07-31T09:57:00.000Z",
          dataComplete: true,
          sourceMessages: 10,
          missedBeforeRepair: 1,
          repairedMessages: 0,
          remainingMissing: 1,
        }),
        updated_at: "2026-07-31T09:59:00.000Z",
      }],
    }),
    config: {
      ...config,
      requiredComponents: [],
      requiredOperationalChecks: [],
      requireMessageReconciliation: true,
      reconciliationStaleMs: 7_200_000,
    },
    now,
  });
  assert.equal(health.ready, false);
  assert.equal(health.checks.messageCoverage.remainingMissing, 1);
  assert.equal(health.checks.messageCoverage.healthy, false);
});

test("系统暂停时存活但不接受生产任务", async () => {
  const now = new Date("2026-07-31T10:00:00.000Z");
  const health = await evaluateHealth({
    store: store({
      paused: true,
      checkpoints: [
        {
          key: "listener:last-full-success",
          updated_at: "2026-07-31T09:59:30.000Z",
        },
        {
          key: "worker:manual-reply:last-success",
          updated_at: "2026-07-31T09:59:45.000Z",
        },
      ],
      heartbeats: {
        listener: "2026-07-31T09:59:30.000Z",
        worker: "2026-07-31T09:59:45.000Z",
      },
    }),
    config,
    now,
  });
  assert.equal(health.ready, false);
  assert.equal(health.checks.paused, true);
});

test("健康服务公开存活、保护就绪和指标接口", async (t) => {
  const healthStore = store({
    heartbeats: {},
  });
  healthStore.close = async () => {};
  const service = await startHealthServer({
    store: healthStore,
    config: {
      ...config,
      healthHost: "127.0.0.1",
      healthPort: 0,
      healthAuthToken: "test-token",
      requiredComponents: [],
      requiredOperationalChecks: [],
    },
  });
  t.after(() => service.stop());
  const { port } = service.server.address();
  const live = await fetch(`http://127.0.0.1:${port}/live`);
  assert.equal(live.status, 200);
  const unauthorized = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(unauthorized.status, 401);
  const ready = await fetch(`http://127.0.0.1:${port}/ready`, {
    headers: { authorization: "Bearer test-token" },
  });
  assert.equal(ready.status, 200);
  const metrics = await fetch(`http://127.0.0.1:${port}/metrics`, {
    headers: { authorization: "Bearer test-token" },
  });
  assert.match(await metrics.text(), /ai_employee_ready 1/u);
});

test("非本机健康服务没有令牌时拒绝启动", async () => {
  await assert.rejects(
    startHealthServer({
      store: {},
      config: {
        ...config,
        healthHost: "0.0.0.0",
        healthPort: 0,
        healthAuthToken: null,
      },
    }),
    /required when health server is not loopback-only/u,
  );
});
