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
    DATABASE_URL: "env://DATABASE_SECRET",
    DATABASE_POOL_MAX: 12,
    DATABASE_SSL: true,
  });
  const environment = {
    DATABASE_SECRET: "postgresql://example",
    GBRAIN_REMOTE_TOKEN: "personal-token",
    GBRAIN_REMOTE_URL: "https://personal.example",
    GBRAIN_HOME: "/personal/gbrain",
    GBRAIN_DATABASE_URL: "postgresql://personal:secret@localhost/personal",
    GBRAIN_SOURCE: "default",
  };
  await applyProductionConfigFile({ path, environment });
  assert.equal(environment.DATABASE_URL, "postgresql://example");
  assert.equal(environment.DATABASE_POOL_MAX, "12");
  assert.equal(environment.DATABASE_SSL, "true");
  assert.equal(environment.GBRAIN_REMOTE_TOKEN, undefined);
  assert.equal(environment.GBRAIN_REMOTE_URL, undefined);
  assert.equal(environment.GBRAIN_HOME, undefined);
  assert.equal(environment.GBRAIN_DATABASE_URL, undefined);
  assert.equal(environment.GBRAIN_SOURCE, undefined);
});

test("生产运行拒绝内联密钥但迁移工具仍可只读识别旧配置", async () => {
  const path = await configFile({
    DATABASE_URL: "postgresql://legacy-inline-secret",
  });
  await assert.rejects(
    applyProductionConfigFile({ path, environment: {} }),
    /must use an external reference/u,
  );
  const result = await applyProductionConfigFile({
    path,
    environment: {},
    resolveSecrets: false,
  });
  assert.equal(result.values.DATABASE_URL, "postgresql://legacy-inline-secret");
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
      `keychain://foursday-production/${account}`,
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

test("生产模式拒绝未填写的租户、审批人和钉钉标识占位值", () => {
  const names = [
    "DATABASE_URL",
    "AI_EMPLOYEE_DATA_KEY",
    "AI_EMPLOYEE_TENANT_ID",
    "AI_EMPLOYEE_APPROVER",
    "DINGTALK_TARGET_USER_IDS",
    "DINGTALK_TARGET_USER_ID",
    "DINGTALK_TARGET_GROUP_IDS",
    "DINGTALK_SELF_USER_ID",
  ];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  const valid = {
    DATABASE_URL: "postgresql://user:password@127.0.0.1:5432/database",
    AI_EMPLOYEE_DATA_KEY: Buffer.alloc(32, 1).toString("base64"),
    AI_EMPLOYEE_TENANT_ID: "tenant-1",
    AI_EMPLOYEE_APPROVER: "operator-1",
    DINGTALK_TARGET_USER_IDS: "target-1",
    DINGTALK_TARGET_USER_ID: "",
    DINGTALK_TARGET_GROUP_IDS: "",
    DINGTALK_SELF_USER_ID: "self-1",
  };
  try {
    Object.assign(process.env, valid);
    assert.equal(loadConfig({ production: true }).approver, "operator-1");
    for (const name of [
      "AI_EMPLOYEE_TENANT_ID",
      "AI_EMPLOYEE_APPROVER",
      "DINGTALK_TARGET_USER_IDS",
      "DINGTALK_SELF_USER_ID",
    ]) {
      Object.assign(process.env, valid, { [name]: `replace_with_${name}` });
      assert.throws(
        () => loadConfig({ production: true }),
        new RegExp(`${name} still contains a placeholder`, "u"),
      );
    }
    Object.assign(process.env, valid, {
      DINGTALK_TARGET_USER_IDS: "",
      DINGTALK_TARGET_GROUP_IDS: "replace_with_group_id",
    });
    assert.throws(
      () => loadConfig({ production: true }),
      /DINGTALK_TARGET_GROUP_IDS still contains a placeholder/u,
    );
  } finally {
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
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

test("记忆来源访问租约和单次复核数量有安全上限", () => {
  const names = [
    "AI_EMPLOYEE_MEMORY_SOURCE_LEASE_MS",
    "AI_EMPLOYEE_MEMORY_SOURCE_LIMIT",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.AI_EMPLOYEE_MEMORY_SOURCE_LEASE_MS = "3600001";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /600000-3600000/u,
    );
    process.env.AI_EMPLOYEE_MEMORY_SOURCE_LEASE_MS = "900000";
    process.env.AI_EMPLOYEE_MEMORY_SOURCE_LIMIT = "5001";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must be <= 5000/u,
    );
  } finally {
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
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

test("等待补充信息期限必须在一分钟到三十天之间", () => {
  const name = "AI_EMPLOYEE_WAITING_INFORMATION_TTL_MS";
  const previous = process.env[name];
  try {
    process.env[name] = "59999";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /60000-2592000000/u,
    );
    process.env[name] = "2592000001";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /60000-2592000000/u,
    );
    process.env[name] = "86400000";
    assert.equal(
      loadConfig({ requireTargets: false }).waitingInformationTtlMs,
      86_400_000,
    );
  } finally {
    if (previous == null) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("连续消息安静窗口不能超过总等待上限", () => {
  const names = ["DINGTALK_QUIET_WINDOW_MS", "AI_EMPLOYEE_BUNDLE_MAX_WAIT_MS"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.DINGTALK_QUIET_WINDOW_MS = "3000";
    process.env.AI_EMPLOYEE_BUNDLE_MAX_WAIT_MS = "8000";
    const config = loadConfig({ requireTargets: false });
    assert.equal(config.quietWindowMs, 3_000);
    assert.equal(config.bundleMaxWaitMs, 8_000);
    process.env.DINGTALK_QUIET_WINDOW_MS = "9000";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must not exceed/u,
    );
    process.env.DINGTALK_QUIET_WINDOW_MS = "3000";
    process.env.AI_EMPLOYEE_BUNDLE_MAX_WAIT_MS = "8001";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must not exceed 8000/u,
    );
  } finally {
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("草稿 Worker 并发默认保守且有硬上限", () => {
  const name = "AI_EMPLOYEE_WORKER_CONCURRENCY";
  const previous = process.env[name];
  try {
    delete process.env[name];
    assert.equal(loadConfig({ requireTargets: false }).workerConcurrency, 2);
    process.env[name] = "4";
    assert.equal(loadConfig({ requireTargets: false }).workerConcurrency, 4);
    process.env[name] = "0";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must be a positive number/u,
    );
    process.env[name] = "1.5";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must be a positive integer/u,
    );
    process.env[name] = "5";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must not exceed 4/u,
    );
  } finally {
    if (previous == null) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("AgentRuntime 只接受 Codex 或 Claude Code", () => {
  const runtimeName = "AI_EMPLOYEE_AGENT_RUNTIME";
  const claudePathName = "CLAUDE_CODE_PATH";
  const previousRuntime = process.env[runtimeName];
  const previousPath = process.env[claudePathName];
  try {
    delete process.env[runtimeName];
    assert.equal(loadConfig({ requireTargets: false }).agentRuntime, "codex");
    process.env[runtimeName] = "claude-code";
    process.env[claudePathName] = "/trusted/claude";
    const config = loadConfig({ requireTargets: false });
    assert.equal(config.agentRuntime, "claude-code");
    assert.equal(config.claudeCodePath, "/trusted/claude");
    process.env[runtimeName] = "unknown-runtime";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must be one of: codex, claude-code/u,
    );
  } finally {
    if (previousRuntime == null) delete process.env[runtimeName];
    else process.env[runtimeName] = previousRuntime;
    if (previousPath == null) delete process.env[claudePathName];
    else process.env[claudePathName] = previousPath;
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

test("管理台浏览器会话默认八小时且限制在五分钟到一天", () => {
  const name = "AI_EMPLOYEE_ADMIN_SESSION_TTL_MS";
  const previous = process.env[name];
  try {
    delete process.env[name];
    assert.equal(loadConfig({ requireTargets: false }).adminSessionTtlMs, 28_800_000);
    process.env[name] = "300000";
    assert.equal(loadConfig({ requireTargets: false }).adminSessionTtlMs, 300_000);
    process.env[name] = "299999";
    assert.throws(() => loadConfig({ requireTargets: false }), /between 300000/u);
    process.env[name] = "86400001";
    assert.throws(() => loadConfig({ requireTargets: false }), /between 300000/u);
  } finally {
    if (previous == null) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("生产默认使用 gbrain 记忆权威且自动确认必须先开放写入", () => {
  const names = [
    "AI_EMPLOYEE_MEMORY_AUTHORITY_MODE",
    "AI_EMPLOYEE_MEMORY_AUTHORITY_WRITE",
    "AI_EMPLOYEE_MEMORY_AUTHORITY_AUTO_CONFIRM",
    "AI_EMPLOYEE_MEMORY_AUTHORITY_ROOT",
    "AI_EMPLOYEE_MEMORY_AUTHORITY_SOURCE_ID",
    "AI_EMPLOYEE_GBRAIN_HOME",
    "AI_EMPLOYEE_GBRAIN_DATABASE_URL",
    "DATABASE_URL",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.equal(loadConfig({ requireTargets: false }).memoryAuthorityMode, "disabled");
    process.env.AI_EMPLOYEE_MEMORY_AUTHORITY_MODE = "gbrain";
    assert.equal(loadConfig({ requireTargets: false }).memoryAuthorityMode, "gbrain");
    process.env.AI_EMPLOYEE_MEMORY_AUTHORITY_AUTO_CONFIRM = "true";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /requires authority writes/u,
    );
    process.env.AI_EMPLOYEE_MEMORY_AUTHORITY_WRITE = "true";
    process.env.AI_EMPLOYEE_MEMORY_AUTHORITY_ROOT = "/private/var/tmp/foursday-memory";
    process.env.AI_EMPLOYEE_MEMORY_AUTHORITY_SOURCE_ID = "foursday";
    process.env.AI_EMPLOYEE_GBRAIN_HOME = "/private/var/tmp/foursday-gbrain-home";
    process.env.AI_EMPLOYEE_GBRAIN_DATABASE_URL =
      "postgresql://foursday_gbrain:secret@127.0.0.1:55432/foursday_gbrain";
    assert.equal(
      loadConfig({ requireTargets: false }).memoryAuthorityAutoConfirm,
      true,
    );
    process.env.DATABASE_URL =
      "postgresql://employee:secret@127.0.0.1:55432/foursday_gbrain";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must not use the AI employee transaction database/u,
    );
    delete process.env.DATABASE_URL;
    process.env.AI_EMPLOYEE_GBRAIN_DATABASE_URL =
      "postgresql://foursday_gbrain:secret@127.0.0.1:55432/foursday_gbrain?host=example.com";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must not override database identity/u,
    );
    process.env.AI_EMPLOYEE_GBRAIN_DATABASE_URL =
      "postgresql://foursday_gbrain:secret@127.0.0.1:55432/foursday_gbrain";
    process.env.AI_EMPLOYEE_MEMORY_AUTHORITY_MODE = "disabled";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /requires gbrain authority mode/u,
    );
  } finally {
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("无人值守低风险回复必须同时开放真实私聊发送", () => {
  const names = [
    "AI_EMPLOYEE_ALLOWED_CAPABILITIES",
    "AI_EMPLOYEE_AUTO_APPROVE_LOW_RISK_REPLIES",
    "AI_EMPLOYEE_AUTO_APPROVE_MIN_CONFIDENCE",
    "AI_EMPLOYEE_AUTO_APPROVE_GROUP_REPLIES",
    "AI_EMPLOYEE_AUTO_APPROVE_CLARIFICATIONS",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.AI_EMPLOYEE_ALLOWED_CAPABILITIES = "draft_reply";
    process.env.AI_EMPLOYEE_AUTO_APPROVE_LOW_RISK_REPLIES = "true";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /requires send_message/u,
    );
    process.env.AI_EMPLOYEE_ALLOWED_CAPABILITIES = "draft_reply,send_message";
    process.env.AI_EMPLOYEE_AUTO_APPROVE_MIN_CONFIDENCE = "0.97";
    const config = loadConfig({ requireTargets: false });
    assert.equal(config.autoApproveLowRiskReplies, true);
    assert.equal(config.autoApproveMinimumConfidence, 0.97);
    process.env.AI_EMPLOYEE_AUTO_APPROVE_GROUP_REPLIES = "true";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /requires send_group_message/u,
    );
    process.env.AI_EMPLOYEE_ALLOWED_CAPABILITIES =
      "draft_reply,send_message,send_group_message";
    process.env.AI_EMPLOYEE_AUTO_APPROVE_CLARIFICATIONS = "true";
    const expanded = loadConfig({ requireTargets: false });
    assert.equal(expanded.autoApproveGroupReplies, true);
    assert.equal(expanded.autoApproveClarifications, true);
  } finally {
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("钉钉移动审批必须绑定当前账号并开放消息发送", () => {
  const names = [
    "AI_EMPLOYEE_MOBILE_APPROVAL_ENABLED",
    "AI_EMPLOYEE_MOBILE_APPROVAL_NOTIFY_INTERVAL_MS",
    "DINGTALK_SELF_USER_ID",
    "AI_EMPLOYEE_ALLOWED_CAPABILITIES",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.AI_EMPLOYEE_MOBILE_APPROVAL_ENABLED = "true";
    delete process.env.DINGTALK_SELF_USER_ID;
    process.env.AI_EMPLOYEE_ALLOWED_CAPABILITIES = "draft_reply,send_message";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /requires DINGTALK_SELF_USER_ID/u,
    );
    process.env.DINGTALK_SELF_USER_ID = "owner";
    process.env.AI_EMPLOYEE_ALLOWED_CAPABILITIES = "draft_reply";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /requires send_message/u,
    );
    process.env.AI_EMPLOYEE_ALLOWED_CAPABILITIES = "draft_reply,send_message";
    assert.equal(loadConfig({ requireTargets: false }).mobileApprovalEnabled, true);
    process.env.AI_EMPLOYEE_MOBILE_APPROVAL_NOTIFY_INTERVAL_MS = "4999";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must be 5000-300000/u,
    );
    process.env.AI_EMPLOYEE_MOBILE_APPROVAL_NOTIFY_INTERVAL_MS = "300001";
    assert.throws(
      () => loadConfig({ requireTargets: false }),
      /must be 5000-300000/u,
    );
  } finally {
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
