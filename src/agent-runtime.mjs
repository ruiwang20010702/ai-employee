import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  adapterContractVersion,
  assertAgentRuntime,
  assertModelProvider,
} from "./adapter-contracts.mjs";
import { safeCodexEnvironment } from "./codex-environment.mjs";

function safeClaudeEnvironment(executable, source = process.env) {
  const environment = safeCodexEnvironment(executable, source);
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
    if (typeof source[name] === "string" && source[name] !== "") {
      environment[name] = source[name];
    }
  }
  return environment;
}

function runtimeError(runtimeId, kind, detail) {
  const error = new Error(`${runtimeId} draft ${kind} failed${detail ? ` [${detail}]` : ""}`);
  error.code = `AGENT_RUNTIME_${kind.toUpperCase()}`;
  return error;
}

function runtimeCancelled(runtimeId) {
  const error = new Error(`${runtimeId} draft cancelled`);
  error.code = "WORK_PLAN_CANCELLED";
  return error;
}

export class CodexAgentRuntime {
  constructor({
    executable = process.env.CODEX_PATH ?? "codex",
    environment = process.env,
    spawnProcess = spawn,
  } = {}) {
    this.id = "codex";
    this.decisionSource = "codex";
    this.contractVersion = adapterContractVersion;
    this.executable = executable;
    this.environment = environment;
    this.spawnProcess = spawnProcess;
  }

  async generateDraft({
    prompt,
    schemaPath,
    workspacePath,
    outputDirectory,
    timeoutMs = 120_000,
    signal = null,
  }) {
    if (signal?.aborted) throw runtimeCancelled("Codex");
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    await chmod(outputDirectory, 0o700);
    const temporaryDirectory = await mkdtemp(join(outputDirectory, "runtime-"));
    await chmod(temporaryDirectory, 0o700);
    const outputPath = join(temporaryDirectory, "draft.json");
    try {
      await new Promise((resolveRun, rejectRun) => {
        const stderrHash = createHash("sha256");
        let stderrBytes = 0;
        const child = this.spawnProcess(this.executable, [
          "--ask-for-approval",
          "never",
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          "--cd",
          workspacePath,
          "-",
        ], {
          detached: true,
          env: safeCodexEnvironment(this.executable, this.environment),
          stdio: ["pipe", "ignore", "pipe"],
        });
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let forceKillTimer;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutTimer);
          clearTimeout(forceKillTimer);
          signal?.removeEventListener("abort", onAbort);
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
        const onAbort = () => {
          if (settled || timedOut || cancelled) return;
          cancelled = true;
          try {
            killGroup("SIGTERM");
            forceKillTimer = setTimeout(() => killGroup("SIGKILL"), 2_000);
            forceKillTimer.unref();
          } catch (error) {
            finish(runtimeCancelled("Codex"));
          }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const executionError = (exitCode = null) => runtimeError(
          "Codex",
          "execution",
          `exit=${exitCode ?? "spawn"} stderrBytes=${stderrBytes} stderrSha256=${stderrHash.copy().digest("hex")}`,
        );
        child.stderr.on("data", (chunk) => {
          stderrBytes += chunk.length;
          stderrHash.update(chunk);
        });
        child.once("error", () => finish(executionError()));
        child.once("close", (code) => {
          if (cancelled) finish(runtimeCancelled("Codex"));
          else if (timedOut) finish(runtimeError("Codex", "timeout"));
          else if (code !== 0) finish(executionError(code));
          else finish();
        });
        child.stdin.on("error", () => {});
        child.stdin.end(prompt);
      });
      return JSON.parse(await readFile(outputPath, "utf8"));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export class ModelProviderAgentRuntime {
  constructor(provider) {
    assertModelProvider(provider);
    this.provider = provider;
    this.id = `model-provider.${provider.id}`;
    this.decisionSource = "model";
    this.contractVersion = adapterContractVersion;
  }

  async generateDraft({ prompt, schemaPath, timeoutMs, context, signal }) {
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    return this.provider.generateStructured({
      prompt,
      schema,
      timeoutMs,
      context,
      signal,
    });
  }
}

export class ClaudeCodeAgentRuntime {
  constructor({
    executable = process.env.CLAUDE_CODE_PATH ?? "claude",
    environment = process.env,
    spawnProcess = spawn,
  } = {}) {
    this.id = "claude-code";
    this.decisionSource = "claude-code";
    this.contractVersion = adapterContractVersion;
    this.executable = executable;
    this.environment = environment;
    this.spawnProcess = spawnProcess;
  }

  async generateDraft({
    prompt,
    schemaPath,
    workspacePath,
    timeoutMs = 120_000,
    signal = null,
  }) {
    if (signal?.aborted) throw runtimeCancelled("ClaudeCode");
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const stdout = await new Promise((resolveRun, rejectRun) => {
      const stderrHash = createHash("sha256");
      let stderrBytes = 0;
      let stdoutBytes = 0;
      const chunks = [];
      const child = this.spawnProcess(this.executable, [
        "--print",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(schema),
        "--tools",
        "",
        "--permission-mode",
        "plan",
        "--disable-slash-commands",
        "--safe-mode",
        "--no-session-persistence",
      ], {
        cwd: workspacePath,
        detached: true,
        env: safeClaudeEnvironment(this.executable, this.environment),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let forceKillTimer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(forceKillTimer);
        signal?.removeEventListener("abort", onAbort);
        if (error) rejectRun(error);
        else resolveRun(Buffer.concat(chunks).toString("utf8"));
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
      const onAbort = () => {
        if (settled || timedOut || cancelled) return;
        cancelled = true;
        try {
          killGroup("SIGTERM");
          forceKillTimer = setTimeout(() => killGroup("SIGKILL"), 2_000);
          forceKillTimer.unref();
        } catch (error) {
          finish(runtimeCancelled("ClaudeCode"));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const executionError = (exitCode = null) => runtimeError(
        "ClaudeCode",
        "execution",
        "exit=" + (exitCode ?? "spawn") +
          " stderrBytes=" + stderrBytes +
          " stderrSha256=" + stderrHash.copy().digest("hex"),
      );
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 8 * 1024 * 1024) {
          killGroup("SIGTERM");
          finish(runtimeError("ClaudeCode", "execution", "stdout_limit"));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        stderrHash.update(chunk);
      });
      child.once("error", () => finish(executionError()));
      child.once("close", (code) => {
        if (cancelled) finish(runtimeCancelled("ClaudeCode"));
        else if (timedOut) finish(runtimeError("ClaudeCode", "timeout"));
        else if (code !== 0) finish(executionError(code));
        else finish();
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
    let envelope;
    try {
      envelope = JSON.parse(stdout);
    } catch (error) {
      throw runtimeError("ClaudeCode", "execution", "invalid_json_output");
    }
    if (envelope?.structured_output && typeof envelope.structured_output === "object") {
      return envelope.structured_output;
    }
    if (typeof envelope?.result === "string") {
      try {
        return JSON.parse(envelope.result);
      } catch (error) {
        throw runtimeError("ClaudeCode", "execution", "invalid_structured_output");
      }
    }
    if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
      return envelope;
    }
    throw runtimeError("ClaudeCode", "execution", "missing_structured_output");
  }
}

assertAgentRuntime(new CodexAgentRuntime());
assertAgentRuntime(new ClaudeCodeAgentRuntime());
