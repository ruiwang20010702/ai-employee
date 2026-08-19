import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";

const python = String(process.env.FOURSDAY_HERMES_PYTHON ?? "").trim();
if (!isAbsolute(python)) {
  throw new Error("FOURSDAY_HERMES_PYTHON must be an absolute executable path");
}
await access(python, constants.X_OK);

const child = spawn(python, [
  "-m",
  "hermes_cli.main",
  "gateway",
  "run",
  "--replace",
  "--force",
  "--external-supervisor",
  "--accept-hooks",
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode == null && child.signalCode == null) child.kill(signal);
  });
}

child.on("error", (error) => {
  process.stderr.write(`hermes_gateway_spawn_failed:${String(error.code ?? "error")}\n`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exitCode = stopping ? 0 : 1;
    return;
  }
  process.exitCode = Number.isInteger(code) ? code : 1;
});
