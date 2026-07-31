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
        pendingMessages: 0,
        checkpoints: [],
        heartbeats: {},
        ...state,
      };
    },
  };
}

test("深度健康检查要求数据库、工具和所有组件心跳正常", async () => {
  const now = new Date("2026-07-31T10:00:00.000Z");
  const health = await evaluateHealth({
    store: store({
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
