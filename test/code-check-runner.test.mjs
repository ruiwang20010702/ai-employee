import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverCodeCheck,
  runCodeCheck,
} from "../scripts/运行代码检查.mjs";

async function fixture(t, { withTests = false, invalid = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ai-code-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, "src")),
    mkdir(join(root, "scripts")),
    mkdir(join(root, "plugins", "example"), { recursive: true }),
    withTests ? mkdir(join(root, "test")) : Promise.resolve(),
  ]);
  await Promise.all([
    writeFile(join(root, "src", "main.mjs"), invalid ? "export const = ;\n" : "export const value = 1;\n"),
    writeFile(join(root, "scripts", "tool.mjs"), "export const tool = true;\n"),
    writeFile(join(root, "plugins", "example", "server.mjs"), "export const server = true;\n"),
    withTests
      ? writeFile(join(root, "test", "basic.test.mjs"), "import test from 'node:test'; test('ok',()=>{});\n")
      : Promise.resolve(),
  ]);
  return root;
}

test("安装包代码检查不依赖未发布的测试目录", async (t) => {
  const root = await fixture(t);
  const discovered = await discoverCodeCheck({ root });
  assert.equal(discovered.testFiles.length, 0);
  const result = await runCodeCheck({ root });
  assert.equal(result.valid, true);
  assert.equal(result.mode, "installed_package");
  assert.equal(result.tests, 0);
});

test("源码仓库代码检查会执行发现的测试", async (t) => {
  const root = await fixture(t, { withTests: true });
  const calls = [];
  const result = await runCodeCheck({
    root,
    runner: async (command, args) => calls.push({ command, args }),
  });
  assert.equal(result.mode, "source_with_tests");
  assert.equal(result.tests, 1);
  assert.equal(calls.filter((call) => call.args.includes("--test")).length, 1);
});

test("安装包中任一生产模块语法错误都会阻断检查", async (t) => {
  const root = await fixture(t, { invalid: true });
  await assert.rejects(runCodeCheck({ root }), /代码检查失败/u);
});
