import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  restoreLaunchAgents,
  validateServiceConfig,
} from "../scripts/管理常驻服务.mjs";

test("常驻服务安装前拒绝内联生产密钥", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-service-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "production.json");
  await writeFile(path, JSON.stringify({
    DATABASE_URL: "postgresql://inline-secret",
  }), { mode: 0o600 });
  await assert.rejects(
    validateServiceConfig({ path, environment: {} }),
    /must use an external reference/u,
  );
});

test("安装失败回退会恢复原 plist 并删除首次安装产生的 plist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-launchd-"));
  const backup = join(directory, "listener.backup.plist");
  await writeFile(backup, "old-listener\n", { mode: 0o600 });
  await writeFile(join(directory, "listener.plist"), "new-listener\n", {
    mode: 0o600,
  });
  await writeFile(join(directory, "worker.plist"), "new-worker\n", {
    mode: 0o600,
  });
  const calls = [];
  const result = await restoreLaunchAgents({
    serviceDefinitions: [
      { label: "listener" },
      { label: "worker" },
    ],
    destinationDirectory: directory,
    previous: new Map([["listener", backup]]),
    launchDomain: "gui/test",
    runLaunchctl: async (_path, args) => {
      calls.push(args);
      if (args[0] === "print" && args[1].endsWith("/worker")) {
        throw new Error("not loaded");
      }
    },
  });

  assert.deepEqual(result, { complete: true, failedLabels: [] });
  assert.equal(await readFile(join(directory, "listener.plist"), "utf8"), "old-listener\n");
  await assert.rejects(stat(join(directory, "worker.plist")), { code: "ENOENT" });
  assert.ok(calls.some((args) => args[0] === "bootstrap" && args.at(-1).endsWith("listener.plist")));
  assert.equal(calls.some((args) => args[0] === "bootstrap" && args.at(-1).endsWith("worker.plist")), false);
});

test("上一版本重新加载失败时明确返回回退不完整", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-launchd-fail-"));
  const backup = join(directory, "listener.backup.plist");
  await writeFile(backup, "old-listener\n", { mode: 0o600 });
  await writeFile(join(directory, "listener.plist"), "new-listener\n", {
    mode: 0o600,
  });
  const result = await restoreLaunchAgents({
    serviceDefinitions: [{ label: "listener" }],
    destinationDirectory: directory,
    previous: new Map([["listener", backup]]),
    launchDomain: "gui/test",
    runLaunchctl: async (_path, args) => {
      if (args[0] === "bootstrap") throw new Error("simulated failure");
    },
  });

  assert.deepEqual(result, {
    complete: false,
    failedLabels: ["listener"],
  });
});

test("首次安装服务在回退后仍被加载时判定回退不完整", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-launchd-loaded-"));
  await writeFile(join(directory, "worker.plist"), "new-worker\n", {
    mode: 0o600,
  });
  const result = await restoreLaunchAgents({
    serviceDefinitions: [{ label: "worker" }],
    destinationDirectory: directory,
    previous: new Map(),
    launchDomain: "gui/test",
    runLaunchctl: async () => {},
  });

  assert.deepEqual(result, {
    complete: false,
    failedLabels: ["worker"],
  });
  await assert.rejects(stat(join(directory, "worker.plist")), { code: "ENOENT" });
});
