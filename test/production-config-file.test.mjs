import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";

async function configFile(values, mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-config-"));
  const path = join(directory, "production.json");
  await writeFile(path, JSON.stringify(values), { mode });
  await chmod(path, mode);
  return path;
}

test("生产配置只接受白名单标量并写入指定环境", async () => {
  const path = await configFile({
    DATABASE_URL: "postgresql://example",
    DATABASE_POOL_MAX: 12,
    DATABASE_SSL: true,
  });
  const environment = {};
  await applyProductionConfigFile({ path, environment });
  assert.equal(environment.DATABASE_URL, "postgresql://example");
  assert.equal(environment.DATABASE_POOL_MAX, "12");
  assert.equal(environment.DATABASE_SSL, "true");
});

test("GitHub 生产示例的五项密钥统一使用正式钥匙串服务", async () => {
  const examplePath = fileURLToPath(
    new URL("../deploy/GitHub生产配置.example.json", import.meta.url),
  );
  const values = JSON.parse(await readFile(examplePath, "utf8"));
  const expectedAccounts = {
    DATABASE_URL: "database-url",
    AI_EMPLOYEE_DATA_KEY: "data-key",
    AI_EMPLOYEE_BACKUP_KEY: "backup-key",
    AI_EMPLOYEE_ADMIN_READ_TOKEN: "admin-read-token",
    AI_EMPLOYEE_ADMIN_WRITE_TOKEN: "admin-write-token",
  };
  for (const [key, account] of Object.entries(expectedAccounts)) {
    assert.equal(
      values[key],
      `keychain://ai-employee-production/${account}`,
    );
  }
});

test("生产配置拒绝过宽文件权限", async () => {
  const path = await configFile({ DATABASE_URL: "postgresql://example" }, 0o644);
  await assert.rejects(
    applyProductionConfigFile({ path, environment: {} }),
    /must not be readable/u,
  );
});

test("生产配置拒绝未知键和复合值", async () => {
  const unknownPath = await configFile({ SHELL: "/bin/sh" });
  await assert.rejects(
    applyProductionConfigFile({ path: unknownPath, environment: {} }),
    /Unsupported config key/u,
  );
  const objectPath = await configFile({ DATABASE_URL: { value: "bad" } });
  await assert.rejects(
    applyProductionConfigFile({ path: objectPath, environment: {} }),
    /must be scalar/u,
  );
});

test("生产配置只对密钥字段解析外部引用且返回值不泄露密钥", async () => {
  const path = await configFile({
    DATABASE_URL: "env://DATABASE_SECRET",
    AI_EMPLOYEE_DATA_KEY: "keychain://ai-employee/data-key",
  });
  const environment = { DATABASE_SECRET: "postgresql://resolved" };
  const result = await applyProductionConfigFile({
    path,
    environment,
    secretResolverOptions: {
      keychainReader: async () => "resolved-data-key",
    },
  });
  assert.equal(environment.DATABASE_URL, "postgresql://resolved");
  assert.equal(environment.AI_EMPLOYEE_DATA_KEY, "resolved-data-key");
  assert.deepEqual(
    result.resolvedSecretKeys,
    ["DATABASE_URL", "AI_EMPLOYEE_DATA_KEY"],
  );
  assert.equal(result.values.DATABASE_URL, "env://DATABASE_SECRET");

  const invalid = await configFile({
    AI_EMPLOYEE_TENANT_ID: "env://TENANT_ID",
  });
  await assert.rejects(
    applyProductionConfigFile({ path: invalid, environment: { TENANT_ID: "x" } }),
    /not allowed/u,
  );

  const missing = await configFile({
    DATABASE_POOL_MAX: 12,
    DATABASE_URL: "env://MISSING_DATABASE_SECRET",
  });
  const unchanged = { EXISTING: "kept" };
  await assert.rejects(
    applyProductionConfigFile({ path: missing, environment: unchanged }),
    /unavailable/u,
  );
  assert.deepEqual(unchanged, { EXISTING: "kept" });
});

test("计划执行租约续租周期必须短于租约", () => {
  const previousLease = process.env.AI_EMPLOYEE_PLAN_EXECUTION_LEASE_MS;
  const previousRenew = process.env.AI_EMPLOYEE_PLAN_EXECUTION_LEASE_RENEW_MS;
  process.env.AI_EMPLOYEE_PLAN_EXECUTION_LEASE_MS = "1000";
  process.env.AI_EMPLOYEE_PLAN_EXECUTION_LEASE_RENEW_MS = "1000";
  try {
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must be shorter/u,
    );
  } finally {
    if (previousLease == null) delete process.env.AI_EMPLOYEE_PLAN_EXECUTION_LEASE_MS;
    else process.env.AI_EMPLOYEE_PLAN_EXECUTION_LEASE_MS = previousLease;
    if (previousRenew == null) delete process.env.AI_EMPLOYEE_PLAN_EXECUTION_LEASE_RENEW_MS;
    else process.env.AI_EMPLOYEE_PLAN_EXECUTION_LEASE_RENEW_MS = previousRenew;
  }
});

test("消息对账宽限期必须短于对账窗口", () => {
  const previousWindow = process.env.AI_EMPLOYEE_RECONCILIATION_WINDOW_MS;
  const previousGrace = process.env.AI_EMPLOYEE_RECONCILIATION_GRACE_MS;
  process.env.AI_EMPLOYEE_RECONCILIATION_WINDOW_MS = "1000";
  process.env.AI_EMPLOYEE_RECONCILIATION_GRACE_MS = "1000";
  try {
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must be shorter/u,
    );
  } finally {
    if (previousWindow == null) delete process.env.AI_EMPLOYEE_RECONCILIATION_WINDOW_MS;
    else process.env.AI_EMPLOYEE_RECONCILIATION_WINDOW_MS = previousWindow;
    if (previousGrace == null) delete process.env.AI_EMPLOYEE_RECONCILIATION_GRACE_MS;
    else process.env.AI_EMPLOYEE_RECONCILIATION_GRACE_MS = previousGrace;
  }
});

test("入口可用性采样频率和保留窗口必须可形成完整月度口径", () => {
  const names = [
    "AI_EMPLOYEE_ALERT_INTERVAL_MS",
    "AI_EMPLOYEE_AVAILABILITY_SAMPLE_INTERVAL_MS",
    "AI_EMPLOYEE_AVAILABILITY_WINDOW_MS",
    "AI_EMPLOYEE_AVAILABILITY_RETENTION_MS",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.AI_EMPLOYEE_ALERT_INTERVAL_MS = "120000";
    process.env.AI_EMPLOYEE_AVAILABILITY_SAMPLE_INTERVAL_MS = "60000";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must not exceed/u,
    );
    process.env.AI_EMPLOYEE_ALERT_INTERVAL_MS = "60000";
    process.env.AI_EMPLOYEE_AVAILABILITY_WINDOW_MS = "1000";
    process.env.AI_EMPLOYEE_AVAILABILITY_RETENTION_MS = "1000";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must exceed/u,
    );
  } finally {
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("开启计划执行时必须把执行器纳入健康组件", () => {
  const previousCapabilities = process.env.AI_EMPLOYEE_ALLOWED_CAPABILITIES;
  const previousComponents = process.env.AI_EMPLOYEE_REQUIRED_COMPONENTS;
  process.env.AI_EMPLOYEE_ALLOWED_CAPABILITIES = "draft_reply,work_plan_execution";
  process.env.AI_EMPLOYEE_REQUIRED_COMPONENTS = "listener,worker";
  try {
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /requires executor/u,
    );
  } finally {
    if (previousCapabilities == null) delete process.env.AI_EMPLOYEE_ALLOWED_CAPABILITIES;
    else process.env.AI_EMPLOYEE_ALLOWED_CAPABILITIES = previousCapabilities;
    if (previousComponents == null) delete process.env.AI_EMPLOYEE_REQUIRED_COMPONENTS;
    else process.env.AI_EMPLOYEE_REQUIRED_COMPONENTS = previousComponents;
  }
});
