import assert from "node:assert/strict";
import test from "node:test";
import {
  checkCodexRuntime,
  checkDwsRuntime,
  checkGbrainRuntime,
  checkProductionReadiness,
  requireExecutable,
  validateBase64Key,
  validateLongToken,
  validateProductionReadinessConfig,
} from "../src/production-readiness.mjs";

const key = Buffer.alloc(32, 1).toString("base64");
const backupKey = Buffer.alloc(32, 2).toString("base64");

function validConfig(overrides = {}) {
  return {
    dataKey: key,
    adminReadToken: "r".repeat(32),
    adminWriteToken: "w".repeat(32),
    adminHost: "127.0.0.1",
    alertWebhookUrl: null,
    alertWebhookSecret: null,
    databaseUrl: "postgresql://employee:secret@127.0.0.1:5432/employee",
    databaseSsl: false,
    capabilities: new Set(),
    dwsPath: "dws",
    codexPath: "codex",
    gbrainPath: "gbrain",
    projectsDirectory: "/projects",
    targetUserIds: [],
    targetGroupIds: [],
    ...overrides,
  };
}

test("canonical 32-byte keys and long tokens are accepted", () => {
  assert.doesNotThrow(() => validateBase64Key("KEY", key));
  assert.doesNotThrow(() => validateLongToken("TOKEN", "x".repeat(32)));
});

test("malformed keys and placeholder tokens are rejected", () => {
  assert.throws(() => validateBase64Key("KEY", "not-a-key"), /32-byte key/);
  assert.throws(() => validateLongToken("TOKEN", "replace".repeat(8)), /placeholder/);
});

test("production readiness validation enforces independent secrets and remote TLS", () => {
  assert.doesNotThrow(() =>
    validateProductionReadinessConfig(validConfig(), {
      AI_EMPLOYEE_BACKUP_KEY: backupKey,
    }),
  );
  assert.throws(
    () =>
      validateProductionReadinessConfig(validConfig(), {
        AI_EMPLOYEE_BACKUP_KEY: key,
      }),
    /must be different/,
  );
  assert.throws(
    () =>
      validateProductionReadinessConfig(
        validConfig({
          databaseUrl: "postgresql://employee:secret@db.example.org:5432/employee",
        }),
        { AI_EMPLOYEE_BACKUP_KEY: backupKey },
      ),
    /DATABASE_SSL must be true/,
  );
});

test("executables may be resolved from PATH or pinned by absolute path", async () => {
  await assert.doesNotReject(() => requireExecutable("shell", "sh"));
  await assert.doesNotReject(() => requireExecutable("shell", "/bin/sh"));
  await assert.rejects(
    () => requireExecutable("missing", "definitely-not-an-ai-employee-command"),
    /not executable or discoverable/,
  );
});

test("Codex runtime doctor must return valid redacted ok JSON", async () => {
  const result = await checkCodexRuntime("codex", async (path, args, options) => {
    assert.equal(path, "codex");
    assert.deepEqual(args, ["doctor", "--json"]);
    assert.equal(options.env.DATABASE_URL, undefined);
    return {
      stdout: JSON.stringify({ overallStatus: "ok", codexVersion: "1.2.3" }),
    };
  });
  assert.deepEqual(result, { status: "ok", version: "1.2.3", advisories: [] });
  const updateAdvisory = await checkCodexRuntime("codex", async () => ({
    stdout: JSON.stringify({
      overallStatus: "warning",
      codexVersion: "1.2.3",
      checks: {
        "auth.credentials": { status: "ok" },
        "network.provider_reachability": { status: "ok" },
        "updates.status": { status: "warning" },
      },
    }),
  }));
  assert.deepEqual(updateAdvisory, {
    status: "warning",
    version: "1.2.3",
    advisories: ["updates.status"],
  });
  await assert.rejects(
    () => checkCodexRuntime("codex", async () => ({
      stdout: JSON.stringify({
        overallStatus: "warning",
        checks: {
          "auth.credentials": { status: "warning" },
          "updates.status": { status: "warning" },
        },
      }),
    })),
    /non-ok status/u,
  );
  await assert.rejects(
    () => checkCodexRuntime("codex", async () => ({
      stdout: JSON.stringify({ overallStatus: "error" }),
    })),
    /non-ok status/u,
  );
  await assert.rejects(
    () => checkCodexRuntime("codex", async () => ({ stdout: "not-json" })),
    /runtime doctor failed/u,
  );
});

test("DWS runtime check uses JSON auth status and returns no identity", async () => {
  const result = await checkDwsRuntime("dws", async (path, args, options) => {
    assert.equal(path, "dws");
    assert.deepEqual(args, ["auth", "status", "--format", "json"]);
    assert.equal(options.env.AI_EMPLOYEE_DATA_KEY, undefined);
    return {
      stdout: JSON.stringify({
        success: true,
        authenticated: true,
        token_valid: true,
        refresh_token_valid: true,
        corp_id: "must-not-be-returned",
      }),
    };
  });
  assert.deepEqual(result, {
    authenticated: true,
    tokenValid: true,
    refreshTokenValid: true,
  });
  assert.equal(JSON.stringify(result).includes("corp"), false);
  await assert.rejects(
    () => checkDwsRuntime("dws", async () => ({
      stdout: JSON.stringify({ success: true, authenticated: false }),
    })),
    /not ready/u,
  );
});

test("gbrain runtime check only returns a validated version", async () => {
  const result = await checkGbrainRuntime("gbrain", async (path, args, options) => {
    assert.equal(path, "gbrain");
    assert.deepEqual(args, ["version"]);
    assert.equal(options.env.AI_EMPLOYEE_DATA_KEY, undefined);
    return { stdout: "gbrain 0.30.2\n" };
  });
  assert.deepEqual(result, { required: true, version: "0.30.2" });
  await assert.rejects(
    () => checkGbrainRuntime("gbrain", async () => ({ stdout: "unknown\n" })),
    /invalid version/u,
  );
});

test("生产计划启用知识页读取时预检强制验证 gbrain", async () => {
  const calls = [];
  const config = validConfig({
    capabilities: new Set(["work_plan_execution"]),
  });
  const result = await checkProductionReadiness({
    config,
    environment: { AI_EMPLOYEE_BACKUP_KEY: backupKey },
    manifestLoader: async () => new Map([["project", {
      capabilities: { knowledge_read: { mode: "automatic" } },
    }]]),
    executableChecker: async (name, path) => calls.push([name, path]),
    codexChecker: async () => ({ status: "ok" }),
    dwsChecker: async () => ({ authenticated: true }),
    gbrainChecker: async (path) => {
      calls.push(["gbrain-runtime", path]);
      return { required: true, version: "0.30.2" };
    },
    createPool: () => ({ async end() {} }),
    checkDatabase: async () => ({ database: true }),
  });
  assert.deepEqual(result.gbrainRuntime, { required: true, version: "0.30.2" });
  assert.equal(calls.some(([name]) => name === "gbrain"), true);
  assert.equal(calls.some(([name]) => name === "gbrain-runtime"), true);
});

test("未启用知识页读取时预检不要求安装 gbrain", async () => {
  const calls = [];
  const result = await checkProductionReadiness({
    config: validConfig(),
    environment: { AI_EMPLOYEE_BACKUP_KEY: backupKey },
    executableChecker: async (name) => calls.push(name),
    codexChecker: async () => ({ status: "ok" }),
    dwsChecker: async () => ({ authenticated: true }),
    gbrainChecker: async () => {
      throw new Error("must not run");
    },
    createPool: () => ({ async end() {} }),
    checkDatabase: async () => ({ database: true }),
  });
  assert.deepEqual(result.gbrainRuntime, { required: false });
  assert.equal(calls.includes("gbrain"), false);
});
