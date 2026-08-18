import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("Hermes 候选准备命令默认只输出隔离计划且零写入", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/准备Hermes候选.mjs"],
    {
      cwd: new URL("../", import.meta.url),
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
      },
      timeout: 30_000,
    },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.valid, true);
  assert.equal(result.apply, false);
  assert.equal(result.operationCount, 8);
  assert.equal(result.productionWrite, false);
  assert.equal(result.existingHermesTouched, false);
  assert.equal(result.release, "v2026.8.18");
  assert.equal(result.commit, "e624e9fde561e1add9388384012b295fde669ade");
  assert.equal("commands" in result, false);
  assert.equal("home" in result, false);
});
