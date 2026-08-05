import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { basename, dirname } from "node:path";

export function safeCommandEnvironment(executable) {
  const allowed = ["HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"];
  const environment = Object.fromEntries(
    allowed
      .filter((name) => typeof process.env[name] === "string")
      .map((name) => [name, process.env[name]]),
  );
  return {
    ...environment,
    PATH: [
      dirname(executable),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
    CI: "1",
    NO_COLOR: "1",
  };
}

export async function runControlledCommand({
  commandId,
  command,
  workingDirectory,
  now = () => Date.now(),
  signal = null,
}) {
  await access(command.executable, constants.X_OK);
  if (signal?.aborted) {
    const error = new Error("Controlled command interrupted before start");
    error.code = "WORK_PLAN_CANCELLED";
    throw error;
  }
  const startedAt = now();
  return new Promise((resolveRun, rejectRun) => {
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let interrupted = false;
    let settled = false;
    let forceKillTimer;
    const child = spawn(command.executable, command.args, {
      cwd: workingDirectory,
      detached: true,
      env: safeCommandEnvironment(command.executable),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const evidence = (exitCode, terminationSignal = null) => ({
      kind: "controlled_command",
      commandId,
      executable: basename(command.executable),
      args: command.args,
      exitCode,
      durationMs: Math.max(0, now() - startedAt),
      stdoutBytes,
      stderrBytes,
      stdoutSha256: stdoutHash.digest("hex"),
      stderrSha256: stderrHash.digest("hex"),
      verification: interrupted
        ? "operator_interrupt_confirmed"
        : exitCode === 0
          ? "exit_code_zero"
          : "exit_code_nonzero",
      terminationSignal,
      outputStored: false,
    });
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const fail = (message, exitCode = null, terminationSignal = null) => {
      const error = new Error(message);
      if (interrupted) error.code = "WORK_PLAN_CANCELLED";
      error.executionEvidence = evidence(exitCode, terminationSignal);
      rejectRun(error);
    };
    const finish = (code, terminationSignal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", interrupt);
      if (interrupted) {
        fail("Controlled command interrupted by operator", code, terminationSignal);
      } else if (timedOut) fail("Controlled command timeout", code, terminationSignal);
      else if (outputExceeded) fail("Controlled command output exceeded limit", code);
      else if (code !== 0) fail("Controlled command failed", code);
      else resolveRun(evidence(code));
    };
    const consume = (hash, kind) => (chunk) => {
      hash.update(chunk);
      if (kind === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (
        !outputExceeded &&
        stdoutBytes + stderrBytes > command.maxOutputBytes
      ) {
        outputExceeded = true;
        killGroup("SIGTERM");
        forceKillTimer = setTimeout(() => killGroup("SIGKILL"), 2_000);
        forceKillTimer.unref();
      }
    };
    child.stdout.on("data", consume(stdoutHash, "stdout"));
    child.stderr.on("data", consume(stderrHash, "stderr"));
    child.once("error", () => finish(null));
    child.once("close", finish);
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      forceKillTimer = setTimeout(() => killGroup("SIGKILL"), 2_000);
      forceKillTimer.unref();
    }, command.timeoutMs);
    timeoutTimer.unref();
    function interrupt() {
      if (settled || interrupted) return;
      interrupted = true;
      clearTimeout(timeoutTimer);
      killGroup("SIGTERM");
      forceKillTimer = setTimeout(() => killGroup("SIGKILL"), 2_000);
      forceKillTimer.unref();
    }
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
  });
}
