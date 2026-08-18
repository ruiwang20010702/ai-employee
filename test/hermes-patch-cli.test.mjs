import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("Hermes 补丁层准备命令默认零写且只报告绑定摘要", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/准备Hermes补丁层.mjs"],
    {
      cwd: new URL("../", import.meta.url),
      env: { HOME: process.env.HOME, PATH: process.env.PATH },
      timeout: 30_000,
    },
  );
  const result = JSON.parse(stdout);
  assert.deepEqual(result, {
    valid: true,
    apply: false,
    baseCommit: "e624e9fde561e1add9388384012b295fde669ade",
    patchCount: 1,
    upstreamWrite: false,
    productionWrite: false,
  });
});
