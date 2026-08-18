import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("Hermes distribution install defaults to a zero-write bounded plan", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/安装Hermes发行层.mjs"],
    {
      cwd: projectRoot,
      env: {
        HOME: process.env.HOME,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.valid, true);
  assert.equal(result.apply, false);
  assert.equal(result.productionWrite, false);
  assert.deepEqual(
    result.components.map((component) => component.id),
    [
      "dws-personal",
      "project-router",
      "high-risk-boundary",
      "profile",
      "project-work-skill",
    ],
  );
  assert.ok(Object.values(result.fileCounts).every((count) => count > 0));
});
