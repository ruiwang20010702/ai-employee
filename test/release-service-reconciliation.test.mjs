import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileVersionServices } from "../scripts/清理版本外常驻服务.mjs";

test("版本服务对账会备份并卸载目标版本不再包含的服务", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-employee-services-"));
  const release = join(root, "release");
  const generated = join(release, ".runtime", "launchd");
  const destination = join(root, "LaunchAgents");
  await mkdir(generated, { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(join(generated, "com.ai-employee.listener.plist"), "new");
  await writeFile(join(destination, "com.ai-employee.listener.plist"), "current");
  await writeFile(join(destination, "com.ai-employee.memory-source.plist"), "stale");
  await writeFile(join(destination, "com.ai-employee.postgresql.plist"), "database");
  await writeFile(join(destination, "com.example.unrelated.plist"), "keep");

  const calls = [];
  const result = await reconcileVersionServices({
    releaseDirectory: release,
    destinationDirectory: destination,
    runLaunchctl: async (_file, args) => {
      calls.push(args);
      if (args[0] === "print") throw new Error("not loaded");
    },
  });

  assert.deepEqual(result.removed, ["com.ai-employee.memory-source"]);
  assert.equal(await readFile(join(destination, "com.ai-employee.listener.plist"), "utf8"), "current");
  assert.equal(await readFile(join(destination, "com.example.unrelated.plist"), "utf8"), "keep");
  assert.equal(await readFile(join(destination, "com.ai-employee.postgresql.plist"), "utf8"), "database");
  assert.equal((await readdir(destination)).includes("com.ai-employee.memory-source.plist"), false);
  assert.equal(await readFile(join(result.backupDirectory, "com.ai-employee.memory-source.plist"), "utf8"), "stale");
  assert.equal(calls.some((args) => args[0] === "bootout"), true);
});

test("版本服务对账在没有版本外服务时不修改 LaunchAgents", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-employee-services-clean-"));
  const release = join(root, "release");
  const generated = join(release, ".runtime", "launchd");
  const destination = join(root, "LaunchAgents");
  await mkdir(generated, { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(join(generated, "com.ai-employee.listener.plist"), "new");
  await writeFile(join(destination, "com.ai-employee.listener.plist"), "current");

  const result = await reconcileVersionServices({
    releaseDirectory: release,
    destinationDirectory: destination,
    runLaunchctl: async () => assert.fail("不应调用 launchctl"),
  });
  assert.deepEqual(result, { reconciled: true, removed: [], backupDirectory: null });
});
