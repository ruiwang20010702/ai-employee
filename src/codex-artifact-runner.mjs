import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { safeCodexEnvironment } from "./codex-environment.mjs";

const outputDirectory = new URL("../.runtime/work-plan-temp/", import.meta.url);

function runProcess({ codexPath, args, prompt, timeoutMs, signal = null }) {
  if (signal?.aborted) {
    const error = new Error("Codex work execution interrupted before start");
    error.code = "WORK_PLAN_CANCELLED";
    return Promise.reject(error);
  }
  return new Promise((resolveRun, rejectRun) => {
    const stderrHash = createHash("sha256");
    let stderrBytes = 0;
    const child = spawn(codexPath, args, {
      detached: true,
      env: safeCodexEnvironment(codexPath),
      stdio: ["pipe", "ignore", "pipe"],
    });
    let settled = false;
    let timedOut = false;
    let interrupted = false;
    let forceKillTimer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", interrupt);
      if (error) rejectRun(error);
      else resolveRun();
    };
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      forceKillTimer = setTimeout(() => killGroup("SIGKILL"), 2_000);
      forceKillTimer.unref();
    }, timeoutMs);
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
    const executionError = (exitCode = null) =>
      new Error(
        `Codex work execution failed [exit=${exitCode ?? "spawn"} stderrBytes=${stderrBytes} stderrSha256=${stderrHash.copy().digest("hex")}]`,
      );
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      stderrHash.update(chunk);
    });
    child.once("error", () => finish(executionError()));
    child.once("close", (code) => {
      if (interrupted) {
        const error = new Error("Codex work execution interrupted by operator");
        error.code = "WORK_PLAN_CANCELLED";
        finish(error);
      } else if (timedOut) finish(new Error("Codex work execution timeout"));
      else if (code !== 0) finish(executionError(code));
      else finish();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

export async function runCodexArtifact({
  codexPath,
  workingDirectory,
  prompt,
  timeoutMs = 120_000,
  maxBytes = 256 * 1024,
  signal = null,
}) {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const outputPath = fileURLToPath(
    new URL(`${randomUUID()}.txt`, outputDirectory),
  );
  try {
    await runProcess({
      codexPath,
      args: [
        "--ask-for-approval",
        "never",
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--output-last-message",
        outputPath,
        "--cd",
        workingDirectory,
        "-",
      ],
      prompt,
      timeoutMs,
      signal,
    });
    const output = await readFile(outputPath, "utf8");
    const bytes = Buffer.byteLength(output);
    if (bytes === 0) throw new Error("Codex returned an empty artifact");
    if (bytes > maxBytes) throw new Error("Codex artifact exceeded size limit");
    return {
      output,
      bytes,
      sha256: createHash("sha256").update(output).digest("hex"),
    };
  } finally {
    await unlink(outputPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
