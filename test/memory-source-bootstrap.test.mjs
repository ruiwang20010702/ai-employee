import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  initializeMemorySource,
  memorySourceBootstrapPlan,
  memorySourceConfigValues,
} from "../src/memory-source-bootstrap.mjs";

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "foursday-memory-init-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, ".runtime", "production.json");
  await mkdir(join(directory, ".runtime"), { recursive: true });
  await writeFile(configPath, "{}\n", { mode: 0o600 });
  return { directory, configPath };
}

test("记忆源预览固定独立非联邦 source 且不打开自动能力", async (t) => {
  const { configPath } = await fixture(t);
  const plan = memorySourceBootstrapPlan({ configPath });
  assert.equal(plan.sourceId, "foursday");
  assert.equal(plan.federated, false);
  assert.equal(plan.writeEnabled, false);
  assert.equal(plan.autoConfirm, false);
  assert.deepEqual(memorySourceConfigValues(plan), {
    AI_EMPLOYEE_MEMORY_AUTHORITY_MODE: "gbrain",
    AI_EMPLOYEE_MEMORY_AUTHORITY_ROOT: plan.root,
    AI_EMPLOYEE_MEMORY_AUTHORITY_SOURCE_ID: "foursday",
    AI_EMPLOYEE_MEMORY_AUTHORITY_WRITE: false,
    AI_EMPLOYEE_MEMORY_AUTHORITY_AUTO_CONFIRM: false,
    AI_EMPLOYEE_MEMORY_AUTHORITY_AUTO_CONFIRM_MIN_CONFIDENCE: 0.95,
  });
});

test("显式初始化创建七类目录、独立 Git 和非联邦 gbrain source", async (t) => {
  const { configPath } = await fixture(t);
  const gbrainCalls = [];
  const run = async (path, args, options) => {
    if (path === "/usr/bin/git") return execFileAsync(path, args, options);
    gbrainCalls.push({ path, args, options });
    return { stdout: "created" };
  };
  const first = await initializeMemorySource({
    configPath,
    gbrainPath: "/trusted/gbrain",
    run,
  });
  assert.equal(first.createdFiles, 9);
  assert.equal(first.registered, true);
  for (const directory of first.directories) {
    await access(join(first.root, directory, "README.md"));
  }
  assert.match(await readFile(join(first.root, "README.md"), "utf8"), /Working memory remains/u);
  assert.deepEqual(gbrainCalls[0].args, [
    "sources", "add", "foursday", "--path", first.root,
    "--name", "Foursday memory", "--no-federated",
  ]);
  const second = await initializeMemorySource({
    configPath,
    gbrainPath: "/trusted/gbrain",
    run,
  });
  assert.equal(second.createdFiles, 0);
});

test("记忆源初始化拒绝通过符号链接离开配置目录", async (t) => {
  const { directory, configPath } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "foursday-memory-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(directory, ".runtime", "gbrain"));
  await assert.rejects(initializeMemorySource({
    configPath,
    gbrainPath: "/trusted/gbrain",
    run: async () => ({ stdout: "" }),
  }), /symbolic link/u);
});
