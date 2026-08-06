import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { validateReleaseRollbackGate } from "../src/release-rollback-gate.mjs";

function argument(name, { required = true } = {}) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && !value) throw new Error(`缺少参数：${name}`);
  return value ?? "";
}

try {
  const release = realpathSync(resolve(argument("--release")));
  const previousInput = argument("--previous", { required: false });
  const previousRelease = previousInput
    ? realpathSync(resolve(previousInput))
    : "";
  const output = execFileSync(
    "npm",
    ["run", "--silent", "production:preflight"],
    {
      cwd: release,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const preflight = JSON.parse(output);
  console.log(JSON.stringify({
    ...validateReleaseRollbackGate({ preflight, previousRelease }),
    preflight,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ valid: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
