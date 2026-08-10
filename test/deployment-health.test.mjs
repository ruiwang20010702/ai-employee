import assert from "node:assert/strict";
import test from "node:test";
import {
  deploymentVerificationTimeout,
  evaluateDeploymentHealth,
} from "../src/deployment-health.mjs";

function input(overrides = {}) {
  return {
    liveStatus: 200,
    liveBody: { status: "alive" },
    readyStatus: 200,
    readyBody: {
      status: "ready",
      checks: {
        database: true,
        dwsExecutable: true,
        codexExecutable: true,
        paused: false,
        deadTasks: 0,
        unknownSends: 0,
        failedWorkPlans: 0,
        executingWorkPlans: 0,
        expiredExecutionLeases: 0,
        heartbeats: { listener: { healthy: true }, worker: { healthy: true } },
        operationalChecks: { listener: { healthy: true } },
        messageCoverage: { required: true, healthy: true },
      },
    },
    adminStatus: 200,
    releaseServices: { verified: true, failedLabels: [] },
    ...overrides,
  };
}

test("服务部署验证与严格业务就绪分别报告", () => {
  const ready = evaluateDeploymentHealth(input());
  assert.equal(ready.verified, true);
  assert.equal(ready.businessReady, true);

  const degraded = input({ readyStatus: 503 });
  degraded.readyBody.status = "degraded";
  degraded.readyBody.checks.deadTasks = 2;
  const result = evaluateDeploymentHealth(degraded);
  assert.equal(result.verified, true);
  assert.equal(result.businessReady, false);
  assert.deepEqual(result.blockers, ["dead_tasks"]);
  assert.equal(result.counts.deadTasks, 2);
});

test("基础设施、未知发送或过期执行租约仍阻止服务部署", () => {
  for (const [field, value, code] of [
    ["database", false, "database_unavailable"],
    ["unknownSends", 1, "unknown_sends_present"],
    ["expiredExecutionLeases", 1, "expired_execution_leases_present"],
  ]) {
    const candidate = input({ readyStatus: 503 });
    candidate.readyBody.status = "degraded";
    candidate.readyBody.checks[field] = value;
    const result = evaluateDeploymentHealth(candidate);
    assert.equal(result.verified, false);
    assert.ok(result.failures.includes(code));
  }
});

test("心跳、外部检查、消息覆盖和管理台不可用时拒绝部署成功", () => {
  const candidate = input({ adminStatus: 503, readyStatus: 503 });
  candidate.readyBody.status = "degraded";
  candidate.readyBody.checks.heartbeats.worker.healthy = false;
  candidate.readyBody.checks.operationalChecks.listener.healthy = false;
  candidate.readyBody.checks.messageCoverage.healthy = false;
  const result = evaluateDeploymentHealth(candidate);
  assert.equal(result.verified, false);
  assert.deepEqual(result.failures, [
    "heartbeat_unhealthy",
    "operational_check_unhealthy",
    "message_coverage_unhealthy",
    "admin_unavailable",
  ]);
});

test("畸形健康响应不能被当成降级但可用", () => {
  const result = evaluateDeploymentHealth(
    input({ readyStatus: 503, readyBody: { status: "degraded" } }),
  );
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("health_payload_invalid"));
});

test("空心跳和 HTTP 状态语义不一致时拒绝部署成功", () => {
  const candidate = input({ readyStatus: 503 });
  candidate.readyBody.status = "ready";
  candidate.readyBody.checks.heartbeats = {};
  const result = evaluateDeploymentHealth(candidate);
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("health_status_mismatch"));
  assert.ok(result.failures.includes("heartbeat_unhealthy"));
});

test("失败或执行中的计划不影响服务存活结论但阻止业务就绪", () => {
  const candidate = input();
  candidate.readyBody.checks.failedWorkPlans = 1;
  candidate.readyBody.checks.executingWorkPlans = 1;
  const result = evaluateDeploymentHealth(candidate);
  assert.equal(result.verified, true);
  assert.equal(result.businessReady, false);
  assert.deepEqual(result.blockers, ["failed_work_plans", "active_work_plans"]);
});

test("服务部署验证等待时间必须有界", () => {
  assert.equal(deploymentVerificationTimeout(undefined), 90_000);
  assert.equal(deploymentVerificationTimeout("1000"), 1_000);
  for (const value of ["", "999", "300001", "NaN", "1.5"]) {
    assert.throws(() => deploymentVerificationTimeout(value), /between 1000 and 300000/u);
  }
});

test("未证明常驻服务来自目标版本时拒绝部署成功", () => {
  const result = evaluateDeploymentHealth(
    input({
      releaseServices: {
        verified: false,
        failedLabels: ["com.ai-employee.worker"],
      },
    }),
  );
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("release_services_unverified"));
  assert.deepEqual(result.releaseServices.failedLabels, ["com.ai-employee.worker"]);
});
