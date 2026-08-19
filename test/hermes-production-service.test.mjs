import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertHermesWriterBoundary,
  buildHermesGatewayEnvironment,
  hermesCheckpointCurrentlyHealthy,
  hermesCheckpointFresh,
  hermesGatewayPid,
  hermesGatewayOwnedByService,
  hermesGatewayPlan,
  narrowHermesTargets,
  renderHermesGatewayLaunchAgent,
  validateHermesProjectRegistry,
  validateHermesProductionPaths,
} from "../src/hermes-production-service.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(
    tmpdir(),
    "foursday-hermes-production-",
  )));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const runtimeRoot = join(root, "runtime");
  const patchedSource = join(runtimeRoot, "patched");
  const venvBin = join(runtimeRoot, "venv", "bin");
  const hermesHome = join(runtimeRoot, "state", ".hermes");
  const stateDirectory = join(runtimeRoot, "state");
  const fallbackWorkspace = join(root, "fallback");
  const projectWorkspace = join(root, "project");
  await Promise.all([
    mkdir(join(patchedSource, "hermes_cli"), { recursive: true, mode: 0o700 }),
    mkdir(venvBin, { recursive: true, mode: 0o700 }),
    mkdir(hermesHome, { recursive: true, mode: 0o700 }),
    mkdir(fallbackWorkspace, { recursive: true, mode: 0o700 }),
    mkdir(projectWorkspace, { recursive: true, mode: 0o700 }),
  ]);
  await chmod(runtimeRoot, 0o700);
  await chmod(stateDirectory, 0o700);
  await chmod(hermesHome, 0o700);
  await writeFile(join(patchedSource, "hermes_cli", "main.py"), "# fixture\n", { mode: 0o600 });
  await writeFile(join(runtimeRoot, "venv", "pyvenv.cfg"), "home = /usr/bin\n", { mode: 0o600 });
  await symlink(process.execPath, join(venvBin, "python"));
  const projectRegistry = join(stateDirectory, "projects.production.json");
  const productionConfig = join(root, "production.json");
  const dwsSidecar = join(root, "dws-sidecar.mjs");
  const memorySidecar = join(root, "memory-sidecar.mjs");
  const gatewayLauncher = join(root, "gateway-launcher.mjs");
  for (const [path, content] of [
    [projectRegistry, `${JSON.stringify({
      schemaVersion: 1,
      projects: [{
        id: "project",
        name: "Project",
        aliases: ["project"],
        root: projectWorkspace,
        gbrainSlugs: [],
        isolation: "read-only",
      }],
    })}\n`],
    [productionConfig, "{}\n"],
    [dwsSidecar, "// fixture\n"],
    [memorySidecar, "// fixture\n"],
    [gatewayLauncher, "// fixture\n"],
  ]) await writeFile(path, content, { mode: 0o600 });
  return validateHermesProductionPaths({
    runtimeRoot,
    patchedSource,
    hermesHome,
    pythonPath: join(venvBin, "python"),
    projectRegistry,
    fallbackWorkspace,
    productionConfig,
    nodePath: process.execPath,
    dwsPath: process.execPath,
    dwsSidecar,
    memorySidecar,
    gatewayLauncher,
  });
}

test("Hermes shadow Gateway 使用固定路径且绝不开放发送", async (t) => {
  const paths = await fixture(t);
  assert.match(paths.pythonPath, /\/venv\/bin\/python$/u);
  const environment = buildHermesGatewayEnvironment({
    mode: "shadow",
    paths,
    config: {
      targetUserIds: ["trusted-user", "trusted-user"],
      targetGroupIds: ["trusted-group"],
      selfUserId: "owner",
      dingtalkRoot: "/private/tmp/dingtalk",
      fallbackMs: 30_000,
      quietWindowMs: 3_000,
      bundleMaxWaitMs: 8_000,
      codexPath: "/trusted/codex/bin/codex",
      databaseUrl: "postgresql://must-not-leak",
      dataKey: "must-not-leak",
      adminWriteToken: "must-not-leak",
    },
    baseEnvironment: {
      USER: "tester",
      HOME: paths.fallbackWorkspace,
      GH_TOKEN: "must-not-leak",
      DATABASE_URL: "must-not-leak",
    },
  });
  assert.equal(environment.DWS_PERSONAL_SEND_ENABLED, "false");
  assert.equal(environment.FOURSDAY_HERMES_MODE, "shadow");
  assert.equal(environment.FOURSDAY_DWS_HOME, paths.fallbackWorkspace);
  assert.equal(environment.FOURSDAY_MEMORY_HOME, paths.fallbackWorkspace);
  assert.notEqual(environment.HOME, environment.FOURSDAY_DWS_HOME);
  assert.equal(
    environment.PYTHONPATH,
    `${paths.patchedSource}:${join(paths.hermesHome, "plugins")}`,
  );
  assert.equal(environment.DWS_PERSONAL_ALLOWED_USERS, "trusted-user");
  assert.equal(environment.DWS_PERSONAL_ALLOWED_GROUPS, "trusted-group");
  assert.equal(environment.PATH.split(":").includes("/trusted/codex/bin"), true);
  assert.match(
    environment.FOURSDAY_SHADOW_EVIDENCE_FILE,
    /shadow-evidence\.jsonl$/u,
  );
  for (const forbidden of [
    "GH_TOKEN",
    "DATABASE_URL",
    "AI_EMPLOYEE_DATA_KEY",
    "AI_EMPLOYEE_ADMIN_WRITE_TOKEN",
  ]) assert.equal(forbidden in environment, false);
  assert.doesNotMatch(JSON.stringify(environment), /must-not-leak/u);

  const plist = renderHermesGatewayLaunchAgent({
    paths,
    environment,
    stdoutPath: join(paths.hermesHome, "gateway.log"),
    stderrPath: join(paths.hermesHome, "gateway.error.log"),
  });
  assert.match(plist, new RegExp(paths.nodePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(plist, /gateway-launcher\.mjs/u);
  assert.doesNotMatch(plist, /<string>gateway<\/string>\s*<string>run<\/string>/u);
  assert.match(
    plist,
    /<key>DWS_PERSONAL_SEND_ENABLED<\/key>\s*<string>false<\/string>/u,
  );
  assert.doesNotMatch(plist, /must-not-leak/u);

  const plan = hermesGatewayPlan({ mode: "shadow", paths, environment });
  assert.equal(plan.sendEnabled, false);
  assert.equal(plan.productionWrite, false);
  assert.equal("environment" in plan, false);
  assert.doesNotMatch(JSON.stringify(plan), /trusted-user|trusted-group/u);
});

test("Hermes active 模式在旧写入服务停止前失败关闭", () => {
  assert.throws(
    () => assertHermesWriterBoundary({
      mode: "active",
      legacyServiceStates: {
        listener: "running",
        worker: "stopped",
        executor: "stopped",
        proactive: "stopped",
      },
    }),
    /legacy writers to be stopped/u,
  );
  assert.deepEqual(
    assertHermesWriterBoundary({
      mode: "active",
      legacyServiceStates: {
        listener: "stopped",
        worker: "stopped",
        executor: "stopped",
        proactive: "stopped",
      },
    }),
    { mode: "active", sendEnabled: true },
  );
});

test("Hermes shadow 监听覆盖只能收窄生产白名单", () => {
  assert.deepEqual(
    narrowHermesTargets(["one", "two"], "two", "shadow users"),
    ["two"],
  );
  assert.deepEqual(
    narrowHermesTargets(["one", "two"], "", "shadow users"),
    ["one", "two"],
  );
  assert.throws(
    () => narrowHermesTargets(["one"], "unknown", "shadow users"),
    /subset of the production allowlist/u,
  );
});

test("Hermes Gateway 只有进程存活且 DWS 检查点新鲜私有时才健康", () => {
  const startedAt = Date.now();
  const metadata = {
    isFile: () => true,
    mode: 0o100600,
    mtimeMs: startedAt,
  };
  const state = {
    lastFullSuccessAt: new Date(startedAt).toISOString(),
    lastErrorCount: 0,
  };
  assert.equal(hermesCheckpointFresh({ metadata, state, startedAt }), true);
  assert.equal(hermesCheckpointFresh({
    metadata: { ...metadata, mode: 0o100644 },
    state,
    startedAt,
  }), false);
  assert.equal(hermesCheckpointFresh({
    metadata: { ...metadata, mtimeMs: startedAt - 10_000 },
    state,
    startedAt,
  }), false);
  assert.equal(hermesCheckpointFresh({
    metadata,
    state: { ...state, lastErrorCount: 1 },
    startedAt,
  }), false);
  assert.equal(hermesCheckpointFresh({ metadata: null, state, startedAt }), false);
  assert.equal(hermesCheckpointCurrentlyHealthy({
    metadata,
    state,
    now: startedAt + 30_000,
    maxAgeMs: 60_000,
  }), true);
  assert.equal(hermesCheckpointCurrentlyHealthy({
    metadata,
    state,
    now: startedAt + 120_000,
    maxAgeMs: 60_000,
  }), false);
});

test("Hermes Gateway PID 必须绑定官方 JSON 记录和当前 home", () => {
  const home = "/private/tmp/hermes-home";
  assert.equal(hermesGatewayPid({
    pid: 1234,
    kind: "hermes-gateway",
    hermes_home: home,
  }, home), 1234);
  assert.equal(hermesGatewayPid("1234", home), null);
  assert.equal(hermesGatewayPid({
    pid: 1234,
    kind: "hermes-gateway",
    hermes_home: "/private/tmp/other",
  }, home), null);
  assert.equal(hermesGatewayPid({
    pid: 1234,
    kind: "other",
    hermes_home: home,
  }, home), null);
});

test("Hermes Gateway PID 必须是 launchd Node supervisor 的直接子进程", () => {
  assert.equal(hermesGatewayOwnedByService({
    gatewayPid: 200,
    servicePid: 100,
    parentPid: 100,
  }), true);
  assert.equal(hermesGatewayOwnedByService({
    gatewayPid: 200,
    servicePid: 100,
    parentPid: 1,
  }), false);
  assert.equal(hermesGatewayOwnedByService({
    gatewayPid: 200,
    servicePid: null,
    parentPid: 100,
  }), false);
});

test("Hermes shadow 注册表拒绝可写项目和与项目重叠的 fallback", async (t) => {
  const paths = await fixture(t);
  const document = JSON.parse(await readFile(paths.projectRegistry, "utf8"));
  assert.equal((await validateHermesProjectRegistry({
    projectRegistry: paths.projectRegistry,
    fallbackWorkspace: paths.fallbackWorkspace,
    mode: "shadow",
  })).projectCount, 1);

  document.projects[0].isolation = "workspace-write";
  await writeFile(paths.projectRegistry, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  await assert.rejects(
    validateHermesProjectRegistry({
      projectRegistry: paths.projectRegistry,
      fallbackWorkspace: paths.fallbackWorkspace,
      mode: "shadow",
    }),
    /every project read-only/u,
  );

  document.projects[0].isolation = "read-only";
  await writeFile(paths.projectRegistry, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  await assert.rejects(
    validateHermesProjectRegistry({
      projectRegistry: paths.projectRegistry,
      fallbackWorkspace: document.projects[0].root,
      mode: "shadow",
    }),
    /fallback workspace must be outside/u,
  );
});

test("Hermes 生产路径拒绝宽权限配置和符号链接运行根", async (t) => {
  const paths = await fixture(t);
  await assert.rejects(
    validateHermesProductionPaths({ ...paths, pythonPath: process.execPath }),
    /candidate virtualenv entrypoint/u,
  );
  await chmod(paths.productionConfig, 0o644);
  await assert.rejects(
    validateHermesProductionPaths(paths),
    /production config must not be group or world accessible/u,
  );

  const outside = await mkdtemp(join(tmpdir(), "foursday-hermes-symlink-"));
  const linked = join(tmpdir(), `foursday-hermes-linked-${process.pid}-${Date.now()}`);
  t.after(() => rm(outside, { recursive: true, force: true }));
  t.after(() => rm(linked, { force: true }));
  await symlink(outside, linked);
  await assert.rejects(
    validateHermesProductionPaths({ ...paths, runtimeRoot: linked }),
    /runtime root must be a canonical directory/u,
  );
});
