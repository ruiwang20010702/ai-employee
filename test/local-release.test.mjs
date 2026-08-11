import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  acquireLocalReleaseLock,
  assertOrdinaryReleaseMigrationBoundary,
  captureForwardBackupEvidence,
  captureReleaseIntegrity,
  clearPendingReleaseJournal,
  compareReleaseRuntimeIdentity,
  createLocalReleaseDependencies,
  githubCliEnvironment,
  inspectPendingReleaseJournal,
  minimalRuntimeEnvironment,
  normalizeGitHubRepository,
  npmInstallArguments,
  productionGitHubArguments,
  productionRepository,
  releaseVerificationEnvironment,
  reconcilePendingLocalRelease,
  resolveTrustedReleaseTool,
  runLocalAtomicRelease,
  updatePendingReleaseJournal,
  validateAndCopyProductionConfig,
  verifyReleaseAgainstCommit,
  verifyReleaseIntegrity,
  verifyReleaseIntegrityDigest,
  verifyReleaseRuntimeIdentityBinding,
  verifyLocalReleaseCheckout,
  writePendingReleaseJournal,
} from "../scripts/本机版本发布.mjs";

const sha = "a".repeat(40);
const previousSha = "c".repeat(40);
const runtimeBindingDigests = Object.freeze({
  targetConfigDigest: "d".repeat(64),
  previousConfigDigest: "e".repeat(64),
  targetIdentityDigest: "f".repeat(64),
  previousIdentityDigest: "f".repeat(64),
});
const pendingDigests = Object.freeze({
  integrityDigest: "b".repeat(64),
  previousIntegrityDigest: "c".repeat(64),
  ...runtimeBindingDigests,
});
const releaseOptions = Object.freeze({
  sha,
  root: "/var/tmp/ai-employee-production",
  sourceDirectory: "/workspace/ai-employee",
  configPath: "/secure/production.json",
  runId: "101",
  attempt: "1",
});
const gitSafetyArguments = Object.freeze([
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
]);

function gitOperationArguments(command, args, options) {
  assert.equal(command, "/usr/bin/git");
  assert.deepEqual(args.slice(0, gitSafetyArguments.length), gitSafetyArguments);
  assert.equal(options.env.HOME, "/var/empty");
  for (const key of Object.keys(options.env)) {
    assert.equal(key.startsWith("GIT_"), false, key);
    assert.equal(key.startsWith("GH_"), false, key);
  }
  assert.equal(Object.hasOwn(options.env, "SSH_AUTH_SOCK"), false);
  assert.equal(Object.hasOwn(options.env, "TAR_OPTIONS"), false);
  return args.slice(gitSafetyArguments.length);
}

async function createProtectedRelease(root, name) {
  const releaseDirectory = join(root, "releases", name);
  await mkdir(join(releaseDirectory, ".runtime"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(join(releaseDirectory, "package.json"), "{}\n");
  await writeFile(
    join(releaseDirectory, ".runtime", "production.json"),
    "{}\n",
    { mode: 0o600 },
  );
  await chmod(join(releaseDirectory, ".runtime", "production.json"), 0o600);
  return realpath(releaseDirectory);
}

async function createMigrationRelease(root, name, { supports018 = false } = {}) {
  const releaseDirectory = join(root, name);
  const migrations = join(releaseDirectory, "db", "migrations");
  await mkdir(migrations, { recursive: true, mode: 0o700 });
  await writeFile(join(releaseDirectory, "package.json"), "{}\n");
  if (supports018) {
    await writeFile(
      join(migrations, "018_能力次数预算.sql"),
      "SELECT 1;\n",
    );
  }
  return realpath(releaseDirectory);
}

async function createSymlinkedMigrationRelease(root, name, linkLevel) {
  const releaseDirectory = join(root, name);
  const outside = join(root, `${name}-outside`);
  await mkdir(releaseDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(releaseDirectory, "package.json"), "{}\n");
  if (linkLevel === "db") {
    await mkdir(join(outside, "migrations"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(outside, "migrations", "018_能力次数预算.sql"),
      "SELECT 1;\n",
    );
    await symlink(outside, join(releaseDirectory, "db"));
  } else if (linkLevel === "migrations") {
    await mkdir(join(releaseDirectory, "db"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(outside, { recursive: true, mode: 0o700 });
    await writeFile(
      join(outside, "018_能力次数预算.sql"),
      "SELECT 1;\n",
    );
    await symlink(outside, join(releaseDirectory, "db", "migrations"));
  } else if (linkLevel === "migration") {
    const migrations = join(releaseDirectory, "db", "migrations");
    await mkdir(migrations, { recursive: true, mode: 0o700 });
    await mkdir(outside, { recursive: true, mode: 0o700 });
    const outsideMigration = join(outside, "018.sql");
    await writeFile(outsideMigration, "SELECT 1;\n");
    await symlink(
      outsideMigration,
      join(migrations, "018_能力次数预算.sql"),
    );
  } else {
    throw new Error(`unknown link level: ${linkLevel}`);
  }
  return realpath(releaseDirectory);
}

const fakeReleaseRoot = await realpath(
  await mkdtemp(join(tmpdir(), "ai-employee-local-release-fixture-")),
);
const fakePreviousRelease = await createMigrationRelease(
  fakeReleaseRoot,
  "previous",
  { supports018: true },
);
const fakeTargetRelease = await createMigrationRelease(
  fakeReleaseRoot,
  "target",
  { supports018: true },
);
after(() => rm(fakeReleaseRoot, { recursive: true, force: true }));

function pendingReleaseRecord(overrides = {}) {
  return {
    token: "11111111-1111-4111-8111-111111111111",
    sha,
    previousSha,
    previousRelease: fakePreviousRelease,
    targetRelease: fakeTargetRelease,
    ...pendingDigests,
    ...overrides,
  };
}

function fakeDependencies(events, {
  failAt = "",
  previousRelease = fakePreviousRelease,
  targetRelease = fakeTargetRelease,
} = {}) {
  const failures = new Set(Array.isArray(failAt) ? failAt : [failAt]);
  function operation(name, result) {
    return async () => {
      events.push(name);
      if (failures.has(name)) throw new Error(`simulated ${name} failure`);
      return result;
    };
  }
  function releaseOperation(name, result) {
    return async ({ releaseDirectory }) => {
      const displayDirectory = releaseDirectory === fakeTargetRelease
        ? "/releases/new"
        : releaseDirectory === fakePreviousRelease
          ? "/releases/old"
          : releaseDirectory;
      const event = `${name}:${displayDirectory}`;
      events.push(event);
      if (failures.has(event)) throw new Error(`simulated ${event} failure`);
      return result;
    };
  }
  return {
    verifyLoginSession: operation("login"),
    verifyCheckout: operation("checkout", { clean: true, headSha: sha }),
    verifyCloudGate: operation("cloud", { valid: true, headSha: sha }),
    async acquireReleaseLock() {
      events.push("lock");
      if (failures.has("lock")) throw new Error("simulated lock failure");
      return {
        async release() {
          events.push("unlock");
        },
      };
    },
    inspectPendingRelease: operation("inspect-pending", null),
    readCurrentRelease: operation("read-current", previousRelease),
    verifyPendingReleaseIntegrity: operation("verify-pending-integrity", {
      valid: true,
    }),
    verifyPreviousReleaseAgainstCommit: operation("verify-previous-commit", {
      valid: true,
      sha: previousSha,
      integrityDigest: pendingDigests.previousIntegrityDigest,
    }),
    verifyPreviousReleaseIntegrity: operation("verify-previous-integrity", {
      valid: true,
    }),
    compareReleaseRuntimeIdentity: operation(
      "compare-runtime-identity",
      runtimeBindingDigests,
    ),
    verifyReleaseRuntimeIdentityBinding: operation(
      "verify-runtime-binding",
      { valid: true },
    ),
    async writePendingRelease({ mode = "atomic", phase = "service_switch_started" }) {
      events.push("write-pending");
      if (failures.has("write-pending")) {
        throw new Error("simulated write-pending failure");
      }
      return pendingReleaseRecord({
        previousRelease,
        targetRelease,
        mode,
        phase,
      });
    },
    clearPendingRelease: operation("clear-pending", { cleared: true }),
    prepareRelease: operation("prepare", {
      releaseDirectory: targetRelease,
      previousRelease,
    }),
    materializeRelease: operation("materialize"),
    captureReleaseIntegrity: operation("capture-integrity", {
      schema: "ai-employee-release-integrity/v1",
      entries: [],
    }),
    verifyReleaseIntegrity: operation("verify-integrity", { valid: true }),
    installDependencies: operation("install-dependencies"),
    auditRelease: operation("audit"),
    checkRelease: operation("check"),
    copyProductionConfig: operation(
      "copy-config",
      join(targetRelease, ".runtime", "production.json"),
    ),
    validateRollbackTarget: operation("rollback-target"),
    backupDatabase: operation("backup", {
      completed: true,
      backupRoot: "/var/tmp/ai-employee-production/backups",
      backupPath: "/var/tmp/ai-employee-production/backups/forward.dump.enc",
      metadataPath: "/var/tmp/ai-employee-production/backups/forward.dump.enc.json",
    }),
    restoreBackupDrill: operation("restore-drill", {
      restored: true,
      isolated: true,
    }),
    captureForwardBackupEvidence: operation("capture-backup-evidence", {
      backupRoot: "/var/tmp/ai-employee-production/backups",
      backupPath: "/var/tmp/ai-employee-production/backups/forward.dump.enc",
      metadataPath: "/var/tmp/ai-employee-production/backups/forward.dump.enc.json",
      backupDigest: "1".repeat(64),
      metadataDigest: "2".repeat(64),
    }),
    verifyForwardBackupEvidence: operation("verify-backup-evidence", {
      valid: true,
    }),
    migrateDatabase: operation("migrate"),
    runDoctor: operation("doctor"),
    runCodexProbe: operation("codex-probe"),
    installService: releaseOperation("service-install"),
    cleanupServices: releaseOperation("service-cleanup"),
    verifyService: releaseOperation("service-verify"),
    activateRelease: releaseOperation("activate", { activated: true }),
    rollbackStateGuard: releaseOperation("rollback-state-guard"),
    runForwardPreflight: operation("forward-preflight", { valid: true }),
    validateForwardBackupRoot: operation("validate-backup-root", { valid: true }),
    pauseSystem: operation("pause", { paused: true }),
    inspectForwardMaintenanceState: operation("forward-state", {
      safe: true,
      paused: true,
    }),
    stopServicesForMaintenance: operation("stop-services", {
      stopped: true,
      forwardOnly: true,
    }),
    installForwardOnlyService: releaseOperation("forward-service-install", {
      installed: true,
      forwardOnly: true,
    }),
    async updatePendingRelease({ phase, backupEvidence }) {
      events.push("update-pending");
      if (failures.has("update-pending")) {
        throw new Error("simulated update-pending failure");
      }
      return pendingReleaseRecord({
        previousRelease,
        targetRelease,
        mode: phase.startsWith("forward_") ? "forward_only" : "atomic",
        phase,
        ...(backupEvidence ?? {}),
      });
    },
  };
}

test("本机版本发布默认只返回计划且不调用任何依赖", async () => {
  const events = [];
  const result = await runLocalAtomicRelease({
    ...releaseOptions,
    dependencies: fakeDependencies(events),
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.executed, false);
  assert.equal(result.applyRequired, true);
  assert.equal(events.length, 0);
  assert.match(result.forwardOnlyBoundary, /第 018 号迁移/u);
  assert.match(result.forwardOnlyBoundary, /本脚本不提供前滚旁路/u);
  assert.match(result.rollback, /绝不自动恢复或反向迁移数据库/u);
  await assert.rejects(
    runLocalAtomicRelease({ ...releaseOptions, sha: "main" }),
    /40 位小写 SHA/u,
  );
});

test("普通 apply 在 target 有 018 而 previous 无 018 时于生产动作前阻断", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-forward-only-boundary-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const targetRelease = await createMigrationRelease(
    directory,
    "target",
    { supports018: true },
  );
  const previousRelease = await createMigrationRelease(
    directory,
    "previous",
  );
  const events = [];
  const dependencies = fakeDependencies(events, {
    targetRelease,
    previousRelease,
  });
  let injectedBoundaryCalled = false;
  dependencies.assertOrdinaryReleaseMigrationBoundary = async () => {
    injectedBoundaryCalled = true;
    return { targetSupports018: false, previousSupports018: true };
  };

  await assert.rejects(
    runLocalAtomicRelease({
      ...releaseOptions,
      apply: true,
      forwardOnly: true,
      dependencies,
    }),
    /普通本机发布已阻止.*显式授权的维护\/前滚流程.*不提供前滚旁路/u,
  );

  assert.equal(injectedBoundaryCalled, false);
  assert.ok(
    events.indexOf("verify-previous-integrity") >
      events.indexOf("verify-previous-commit"),
  );
  assert.equal(
    events.filter((event) => event === "verify-integrity").length,
    2,
  );
  for (const forbidden of [
    "copy-config",
    "compare-runtime-identity",
    "rollback-target",
    "backup",
    "migrate",
    "doctor",
    "codex-probe",
  ]) {
    assert.equal(events.includes(forbidden), false, forbidden);
  }
  assert.equal(
    events.some((event) => event.startsWith("service-")),
    false,
  );
  assert.equal(events.at(-2), "verify-previous-integrity");
  assert.equal(events.at(-1), "unlock");
});

test("维护前滚必须使用绑定目标 SHA 的精确不可回退确认", async () => {
  for (const forwardConfirmation of ["", `I_ACCEPT_FORWARD_ONLY:${"b".repeat(40)}`]) {
    const events = [];
    await assert.rejects(
      runLocalAtomicRelease({
        ...releaseOptions,
        apply: true,
        maintenanceForward: true,
        forwardConfirmation,
        dependencies: fakeDependencies(events),
      }),
      /必须绑定目标 SHA 的不可回退确认值/u,
    );
    assert.deepEqual(events, []);
  }
});

test("维护前滚按暂停、零在途、停服、恢复演练、迁移和前滚安装顺序完成且保持暂停", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-maintenance-forward-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const targetRelease = await createMigrationRelease(
    directory,
    "target",
    { supports018: true },
  );
  const previousRelease = await createMigrationRelease(directory, "previous");
  const events = [];
  const dependencies = fakeDependencies(events, {
    targetRelease,
    previousRelease,
  });

  const result = await runLocalAtomicRelease({
    ...releaseOptions,
    apply: true,
    maintenanceForward: true,
    forwardConfirmation: `I_ACCEPT_FORWARD_ONLY:${sha}`,
    dependencies,
  });

  assert.equal(result.released, true);
  assert.equal(result.forwardOnly, true);
  assert.equal(result.paused, true);
  assert.equal(result.databaseRollbackPerformed, false);
  const ordered = [
    "validate-backup-root",
    "forward-preflight",
    "pause",
    "forward-state",
    "write-pending",
    "forward-state",
    "stop-services",
    "forward-state",
    "backup",
    "restore-drill",
    "capture-backup-evidence",
    "update-pending",
    "migrate",
    "update-pending",
    "verify-backup-evidence",
    "doctor",
    "codex-probe",
    `forward-service-install:${targetRelease}`,
    `activate:${targetRelease}`,
    "clear-pending",
  ];
  let cursor = -1;
  for (const event of ordered) {
    const next = events.indexOf(event, cursor + 1);
    assert.ok(next > cursor, `${event} must follow ${events[cursor] ?? "start"}`);
    cursor = next;
  }
  assert.equal(
    events.some((event) => event.startsWith("service-install:/releases/old")),
    false,
  );
  assert.equal(
    events.some((event) => event.startsWith("rollback-state-guard:")),
    false,
  );
});

test("维护前滚迁移后失败保留中断记录且绝不恢复 0.2", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-maintenance-forward-failure-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const targetRelease = await createMigrationRelease(
    directory,
    "target",
    { supports018: true },
  );
  const previousRelease = await createMigrationRelease(directory, "previous");
  const events = [];
  const dependencies = fakeDependencies(events, {
    targetRelease,
    previousRelease,
    failAt: "doctor",
  });

  await assert.rejects(
    runLocalAtomicRelease({
      ...releaseOptions,
      apply: true,
      maintenanceForward: true,
      forwardConfirmation: `I_ACCEPT_FORWARD_ONLY:${sha}`,
      dependencies,
    }),
    /已保留中断记录.*保持暂停.*只允许继续前滚/u,
  );
  assert.ok(events.includes("migrate"));
  assert.equal(events.includes("clear-pending"), false);
  assert.equal(events.some((event) => event === "pause"), true);
  assert.equal(
    events.some((event) => event.startsWith("service-install:/releases/old")),
    false,
  );
  assert.equal(
    events.some((event) => event.startsWith("activate:/releases/old")),
    false,
  );
  assert.equal(
    events.some((event) => event.startsWith("rollback-state-guard:")),
    false,
  );
});

test("维护前滚在暂停生产前拒绝不安全的备份根目录", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-forward-backup-root-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const targetRelease = await createMigrationRelease(
    directory,
    "target",
    { supports018: true },
  );
  const previousRelease = await createMigrationRelease(directory, "previous");
  const events = [];
  const dependencies = fakeDependencies(events, {
    targetRelease,
    previousRelease,
    failAt: "validate-backup-root",
  });

  await assert.rejects(
    runLocalAtomicRelease({
      ...releaseOptions,
      apply: true,
      maintenanceForward: true,
      forwardConfirmation: `I_ACCEPT_FORWARD_ONLY:${sha}`,
      dependencies,
    }),
    /进入维护暂停前停止；未执行数据库迁移或回退/u,
  );
  assert.equal(events.includes("validate-backup-root"), true);
  assert.equal(events.includes("pause"), false);
  assert.equal(events.includes("backup"), false);
  assert.equal(events.includes("migrate"), false);
});

test("target 与 previous 都有固定 018 文件时普通发布保持原流程", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-supported-018-boundary-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const targetRelease = await createMigrationRelease(
    directory,
    "target",
    { supports018: true },
  );
  const previousRelease = await createMigrationRelease(
    directory,
    "previous",
    { supports018: true },
  );
  const events = [];
  const dependencies = fakeDependencies(events, {
    targetRelease,
    previousRelease,
  });
  const result = await runLocalAtomicRelease({
    ...releaseOptions,
    apply: true,
    dependencies,
  });

  assert.equal(result.released, true);
  const verifiedPrevious = events.indexOf("verify-previous-integrity");
  assert.ok(verifiedPrevious < events.indexOf("copy-config"));
  assert.ok(verifiedPrevious < events.indexOf("backup"));
  assert.ok(verifiedPrevious < events.indexOf("migrate"));
  assert.ok(events.includes(`service-install:${targetRelease}`));
  assert.ok(events.includes(`activate:${targetRelease}`));
});

test("018 边界逐级拒绝 target 和 previous 的目录或固定文件符号链接", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-018-symlink-boundary-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ordinaryRelease = await createMigrationRelease(
    directory,
    "ordinary",
    { supports018: true },
  );
  const cases = [
    { level: "db", expected: /db 目录不能是符号链接/u },
    { level: "migrations", expected: /migrations 目录不能是符号链接/u },
    { level: "migration", expected: /固定迁移文件不能是符号链接/u },
  ];
  for (const role of ["target", "previous"]) {
    for (const item of cases) {
      const linkedRelease = await createSymlinkedMigrationRelease(
        directory,
        `${role}-${item.level}`,
        item.level,
      );
      await assert.rejects(
        assertOrdinaryReleaseMigrationBoundary({
          releaseDirectory: role === "target"
            ? linkedRelease
            : ordinaryRelease,
          previousRelease: role === "previous"
            ? linkedRelease
            : ordinaryRelease,
        }),
        item.expected,
      );
    }
  }
});

test("发布严格在云端门禁后接触配置和数据库并最终原子激活", async () => {
  const events = [];
  const result = await runLocalAtomicRelease({
    ...releaseOptions,
    apply: true,
    dependencies: fakeDependencies(events),
  });

  assert.deepEqual(events, [
    "login",
    "checkout",
    "cloud",
    "lock",
    "inspect-pending",
    "prepare",
    "verify-previous-commit",
    "materialize",
    "capture-integrity",
    "install-dependencies",
    "audit",
    "check",
    "verify-integrity",
    "install-dependencies",
    "verify-integrity",
    "verify-previous-integrity",
    "copy-config",
    "compare-runtime-identity",
    "rollback-target",
    "backup",
    "migrate",
    "doctor",
    "codex-probe",
    "verify-integrity",
    "install-dependencies",
    "verify-integrity",
    "verify-previous-integrity",
    "verify-runtime-binding",
    "write-pending",
    "service-install:/releases/new",
    "service-cleanup:/releases/new",
    "service-verify:/releases/new",
    "verify-integrity",
    "verify-previous-integrity",
    "verify-runtime-binding",
    "update-pending",
    "activate:/releases/new",
    "clear-pending",
    "unlock",
  ]);
  assert.ok(events.indexOf("cloud") < events.indexOf("copy-config"));
  assert.ok(events.indexOf("cloud") < events.indexOf("backup"));
  assert.equal(result.released, true);
  assert.equal(result.databaseRollbackPerformed, false);
});

test("云端结果即使成功但 SHA 不一致也不得准备版本或读取配置", async () => {
  const events = [];
  const dependencies = fakeDependencies(events);
  dependencies.verifyCloudGate = async () => {
    events.push("cloud");
    return { valid: true, headSha: "b".repeat(40) };
  };
  await assert.rejects(
    runLocalAtomicRelease({
      ...releaseOptions,
      apply: true,
      dependencies,
    }),
    /精确 SHA/u,
  );

  assert.deepEqual(events, ["login", "checkout", "cloud"]);
});

test("没有上一版本时禁止进入服务切换并且不安装任何新服务", async () => {
  const events = [];
  await assert.rejects(
    runLocalAtomicRelease({
      ...releaseOptions,
      apply: true,
      dependencies: fakeDependencies(events, { previousRelease: "" }),
    }),
    /没有可回退的上一版本/u,
  );

  assert.deepEqual(events, [
    "login",
    "checkout",
    "cloud",
    "lock",
    "inspect-pending",
    "prepare",
    "unlock",
  ]);
  assert.equal(events.some((event) => event.startsWith("service-install:")), false);
});

test("同一生产根目录只允许一个本机发布持有独占锁", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-release-lock-")),
  );
  const root = join(directory, "ai-employee-production");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await acquireLocalReleaseLock({ root, sha, runId: "1" });
  await assert.rejects(
    acquireLocalReleaseLock({ root, sha, runId: "2" }),
    /拒绝并发发布/u,
  );
  await first.release();
  const second = await acquireLocalReleaseLock({ root, sha, runId: "2" });
  await second.release();
});

test("进程被强杀后可立即接管遗留锁并进入中断对账", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-dead-release-lock-")),
  );
  const root = join(directory, "ai-employee-production");
  const lockDirectory = join(root, ".local-release-lock");
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(lockDirectory, "owner.json"),
    `${JSON.stringify({
      token: "dead-owner",
      pid: 2_147_483_647,
      sha,
      runId: "100",
      createdAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const releaseLock = await acquireLocalReleaseLock({
    root,
    sha,
    runId: "101",
  });
  await releaseLock.release();
  await assert.rejects(lstat(lockDirectory), /ENOENT/u);
});

test("生产根目录符号链接在任何锁写入或权限修改前被拒绝", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-release-symlink-")),
  );
  const outside = join(directory, "outside");
  const root = join(directory, "ai-employee-production");
  await mkdir(outside, { mode: 0o755 });
  await chmod(outside, 0o755);
  await symlink(outside, root);
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    acquireLocalReleaseLock({ root, sha, runId: "1" }),
    /不能是符号链接/u,
  );
  assert.equal((await stat(outside)).mode & 0o777, 0o755);
  await assert.rejects(stat(join(outside, ".local-release-lock")), /ENOENT/u);
});

test("中断发布记录以 600 权限原子替换并按令牌清理", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-pending-release-")),
  );
  const root = join(directory, "ai-employee-production");
  await mkdir(join(root, "releases"), { recursive: true, mode: 0o700 });
  const previousRelease = await createProtectedRelease(
    root,
    `${previousSha}-100-1`,
  );
  const targetRelease = await createProtectedRelease(root, `${sha}-101-1`);
  const integrityDigest = "b".repeat(64);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const created = await writePendingReleaseJournal({
    root,
    sha,
    runId: "101",
    attempt: "1",
    previousRelease,
    targetRelease,
    previousSha,
    ...pendingDigests,
    now: () => new Date("2026-08-10T10:00:00.000Z"),
  });
  const journalPath = join(root, ".pending-release.json");
  assert.equal((await lstat(journalPath)).mode & 0o777, 0o600);
  assert.equal(created.phase, "service_switch_started");
  assert.equal(created.integrityDigest, integrityDigest);
  assert.equal(created.previousSha, previousSha);
  assert.equal(
    created.previousIntegrityDigest,
    pendingDigests.previousIntegrityDigest,
  );
  assert.equal(created.targetConfigDigest, pendingDigests.targetConfigDigest);
  assert.equal(
    created.previousConfigDigest,
    pendingDigests.previousConfigDigest,
  );
  assert.equal(created.targetIdentityDigest, created.previousIdentityDigest);
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).token, created.token);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith(".tmp")),
    [],
  );

  const updated = await updatePendingReleaseJournal({
    root,
    token: created.token,
    phase: "service_verified",
  });
  assert.equal(updated.phase, "service_verified");
  assert.equal(
    (await inspectPendingReleaseJournal({ root })).token,
    created.token,
  );
  await assert.rejects(
    clearPendingReleaseJournal({ root, token: "wrong-token" }),
    /已变化/u,
  );
  await clearPendingReleaseJournal({ root, token: created.token });
  assert.equal(await inspectPendingReleaseJournal({ root }), null);
});

test("维护前滚 journal 绑定 600 权限备份与元数据摘要并拒绝篡改", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-forward-journal-")),
  );
  const root = join(directory, "ai-employee-production");
  await mkdir(join(root, "releases"), { recursive: true, mode: 0o700 });
  const previousRelease = await createProtectedRelease(
    root,
    `${previousSha}-100-1`,
  );
  const targetRelease = await createProtectedRelease(root, `${sha}-101-1`);
  const backupDirectory = join(root, "backups");
  await mkdir(backupDirectory, { mode: 0o700 });
  const backupPath = join(backupDirectory, "forward.dump.enc");
  const metadataPath = `${backupPath}.json`;
  await writeFile(backupPath, "encrypted-backup", { mode: 0o600 });
  await writeFile(metadataPath, "{}\n", { mode: 0o600 });
  await chmod(backupPath, 0o600);
  await chmod(metadataPath, 0o600);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const created = await writePendingReleaseJournal({
    root,
    sha,
    runId: "101",
    attempt: "1",
    previousRelease,
    targetRelease,
    previousSha,
    ...pendingDigests,
    mode: "forward_only",
    phase: "forward_prepared",
  });
  const evidence = await captureForwardBackupEvidence({
    root,
    backupRoot: backupDirectory,
    backupPath,
    metadataPath,
  });
  const updated = await updatePendingReleaseJournal({
    root,
    token: created.token,
    phase: "forward_backup_verified",
    backupEvidence: evidence,
  });
  assert.equal(updated.backupPath, backupPath);
  assert.equal(updated.metadataPath, metadataPath);
  assert.match(updated.backupDigest, /^[0-9a-f]{64}$/u);
  assert.match(updated.metadataDigest, /^[0-9a-f]{64}$/u);

  await writeFile(backupPath, "tampered-backup", { mode: 0o600 });
  await assert.rejects(
    inspectPendingReleaseJournal({ root }),
    /前滚备份证据已发生变化/u,
  );
  assert.equal((await lstat(join(root, ".pending-release.json"))).isFile(), true);
});

test("中断发布记录权限变宽后必须保留现场并拒绝读取", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-pending-permission-")),
  );
  const root = join(directory, "ai-employee-production");
  await mkdir(join(root, "releases"), { recursive: true, mode: 0o700 });
  const previousRelease = await createProtectedRelease(
    root,
    `${previousSha}-100-1`,
  );
  const targetRelease = await createProtectedRelease(root, `${sha}-101-1`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pending = await writePendingReleaseJournal({
    root,
    sha,
    runId: "101",
    attempt: "1",
    previousRelease,
    targetRelease,
    previousSha,
    ...pendingDigests,
  });
  const journalPath = join(root, ".pending-release.json");
  await chmod(journalPath, 0o644);

  await assert.rejects(
    inspectPendingReleaseJournal({ root }),
    /权限或文件类型不安全/u,
  );
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).token, pending.token);
});

test("关键运行身份只比较安全引用和 tenant 摘要且不泄露值", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-runtime-identity-")),
  );
  const root = join(directory, "ai-employee-production");
  await mkdir(join(root, "releases"), { recursive: true, mode: 0o700 });
  const targetRelease = await createProtectedRelease(root, `${sha}-101-1`);
  const previousRelease = await createProtectedRelease(
    root,
    `${previousSha}-100-1`,
  );
  const targetConfigPath = join(targetRelease, ".runtime", "production.json");
  const previousConfigPath = join(
    previousRelease,
    ".runtime",
    "production.json",
  );
  const identity = {
    DATABASE_URL: "keychain://safe-service/database-reference",
    AI_EMPLOYEE_DATA_KEY: "keychain://safe-service/data-reference",
    AI_EMPLOYEE_TENANT_ID: "sensitive-tenant-a",
  };
  await writeFile(
    targetConfigPath,
    `${JSON.stringify({ ...identity, AI_EMPLOYEE_HEALTH_PORT: 9465 })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    previousConfigPath,
    `${JSON.stringify({ ...identity, AI_EMPLOYEE_HEALTH_PORT: 9464 })}\n`,
    { mode: 0o600 },
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const binding = await compareReleaseRuntimeIdentity({
    targetConfigPath,
    previousConfigPath,
  });
  assert.equal(binding.targetIdentityDigest, binding.previousIdentityDigest);
  assert.notEqual(binding.targetConfigDigest, binding.previousConfigDigest);
  assert.doesNotMatch(JSON.stringify(binding), /safe-service|sensitive-tenant/u);

  await writeFile(
    targetConfigPath,
    `${JSON.stringify({
      ...identity,
      AI_EMPLOYEE_TENANT_ID: "sensitive-tenant-b",
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    compareReleaseRuntimeIdentity({ targetConfigPath, previousConfigPath }),
    (error) => {
      assert.match(error.message, /关键运行身份不一致/u);
      assert.doesNotMatch(error.message, /sensitive-tenant|safe-service/u);
      return true;
    },
  );
});

test("journal 绑定后任一版本配置被改写都在运行脚本前拒绝", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-runtime-binding-")),
  );
  const root = join(directory, "ai-employee-production");
  await mkdir(join(root, "releases"), { recursive: true, mode: 0o700 });
  const targetRelease = await createProtectedRelease(root, `${sha}-101-1`);
  const previousRelease = await createProtectedRelease(
    root,
    `${previousSha}-100-1`,
  );
  const targetConfigPath = join(targetRelease, ".runtime", "production.json");
  const previousConfigPath = join(
    previousRelease,
    ".runtime",
    "production.json",
  );
  const identity = {
    DATABASE_URL: "keychain://safe-service/database-reference",
    AI_EMPLOYEE_DATA_KEY: "keychain://safe-service/data-reference",
    AI_EMPLOYEE_TENANT_ID: "tenant-a",
  };
  await writeFile(targetConfigPath, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  await writeFile(previousConfigPath, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  const expected = await compareReleaseRuntimeIdentity({
    targetConfigPath,
    previousConfigPath,
  });
  await writeFile(
    previousConfigPath,
    `${JSON.stringify({ ...identity, AI_EMPLOYEE_HEALTH_PORT: 9465 })}\n`,
    { mode: 0o600 },
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    verifyReleaseRuntimeIdentityBinding({
      targetConfigPath,
      previousConfigPath,
      expected,
    }),
    /版本配置或关键运行身份已发生变化/u,
  );
});

test("上一版本必须与目录名中的 40 位 Git 提交内容完全一致", async (t) => {
  const sourceDirectory = process.cwd();
  const commitSha = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: sourceDirectory,
    encoding: "utf8",
  }).trim();
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-previous-commit-")),
  );
  const releaseDirectory = join(directory, `${commitSha}-100-1`);
  const archive = join(directory, "source.tar");
  const fakeBin = join(directory, "fake-bin");
  const fakeGitMarker = join(directory, "fake-git-called");
  const fakeTarMarker = join(directory, "fake-tar-called");
  await mkdir(releaseDirectory, { mode: 0o700 });
  await mkdir(fakeBin, { mode: 0o700 });
  execFileSync(
    "/usr/bin/git",
    ["archive", "--format=tar", "--output", archive, commitSha],
    { cwd: sourceDirectory, stdio: "ignore" },
  );
  execFileSync("/usr/bin/tar", ["-xf", archive, "-C", releaseDirectory], {
    stdio: "ignore",
  });
  await writeFile(
    join(fakeBin, "git"),
    `#!/bin/sh\n/usr/bin/touch '${fakeGitMarker}'\nexit 97\n`,
    { mode: 0o700 },
  );
  await writeFile(
    join(fakeBin, "tar"),
    `#!/bin/sh\n/usr/bin/touch '${fakeTarMarker}'\nexit 98\n`,
    { mode: 0o700 },
  );
  const injectedEnvironment = {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    GIT_CONFIG: join(directory, "missing-git-config"),
    GIT_CONFIG_GLOBAL: join(directory, "missing-global-git-config"),
    GIT_DIR: join(directory, "missing-git-dir"),
    GIT_WORK_TREE: join(directory, "missing-work-tree"),
    SSH_AUTH_SOCK: join(directory, "fake-ssh-agent"),
    TAR_OPTIONS: "--this-option-must-not-be-read",
  };
  const previousEnvironment = Object.fromEntries(
    Object.keys(injectedEnvironment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, injectedEnvironment);
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const verified = await verifyReleaseAgainstCommit({
    releaseDirectory,
    sourceDirectory,
    sha: commitSha,
  });
  assert.equal(verified.sha, commitSha);
  assert.match(verified.integrityDigest, /^[0-9a-f]{64}$/u);
  await assert.rejects(lstat(fakeGitMarker), /ENOENT/u);
  await assert.rejects(lstat(fakeTarMarker), /ENOENT/u);

  await writeFile(join(releaseDirectory, "package.json"), "{}\n");
  await assert.rejects(
    verifyReleaseAgainstCommit({
      releaseDirectory,
      sourceDirectory,
      sha: commitSha,
    }),
    /偏离其固定的 40 位提交/u,
  );
});

test("精确提交完整性门禁拒绝任何可逃逸版本目录的符号链接", async (t) => {
  const releaseDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-release-symlink-source-")),
  );
  await writeFile(join(releaseDirectory, "package.json"), "{}\n");
  await symlink("/private/tmp", join(releaseDirectory, "mutable-source"));
  t.after(() => rm(releaseDirectory, { recursive: true, force: true }));

  await assert.rejects(
    captureReleaseIntegrity({ releaseDirectory }),
    /不允许包含符号链接/u,
  );
});

test("上一版本的 .runtime 中间路径不能通过符号链接逃逸", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-runtime-symlink-")),
  );
  const root = join(directory, "ai-employee-production");
  await mkdir(join(root, "releases"), { recursive: true, mode: 0o700 });
  const targetRelease = await createProtectedRelease(root, `${sha}-101-1`);
  const previousRelease = await createProtectedRelease(
    root,
    `${previousSha}-100-1`,
  );
  const escapedRuntime = join(directory, "escaped-runtime");
  const identity = {
    DATABASE_URL: "keychain://safe-service/database-reference",
    AI_EMPLOYEE_DATA_KEY: "keychain://safe-service/data-reference",
    AI_EMPLOYEE_TENANT_ID: "tenant-a",
  };
  await writeFile(
    join(targetRelease, ".runtime", "production.json"),
    `${JSON.stringify(identity)}\n`,
    { mode: 0o600 },
  );
  await mkdir(escapedRuntime, { mode: 0o700 });
  await writeFile(
    join(escapedRuntime, "production.json"),
    `${JSON.stringify(identity)}\n`,
    { mode: 0o600 },
  );
  await rm(join(previousRelease, ".runtime"), { recursive: true });
  await symlink(escapedRuntime, join(previousRelease, ".runtime"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    compareReleaseRuntimeIdentity({
      targetConfigPath: join(targetRelease, ".runtime", "production.json"),
      previousConfigPath: join(
        previousRelease,
        ".runtime",
        "production.json",
      ),
    }),
    /路径不在受控运行目录/u,
  );
  await assert.rejects(
    writePendingReleaseJournal({
      root,
      sha,
      runId: "101",
      attempt: "1",
      previousRelease,
      targetRelease,
      previousSha,
      ...pendingDigests,
    }),
    /缺少受保护的版本文件/u,
  );
});

test("中断发布的 current 不属于 previous 或 target 时保持记录并停止", async () => {
  const events = [];
  const dependencies = fakeDependencies(events);
  dependencies.inspectPendingRelease = async () => {
    events.push("inspect-pending");
    return pendingReleaseRecord();
  };
  dependencies.readCurrentRelease = async () => {
    events.push("read-current");
    return "/releases/unexpected";
  };

  await assert.rejects(
    reconcilePendingLocalRelease({
      root: releaseOptions.root,
      expectedSha: sha,
      runId: "202",
      attempt: "1",
      dependencies,
    }),
    /current 与中断发布记录不一致/u,
  );
  assert.deepEqual(events, ["inspect-pending", "read-current"]);
});

test("当前签出 SHA 与中断记录不一致时不读取 current 或运行服务", async () => {
  const events = [];
  const dependencies = fakeDependencies(events);
  dependencies.inspectPendingRelease = async () => {
    events.push("inspect-pending");
    return pendingReleaseRecord();
  };

  await assert.rejects(
    reconcilePendingLocalRelease({
      root: releaseOptions.root,
      expectedSha: "b".repeat(40),
      runId: "202",
      attempt: "1",
      dependencies,
    }),
    /必须先签出并验证记录中的精确 SHA/u,
  );
  assert.deepEqual(events, ["inspect-pending"]);
});

test("服务已切到目标但 current 仍是上一版本时完成目标激活后才清理记录", async () => {
  const events = [];
  const dependencies = fakeDependencies(events);
  dependencies.inspectPendingRelease = async () => {
    events.push("inspect-pending");
    return pendingReleaseRecord();
  };
  const result = await reconcilePendingLocalRelease({
    root: releaseOptions.root,
    expectedSha: sha,
    runId: "202",
    attempt: "1",
    dependencies,
  });

  assert.equal(result.status, "target_recovered");
  assert.deepEqual(events, [
    "inspect-pending",
    "read-current",
    "verify-pending-integrity",
    "verify-previous-commit",
    "verify-runtime-binding",
    "service-verify:/releases/new",
    "service-cleanup:/releases/new",
    "service-verify:/releases/new",
    "verify-pending-integrity",
    "verify-runtime-binding",
    "activate:/releases/new",
    "clear-pending",
  ]);
});

test("下次发布先完成中断对账并停止，不把旧 current 当作新回退基线", async () => {
  const events = [];
  const dependencies = fakeDependencies(events);
  dependencies.inspectPendingRelease = async () => {
    events.push("inspect-pending");
    return pendingReleaseRecord();
  };
  const result = await runLocalAtomicRelease({
    ...releaseOptions,
    apply: true,
    runId: "202",
    dependencies,
  });

  assert.equal(result.recoveredInterruptedRelease, true);
  assert.equal(result.recoveryStatus, "target_recovered");
  assert.equal(result.releaseDirectory, fakeTargetRelease);
  assert.equal(events.includes("prepare"), false);
  assert.equal(events.includes("copy-config"), false);
  assert.equal(events.at(-1), "unlock");
});

test("目标服务仅部分切换时先过状态保护再恢复并激活上一版本", async () => {
  const events = [];
  const dependencies = fakeDependencies(events, {
    failAt: "service-verify:/releases/new",
  });
  dependencies.inspectPendingRelease = async () => {
    events.push("inspect-pending");
    return pendingReleaseRecord();
  };
  const result = await reconcilePendingLocalRelease({
    root: releaseOptions.root,
    expectedSha: sha,
    runId: "202",
    attempt: "1",
    dependencies,
  });

  assert.equal(result.status, "previous_restored");
  const guard = events.indexOf("rollback-state-guard:/releases/new");
  const restore = events.indexOf("service-install:/releases/old");
  const activate = events.indexOf("activate:/releases/old");
  const clear = events.indexOf("clear-pending");
  assert.ok(guard > events.indexOf("service-verify:/releases/new"));
  assert.ok(guard < restore && restore < activate && activate < clear);
  assert.equal(events.includes("activate:/releases/new"), false);
});

test("中断目标内容与记录摘要不一致时不运行任何目标或回退脚本", async () => {
  const events = [];
  const dependencies = fakeDependencies(events);
  dependencies.inspectPendingRelease = async () => {
    events.push("inspect-pending");
    return pendingReleaseRecord();
  };
  dependencies.verifyPendingReleaseIntegrity = async () => {
    events.push("verify-pending-integrity");
    throw new Error("中断发布的目标版本已偏离服务切换前的精确内容");
  };

  await assert.rejects(
    reconcilePendingLocalRelease({
      root: releaseOptions.root,
      expectedSha: sha,
      runId: "202",
      attempt: "1",
      dependencies,
    }),
    /已偏离服务切换前的精确内容/u,
  );
  assert.deepEqual(events, [
    "inspect-pending",
    "read-current",
    "verify-pending-integrity",
  ]);
});

test("崩溃恢复发现 target 或 previous 配置摘要被改写时不运行服务", async () => {
  const events = [];
  const dependencies = fakeDependencies(events);
  dependencies.inspectPendingRelease = async () => {
    events.push("inspect-pending");
    return pendingReleaseRecord();
  };
  dependencies.verifyReleaseRuntimeIdentityBinding = async () => {
    events.push("verify-runtime-binding");
    throw new Error("版本配置或关键运行身份已发生变化");
  };

  await assert.rejects(
    reconcilePendingLocalRelease({
      root: releaseOptions.root,
      expectedSha: sha,
      runId: "202",
      attempt: "1",
      dependencies,
    }),
    /版本配置或关键运行身份已发生变化/u,
  );
  assert.deepEqual(events, [
    "inspect-pending",
    "read-current",
    "verify-pending-integrity",
    "verify-previous-commit",
    "verify-runtime-binding",
  ]);
});

test("崩溃恢复发现上一版本不再匹配固定提交时不运行服务", async () => {
  const events = [];
  const dependencies = fakeDependencies(events);
  dependencies.inspectPendingRelease = async () => {
    events.push("inspect-pending");
    return pendingReleaseRecord();
  };
  dependencies.verifyPreviousReleaseAgainstCommit = async () => {
    events.push("verify-previous-commit");
    return {
      sha: previousSha,
      integrityDigest: "0".repeat(64),
    };
  };

  await assert.rejects(
    reconcilePendingLocalRelease({
      root: releaseOptions.root,
      expectedSha: sha,
      runId: "202",
      attempt: "1",
      dependencies,
    }),
    /上一版本的提交身份或完整性基线不一致/u,
  );
  assert.equal(
    events.some((event) => event.startsWith("service-verify:")),
    false,
  );
});

test("服务切换前失败会立即停止且不执行服务或数据库回退", async () => {
  const events = [];
  await assert.rejects(
    runLocalAtomicRelease({
      ...releaseOptions,
      apply: true,
      dependencies: fakeDependencies(events, { failAt: "migrate" }),
    }),
    /simulated migrate failure/u,
  );

  assert.deepEqual(events.slice(-2), ["migrate", "unlock"]);
  assert.equal(events.some((event) => event.startsWith("service-install:")), false);
  assert.equal(events.some((event) => event.startsWith("rollback-state-guard:")), false);
  assert.equal(events.includes("restore-database"), false);
  assert.equal(events.includes("reverse-migrate"), false);
});

test("普通发布在任何数据库动作前拒绝跨配置运行身份", async () => {
  const events = [];
  const dependencies = fakeDependencies(events);
  dependencies.compareReleaseRuntimeIdentity = async () => {
    events.push("compare-runtime-identity");
    throw new Error("目标版本与上一版本的关键运行身份不一致");
  };
  await assert.rejects(
    runLocalAtomicRelease({
      ...releaseOptions,
      apply: true,
      dependencies,
    }),
    (error) => {
      assert.match(error.message, /关键运行身份不一致/u);
      assert.doesNotMatch(error.message, /database-reference|tenant-a/u);
      return true;
    },
  );

  assert.ok(events.indexOf("cloud") < events.indexOf("compare-runtime-identity"));
  assert.equal(events.includes("rollback-target"), false);
  assert.equal(events.includes("backup"), false);
  assert.equal(events.includes("migrate"), false);
});

test("服务切换后失败先过状态保护再只恢复上一版本服务", async () => {
  const events = [];
  let guardedPreviousRelease = "";
  const dependencies = fakeDependencies(events, {
    failAt: "service-verify:/releases/new",
  });
  dependencies.rollbackStateGuard = async ({
    releaseDirectory,
    previousRelease,
  }) => {
    events.push(`rollback-state-guard:${releaseDirectory}`);
    guardedPreviousRelease = previousRelease;
  };
  await assert.rejects(
    runLocalAtomicRelease({
      ...releaseOptions,
      apply: true,
      dependencies,
    }),
    /simulated service-verify/u,
  );

  const guard = events.indexOf(
    `rollback-state-guard:${fakeTargetRelease}`,
  );
  const reinstall = events.indexOf("service-install:/releases/old");
  const cleanup = events.indexOf("service-cleanup:/releases/old");
  const verify = events.indexOf("service-verify:/releases/old");
  assert.ok(guard > events.indexOf("service-verify:/releases/new"));
  assert.ok(guard < reinstall && reinstall < cleanup && cleanup < verify);
  assert.equal(guardedPreviousRelease, fakePreviousRelease);
  assert.equal(events.includes("restore-database"), false);
  assert.equal(events.includes("reverse-migrate"), false);
});

test("回退前配置摘要漂移时不运行状态保护或上一版本脚本", async () => {
  const events = [];
  const dependencies = fakeDependencies(events, {
    failAt: "service-verify:/releases/new",
  });
  let bindingChecks = 0;
  dependencies.verifyReleaseRuntimeIdentityBinding = async () => {
    events.push("verify-runtime-binding");
    bindingChecks += 1;
    if (bindingChecks === 2) {
      throw new Error("版本配置或关键运行身份已发生变化");
    }
  };

  await assert.rejects(
    runLocalAtomicRelease({
      ...releaseOptions,
      apply: true,
      dependencies,
    }),
    /上一版本服务回退也未完整通过/u,
  );
  assert.equal(
    events.some((event) => event.startsWith("rollback-state-guard:")),
    false,
  );
  assert.equal(events.includes("service-install:/releases/old"), false);
});

test("回退前上一版本代码漂移时绝不执行其安装脚本", async () => {
  const events = [];
  const dependencies = fakeDependencies(events, {
    failAt: "service-verify:/releases/new",
  });
  let previousChecks = 0;
  dependencies.verifyPreviousReleaseIntegrity = async () => {
    events.push("verify-previous-integrity");
    previousChecks += 1;
    if (previousChecks === 3) {
      throw new Error("上一版本目录已偏离完整性基线");
    }
  };

  await assert.rejects(
    runLocalAtomicRelease({
      ...releaseOptions,
      apply: true,
      dependencies,
    }),
    /上一版本服务回退也未完整通过/u,
  );
  assert.equal(
    events.some((event) => event.startsWith("rollback-state-guard:")),
    false,
  );
  assert.equal(events.includes("service-install:/releases/old"), false);
});

test("current 已激活但记录清理失败时保留目标服务和记录等待下次对账", async () => {
  const events = [];
  await assert.rejects(
    runLocalAtomicRelease({
      ...releaseOptions,
      apply: true,
      dependencies: fakeDependencies(events, { failAt: "clear-pending" }),
    }),
    /目标版本已激活但中断发布记录未清理/u,
  );

  assert.ok(events.includes("activate:/releases/new"));
  assert.equal(
    events.some((event) => event.startsWith("rollback-state-guard:")),
    false,
  );
  assert.equal(events.includes("service-install:/releases/old"), false);
  assert.equal(events.at(-1), "unlock");
});

test("服务脚本若篡改目标版本会保留 journal 并拒绝执行任何回退脚本", async () => {
  const events = [];
  const dependencies = fakeDependencies(events);
  let integrityChecks = 0;
  dependencies.verifyReleaseIntegrity = async () => {
    events.push("verify-integrity");
    integrityChecks += 1;
    if (integrityChecks === 5) {
      throw new Error("目标版本文件已偏离门禁通过的精确提交");
    }
  };
  dependencies.verifyPendingReleaseIntegrity = async () => {
    events.push("verify-pending-integrity");
    throw new Error("中断发布的目标版本已偏离服务切换前的精确内容");
  };
  await assert.rejects(
    runLocalAtomicRelease({
      ...releaseOptions,
      apply: true,
      dependencies,
    }),
    /上一版本服务回退也未完整通过/u,
  );

  assert.equal(events.includes("activate:/releases/new"), false);
  assert.equal(
    events.some((event) => event.startsWith("rollback-state-guard:")),
    false,
  );
  assert.equal(events.includes("service-install:/releases/old"), false);
  assert.equal(events.includes("activate:/releases/old"), false);
  assert.equal(events.includes("clear-pending"), false);
  assert.equal(events.at(-1), "unlock");
});

test("服务回退状态保护失败时不会重装任何旧服务", async () => {
  const events = [];
  await assert.rejects(
    runLocalAtomicRelease({
      ...releaseOptions,
      apply: true,
      dependencies: fakeDependencies(events, {
        failAt: [
          "service-verify:/releases/new",
          "rollback-state-guard:/releases/new",
        ],
      }),
    }),
    /上一版本服务回退也未完整通过/u,
  );

  assert.equal(events.includes("service-install:/releases/old"), false);
  assert.equal(events.includes("service-cleanup:/releases/old"), false);
  assert.equal(events.includes("service-verify:/releases/old"), false);
});

test("目标检查篡改 tracked 源码后完整性门禁拒绝复制生产配置", async (t) => {
  const releaseDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-release-integrity-")),
  );
  t.after(() => rm(releaseDirectory, { recursive: true, force: true }));
  await mkdir(join(releaseDirectory, "src"));
  await writeFile(join(releaseDirectory, "package.json"), "{}\n");
  await writeFile(
    join(releaseDirectory, "src", "main.mjs"),
    "export const safe = true;\n",
  );
  const expected = await captureReleaseIntegrity({ releaseDirectory });
  const expectedDigest = createHash("sha256")
    .update(JSON.stringify(expected.entries))
    .digest("hex");
  await verifyReleaseIntegrityDigest({ releaseDirectory, expectedDigest });

  await writeFile(
    join(releaseDirectory, "src", "main.mjs"),
    "export const safe = false;\n",
  );
  await assert.rejects(
    verifyReleaseIntegrity({ releaseDirectory, expected }),
    /偏离门禁通过的精确提交/u,
  );
  await assert.rejects(
    verifyReleaseIntegrityDigest({ releaseDirectory, expectedDigest }),
    /偏离服务切换前的精确内容/u,
  );
});

test("依赖安装禁用生命周期且目标进程只获得最小环境", () => {
  const environment = minimalRuntimeEnvironment({
    source: {
      HOME: "/sentinel/home",
      PATH: "/sentinel/bin",
      TMPDIR: "/private/tmp/safe",
      LANG: "zh_CN.UTF-8",
      HTTPS_PROXY: "http://127.0.0.1:8080",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      GH_TOKEN: "sentinel-gh",
      GITHUB_TOKEN: "sentinel-github",
      NPM_TOKEN: "sentinel-npm",
      AWS_SECRET_ACCESS_KEY: "sentinel-aws",
      DWS_AUTH_TOKEN: "sentinel-dws",
      DATABASE_URL: "sentinel-db",
      AI_EMPLOYEE_ADMIN_READ_TOKEN: "sentinel-admin",
      AI_EMPLOYEE_TENANT_ID: "sentinel-tenant",
      NODE_OPTIONS: "--require=/sentinel/inject.cjs",
      GIT_CONFIG: "/sentinel/git-config",
      GIT_DIR: "/sentinel/git-dir",
      GH_CONFIG_DIR: "/sentinel/gh-config",
      SSH_AUTH_SOCK: "/sentinel/ssh-agent",
      TAR_OPTIONS: "--to-command=/sentinel/tar-hook",
    },
    configPath: "/releases/new/.runtime/production.json",
    releaseDirectory: "/releases/new",
  });

  assert.deepEqual(npmInstallArguments, ["ci", "--ignore-scripts"]);
  assert.equal(environment.HOME, homedir());
  assert.equal(environment.PATH.includes("/sentinel"), false);
  const runtimePath = environment.PATH.split(":");
  assert.equal(
    runtimePath[0],
    resolveTrustedReleaseTool("node").replace(/\/[^/]+$/u, ""),
  );
  assert.deepEqual(
    runtimePath.slice(1),
    ["/usr/bin", "/bin", "/usr/sbin", "/sbin"],
  );
  assert.equal(runtimePath.includes(join(homedir(), ".local", "bin")), false);
  assert.equal(environment.TMPDIR, "/private/tmp/safe");
  assert.equal(environment.LANG, "zh_CN.UTF-8");
  assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:8080");
  assert.equal(environment.SSL_CERT_FILE, "/etc/ssl/cert.pem");
  assert.equal(
    environment.AI_EMPLOYEE_CONFIG_FILE,
    "/releases/new/.runtime/production.json",
  );
  assert.equal(
    environment.AI_EMPLOYEE_EXPECTED_RELEASE_DIRECTORY,
    "/releases/new",
  );
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "DWS_AUTH_TOKEN",
    "DATABASE_URL",
    "AI_EMPLOYEE_ADMIN_READ_TOKEN",
    "AI_EMPLOYEE_TENANT_ID",
    "NODE_OPTIONS",
    "GIT_CONFIG",
    "GIT_DIR",
    "GH_CONFIG_DIR",
    "SSH_AUTH_SOCK",
    "TAR_OPTIONS",
  ]) {
    assert.equal(Object.hasOwn(environment, key), false, key);
  }
});

test("签出与归档验证环境剔除 Git GitHub SSH 和 tar 注入变量", () => {
  const environment = releaseVerificationEnvironment({
    PATH: "/sentinel/bin",
    TMPDIR: "/private/tmp/safe",
    LANG: "zh_CN.UTF-8",
    GIT_CONFIG: "/sentinel/git-config",
    GIT_DIR: "/sentinel/git-dir",
    GIT_SSH_COMMAND: "/sentinel/ssh",
    GH_TOKEN: "sentinel-token",
    GITHUB_TOKEN: "sentinel-github-token",
    GH_CONFIG_DIR: "/sentinel/gh-config",
    SSH_AUTH_SOCK: "/sentinel/ssh-agent",
    TAR_OPTIONS: "--to-command=/sentinel/tar-hook",
    NODE_OPTIONS: "--require=/sentinel/inject.cjs",
  });

  assert.equal(environment.HOME, "/var/empty");
  assert.equal(environment.PATH.includes("/sentinel"), false);
  assert.equal(environment.PATH.includes(join(homedir(), ".local", "bin")), false);
  assert.equal(environment.TMPDIR, "/private/tmp/safe");
  assert.equal(environment.LANG, "zh_CN.UTF-8");
  for (const key of Object.keys(environment)) {
    assert.equal(key.startsWith("GIT_"), false, key);
    assert.equal(key.startsWith("GH_"), false, key);
  }
  for (const key of [
    "GITHUB_TOKEN",
    "SSH_AUTH_SOCK",
    "TAR_OPTIONS",
    "NODE_OPTIONS",
  ]) {
    assert.equal(Object.hasOwn(environment, key), false, key);
  }
});

test("PATH 前置伪 git gh node npm 不会进入本机发布工具链", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-fake-release-tools-")),
  );
  const fakeBin = join(directory, "bin");
  const marker = join(directory, "fake-tool-called");
  await mkdir(fakeBin, { mode: 0o700 });
  for (const name of ["git", "gh", "node", "npm"]) {
    await writeFile(
      join(fakeBin, name),
      `#!/bin/sh\n/usr/bin/touch '${marker}'\nexit 99\n`,
      { mode: 0o700 },
    );
  }
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = releaseVerificationEnvironment({
    PATH: `${fakeBin}:/usr/bin:/bin`,
    TMPDIR: directory,
  });
  const gh = resolveTrustedReleaseTool("gh");
  const node = resolveTrustedReleaseTool("node");
  const npm = resolveTrustedReleaseTool("npm");

  assert.equal(gh.startsWith(fakeBin), false);
  assert.equal(node.startsWith(fakeBin), false);
  assert.equal(npm.startsWith(fakeBin), false);
  execFileSync("/usr/bin/git", ["--version"], { env: environment, stdio: "ignore" });
  execFileSync(gh, ["--version"], { env: environment, stdio: "ignore" });
  execFileSync(node, ["--version"], { env: environment, stdio: "ignore" });
  execFileSync(node, [npm, "--version"], { env: environment, stdio: "ignore" });
  await assert.rejects(lstat(marker), /ENOENT/u);
});

test("依赖安装固定由受信 Node 启动 npm CLI 且不传 GitHub token", async () => {
  const calls = [];
  const dependencies = createLocalReleaseDependencies({
    environmentSource: {
      PATH: "/sentinel/bin",
      GH_TOKEN: "must-not-reach-target",
      GITHUB_TOKEN: "must-not-reach-target",
      GIT_CONFIG: "/sentinel/git-config",
      SSH_AUTH_SOCK: "/sentinel/ssh-agent",
      NODE_OPTIONS: "--require=/sentinel/inject.cjs",
    },
    async command(command, args, options) {
      calls.push({ command, args, options });
      return "";
    },
  });
  await dependencies.installDependencies({ releaseDirectory: "/releases/new" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, resolveTrustedReleaseTool("node"));
  assert.deepEqual(calls[0].args, [
    resolveTrustedReleaseTool("npm"),
    ...npmInstallArguments,
  ]);
  assert.equal(calls[0].options.env.PATH.includes("/sentinel"), false);
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GIT_CONFIG",
    "SSH_AUTH_SOCK",
    "NODE_OPTIONS",
  ]) {
    assert.equal(Object.hasOwn(calls[0].options.env, key), false, key);
  }
});

test("维护控制命令来自受门禁控制器并明确绑定固定目标版本", async (t) => {
  const calls = [];
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-controller-binding-")),
  );
  const targetRelease = join(directory, "d9e5eaf-target");
  const configPath = `${targetRelease}/.runtime/production.json`;
  const backupRoot = join(directory, "Backups");
  await mkdir(join(targetRelease, ".runtime"), { recursive: true, mode: 0o700 });
  await mkdir(backupRoot, { mode: 0o700 });
  await writeFile(
    configPath,
    `${JSON.stringify({ AI_EMPLOYEE_BACKUP_DIRECTORY: backupRoot })}\n`,
    { mode: 0o600 },
  );
  await chmod(configPath, 0o600);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dependencies = createLocalReleaseDependencies({
    async command(command, args, options) {
      calls.push({ command, args, options });
      const script = args[0];
      if (script.endsWith("备份数据库.mjs")) {
        return JSON.stringify({
          completed: true,
          backupPath: join(backupRoot, "a.dump.enc"),
          metadataPath: join(backupRoot, "a.dump.enc.json"),
        });
      }
      if (script.endsWith("隔离恢复演练.mjs")) {
        return JSON.stringify({ restored: true, isolated: true });
      }
      if (script.endsWith("验证维护前滚状态.mjs")) {
        return JSON.stringify({ safe: true, paused: true });
      }
      if (script.endsWith("管理常驻服务.mjs")) {
        return JSON.stringify(
          args[1] === "stop-for-maintenance"
            ? { stopped: true, forwardOnly: true }
            : { installed: true, forwardOnly: true },
        );
      }
      throw new Error(`unexpected controller command: ${script}`);
    },
  });
  const context = { releaseDirectory: targetRelease, configPath };
  const backup = await dependencies.backupDatabase(context);
  await dependencies.restoreBackupDrill({
    ...context,
    backupPath: backup.backupPath,
  });
  await dependencies.inspectForwardMaintenanceState(context);
  await dependencies.stopServicesForMaintenance(context);
  await dependencies.installForwardOnlyService(context);

  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(call.command, resolveTrustedReleaseTool("node"));
    assert.equal(call.args[0].startsWith(`${process.cwd()}/`), true);
    assert.equal(call.args[0].startsWith(`${targetRelease}/`), false);
    assert.equal(
      call.options.env.AI_EMPLOYEE_EXPECTED_RELEASE_DIRECTORY,
      targetRelease,
    );
    assert.equal(call.options.env.AI_EMPLOYEE_CONFIG_FILE, configPath);
  }
});

test("可选健康和告警密钥出现时也必须使用钥匙串引用", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-release-config-")),
  );
  const configPath = join(directory, "production.json");
  const base = {
    DATABASE_URL: "keychain://ai-employee/database",
    AI_EMPLOYEE_DATA_KEY: "keychain://ai-employee/data",
    AI_EMPLOYEE_BACKUP_KEY: "keychain://ai-employee/backup",
    AI_EMPLOYEE_ADMIN_READ_TOKEN: "keychain://ai-employee/admin-read",
    AI_EMPLOYEE_ADMIN_WRITE_TOKEN: "keychain://ai-employee/admin-write",
  };
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const key of [
    "AI_EMPLOYEE_HEALTH_AUTH_TOKEN",
    "AI_EMPLOYEE_ALERT_WEBHOOK_URL",
    "AI_EMPLOYEE_ALERT_WEBHOOK_SECRET",
  ]) {
    await writeFile(
      configPath,
      `${JSON.stringify({ ...base, [key]: "inline-secret" })}\n`,
      { mode: 0o600 },
    );
    await chmod(configPath, 0o600);
    await assert.rejects(
      validateAndCopyProductionConfig({
        configPath,
        releaseDirectory: join(directory, "release"),
      }),
      new RegExp(key, "u"),
    );
  }

});

test("目标自检创建的受保护空运行子目录可以保留并注入配置", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-release-runtime-")),
  );
  const releaseDirectory = join(directory, "release");
  const runtime = join(releaseDirectory, ".runtime");
  const configPath = join(directory, "production.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
  for (const entry of ["drafts", "work-plan-temp", "worktrees"]) {
    await mkdir(join(runtime, entry), { mode: 0o700 });
    await chmod(join(runtime, entry), 0o700);
  }
  await writeFile(
    configPath,
    `${JSON.stringify({
      DATABASE_URL: "keychain://ai-employee/database",
      AI_EMPLOYEE_DATA_KEY: "keychain://ai-employee/data",
      AI_EMPLOYEE_BACKUP_KEY: "keychain://ai-employee/backup",
      AI_EMPLOYEE_ADMIN_READ_TOKEN: "keychain://ai-employee/admin-read",
      AI_EMPLOYEE_ADMIN_WRITE_TOKEN: "keychain://ai-employee/admin-write",
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(configPath, 0o600);

  const destination = await validateAndCopyProductionConfig({
    configPath,
    releaseDirectory,
  });
  assert.equal(destination, join(runtime, "production.json"));
  assert.equal((await lstat(destination)).mode & 0o777, 0o600);
});

test("目标自检运行目录拒绝额外内容、非空目录和符号链接", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ai-employee-release-runtime-invalid-")),
  );
  const configPath = join(directory, "production.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    configPath,
    `${JSON.stringify({
      DATABASE_URL: "keychain://ai-employee/database",
      AI_EMPLOYEE_DATA_KEY: "keychain://ai-employee/data",
      AI_EMPLOYEE_BACKUP_KEY: "keychain://ai-employee/backup",
      AI_EMPLOYEE_ADMIN_READ_TOKEN: "keychain://ai-employee/admin-read",
      AI_EMPLOYEE_ADMIN_WRITE_TOKEN: "keychain://ai-employee/admin-write",
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(configPath, 0o600);

  for (const scenario of ["unexpected", "nonempty", "symlink"]) {
    const releaseDirectory = join(directory, scenario);
    const runtime = join(releaseDirectory, ".runtime");
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    await chmod(runtime, 0o700);
    if (scenario === "unexpected") {
      await writeFile(join(runtime, "unexpected"), "x");
    } else if (scenario === "nonempty") {
      await mkdir(join(runtime, "drafts"), { mode: 0o700 });
      await chmod(join(runtime, "drafts"), 0o700);
      await writeFile(join(runtime, "drafts", "artifact"), "x");
    } else {
      const outside = join(directory, "outside");
      await mkdir(outside, { mode: 0o700 });
      await symlink(outside, join(runtime, "drafts"));
    }
    await assert.rejects(
      validateAndCopyProductionConfig({ configPath, releaseDirectory }),
      /非预期内容|必须为空|受保护目录约束/u,
    );
  }
});

test("GitHub 仓库地址归一化后只接受官方仓库且 gh 显式绑定", () => {
  for (const remote of [
    "https://github.com/ruiwang20010702/ai-employee.git",
    "git@github.com:ruiwang20010702/ai-employee.git",
    "ssh://git@github.com/ruiwang20010702/ai-employee",
  ]) {
    assert.equal(normalizeGitHubRepository(remote), productionRepository);
  }
  assert.equal(
    normalizeGitHubRepository("https://github.com/other/ai-employee.git"),
    "other/ai-employee",
  );
  assert.deepEqual(
    productionGitHubArguments(["run", "list", "--commit", sha]),
    ["run", "list", "--commit", sha, "--repo", productionRepository],
  );
  assert.deepEqual(
    productionGitHubArguments(["run", "view", "123", "--json", "headSha"]),
    [
      "run",
      "view",
      "123",
      "--json",
      "headSha",
      "--repo",
      productionRepository,
    ],
  );
  assert.deepEqual(
    productionGitHubArguments([
      "api",
      "repos/{owner}/{repo}/actions/workflows/check.yml",
    ]),
    ["api", "repos/{owner}/{repo}/actions/workflows/check.yml"],
  );
  const githubEnvironment = githubCliEnvironment({
    GH_TOKEN: "github-only-token",
    GH_CONFIG_DIR: "/sentinel/gh-config",
    GH_ENTERPRISE_TOKEN: "must-not-pass",
    GH_HOST: "evil.example",
    GH_REPO: "other/fork",
    GITHUB_TOKEN: "fallback-token-must-not-win",
    GIT_CONFIG: "/sentinel/git-config",
    SSH_AUTH_SOCK: "/sentinel/ssh-agent",
    NPM_TOKEN: "must-not-pass",
    AWS_SECRET_ACCESS_KEY: "must-not-pass",
  });
  assert.equal(githubEnvironment.GH_REPO, productionRepository);
  assert.equal(githubEnvironment.GH_HOST, "github.com");
  assert.equal(githubEnvironment.GH_TOKEN, "github-only-token");
  assert.deepEqual(
    Object.keys(githubEnvironment).filter((key) => key.startsWith("GH_")).sort(),
    ["GH_HOST", "GH_REPO", "GH_TOKEN"],
  );
  assert.equal(Object.hasOwn(githubEnvironment, "GITHUB_TOKEN"), false);
  assert.equal(Object.hasOwn(githubEnvironment, "GIT_CONFIG"), false);
  assert.equal(Object.hasOwn(githubEnvironment, "SSH_AUTH_SOCK"), false);
  assert.equal(Object.hasOwn(githubEnvironment, "NPM_TOKEN"), false);
  assert.equal(Object.hasOwn(githubEnvironment, "AWS_SECRET_ACCESS_KEY"), false);
  assert.throws(
    () => productionGitHubArguments(["run", "list", "--repo", "other/fork"]),
    /不能覆盖固定生产仓库/u,
  );
});

test("云端门禁只用受信 gh 且令牌仅存在于 gh 的最小环境", async () => {
  const calls = [];
  const workflowIdentity = {
    "check.yml": {
      id: 101,
      name: "检查",
      path: ".github/workflows/check.yml",
      state: "active",
    },
    "security.yml": {
      id: 102,
      name: "安全扫描",
      path: ".github/workflows/security.yml",
      state: "active",
    },
  };
  const runs = ["检查", "安全扫描"].map((name, index) => ({
    databaseId: index + 10,
    workflowDatabaseId: index + 101,
    name,
    headSha: sha,
    status: "completed",
    conclusion: "success",
    event: "push",
    url: `https://github.example/actions/runs/${index + 10}`,
    createdAt: `2026-08-10T08:00:0${index}Z`,
  }));
  const dependencies = createLocalReleaseDependencies({
    environmentSource: {
      PATH: "/sentinel/fake-bin",
      GH_TOKEN: "github-gate-token",
      GH_CONFIG_DIR: "/sentinel/gh-config",
      GH_ENTERPRISE_TOKEN: "must-not-pass",
      GH_HOST: "evil.example",
      GH_REPO: "other/fork",
      GIT_CONFIG: "/sentinel/git-config",
      SSH_AUTH_SOCK: "/sentinel/ssh-agent",
      TAR_OPTIONS: "--to-command=/sentinel/tar-hook",
    },
    syncCommand(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === "api") {
        const file = args[1].split("/").at(-1);
        return JSON.stringify(workflowIdentity[file]);
      }
      return JSON.stringify(runs);
    },
  });

  const result = await dependencies.verifyCloudGate({
    sha,
    sourceDirectory: "/workspace/ai-employee",
  });
  assert.equal(result.valid, true);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.command, resolveTrustedReleaseTool("gh"));
    assert.equal(call.command.startsWith("/sentinel"), false);
    assert.equal(call.options.env.HOME, "/var/empty");
    assert.equal(call.options.env.GH_TOKEN, "github-gate-token");
    assert.equal(call.options.env.GH_HOST, "github.com");
    assert.equal(call.options.env.GH_REPO, productionRepository);
    assert.equal(call.args.includes("github-gate-token"), false);
    assert.deepEqual(
      Object.keys(call.options.env)
        .filter((key) => key.startsWith("GH_"))
        .sort(),
      ["GH_HOST", "GH_REPO", "GH_TOKEN"],
    );
    for (const key of [
      "GH_CONFIG_DIR",
      "GH_ENTERPRISE_TOKEN",
      "GIT_CONFIG",
      "SSH_AUTH_SOCK",
      "TAR_OPTIONS",
    ]) {
      assert.equal(Object.hasOwn(call.options.env, key), false, key);
    }
  }
});

test("错误 clone 或 fork 在读取工作区和触发云端门禁前被拒绝", async () => {
  const commands = [];
  await assert.rejects(
    verifyLocalReleaseCheckout({
      sha,
      sourceDirectory: "/workspace/fork",
      command: async (command, args, options) => {
        commands.push(gitOperationArguments(command, args, options));
        return "git@github.com:someone-else/ai-employee.git";
      },
    }),
    /只接受官方仓库/u,
  );
  assert.deepEqual(commands, [["remote", "get-url", "origin"]]);
});

test("签出验证拒绝脏工作区和与目标 SHA 不一致的 HEAD", async () => {
  await assert.rejects(
    verifyLocalReleaseCheckout({
      sha,
      sourceDirectory: "/workspace/ai-employee",
      command: async (command, args, options) =>
        gitOperationArguments(command, args, options)[0] === "remote"
        ? `https://github.com/${productionRepository}.git`
        : " M src/worker.mjs",
    }),
    /工作区不干净/u,
  );

  const outputs = [
    `https://github.com/${productionRepository}.git`,
    "",
    "b".repeat(40),
  ];
  await assert.rejects(
    verifyLocalReleaseCheckout({
      sha,
      sourceDirectory: "/workspace/ai-employee",
      command: async () => outputs.shift(),
    }),
    /当前签出与目标提交不一致/u,
  );
});

test("签出验证拒绝只在 PR 或游离提交上通过检查的 SHA", async () => {
  const outputs = [
    `https://github.com/${productionRepository}.git`,
    "",
    sha,
    sha,
  ];
  await assert.rejects(
    verifyLocalReleaseCheckout({
      sha,
      sourceDirectory: "/workspace/ai-employee",
      command: async (command, args, options) => {
        const operation = gitOperationArguments(command, args, options);
        if (operation[0] === "fetch") return "";
        if (operation[0] === "merge-base") throw new Error("not an ancestor");
        return outputs.shift();
      },
      loadRollbackBaseline: async () => ({ commit: "b".repeat(40) }),
    }),
    /不属于 origin\/main 历史，也不是固定回退基线/u,
  );
});

test("签出验证仅对清单固定的回退基线开放 main 历史例外", async () => {
  const outputs = [
    `https://github.com/${productionRepository}.git`,
    "",
    sha,
    sha,
  ];
  const result = await verifyLocalReleaseCheckout({
    sha,
    sourceDirectory: "/workspace/ai-employee",
    command: async (command, args, options) => {
      const operation = gitOperationArguments(command, args, options);
      if (operation[0] === "fetch") return "";
      if (operation[0] === "merge-base") throw new Error("not an ancestor");
      if (operation[0] === "show") {
        assert.equal(
          operation[1],
          "refs/remotes/origin/main:deploy/回退基线.json",
        );
        return JSON.stringify({ commit: sha });
      }
      return outputs.shift();
    },
  });

  assert.equal(result.authorizedBy, "rollback_baseline");
});

test("签出验证接受 origin/main 历史中的精确提交", async () => {
  const outputs = [
    `https://github.com/${productionRepository}.git`,
    "",
    sha,
    sha,
    "",
    "",
  ];
  const result = await verifyLocalReleaseCheckout({
    sha,
    sourceDirectory: "/workspace/ai-employee",
    command: async (command, args, options) => {
      const operation = gitOperationArguments(command, args, options);
      if (operation[0] === "fetch") {
        assert.equal(
          operation[3],
          `https://github.com/${productionRepository}.git`,
        );
      }
      return outputs.shift();
    },
    loadRollbackBaseline: async () => {
      throw new Error("main 历史提交不应读取回退例外");
    },
  });

  assert.equal(result.authorizedBy, "origin/main");
});
