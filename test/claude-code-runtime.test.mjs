import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { assertAgentRuntime } from "../src/adapter-contracts.mjs";
import { ClaudeCodeAgentRuntime } from "../src/agent-runtime.mjs";

function fakeSpawn({ output, exitCode = 0, inspect }) {
  return (executable, args, options) => {
    const child = new EventEmitter();
    child.pid = 999_999;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const promptChunks = [];
    child.stdin.on("data", (chunk) => promptChunks.push(chunk));
    child.stdin.on("finish", () => {
      inspect?.({
        executable,
        args,
        options,
        prompt: Buffer.concat(promptChunks).toString("utf8"),
      });
      if (output) child.stdout.end(output);
      else child.stdout.end();
      child.stderr.end(exitCode === 0 ? "" : "sensitive provider failure");
      queueMicrotask(() => child.emit("close", exitCode));
    });
    return child;
  };
}

test("Claude Code implements the same read-only structured runtime contract", async () => {
  let invocation;
  const runtime = assertAgentRuntime(new ClaudeCodeAgentRuntime({
    executable: "/trusted/claude",
    environment: {
      HOME: "/Users/test",
      ANTHROPIC_API_KEY: "runtime-secret",
      DATABASE_URL: "must-not-leak",
    },
    spawnProcess: fakeSpawn({
      output: JSON.stringify({
        structured_output: {
          shouldReply: true,
          reply: "I will prepare the plan.",
        },
      }),
      inspect: (value) => {
        invocation = value;
      },
    }),
  }));
  const result = await runtime.generateDraft({
    prompt: "untrusted workplace message",
    schemaPath: new URL("../schemas/draft.schema.json", import.meta.url),
    workspacePath: "/tmp",
  });
  assert.equal(runtime.id, "claude-code");
  assert.deepEqual(result, {
    shouldReply: true,
    reply: "I will prepare the plan.",
  });
  assert.equal(invocation.executable, "/trusted/claude");
  assert.equal(invocation.prompt, "untrusted workplace message");
  assert.equal(invocation.options.env.ANTHROPIC_API_KEY, "runtime-secret");
  assert.equal(invocation.options.env.DATABASE_URL, undefined);
  assert.equal(invocation.options.detached, true);
  assert.deepEqual(invocation.args.slice(0, 5), [
    "--print",
    "--output-format",
    "json",
    "--json-schema",
    invocation.args[4],
  ]);
  assert.ok(invocation.args.includes("--safe-mode"));
  assert.ok(invocation.args.includes("--no-session-persistence"));
  assert.ok(invocation.args.includes("--disable-slash-commands"));
  assert.equal(invocation.args[invocation.args.indexOf("--tools") + 1], "");
  assert.equal(invocation.args[invocation.args.indexOf("--permission-mode") + 1], "plan");
});

test("Claude Code accepts the documented result JSON fallback", async () => {
  const runtime = new ClaudeCodeAgentRuntime({
    spawnProcess: fakeSpawn({
      output: JSON.stringify({ result: JSON.stringify({ ok: true }) }),
    }),
  });
  assert.deepEqual(await runtime.generateDraft({
    prompt: "fixture",
    schemaPath: new URL("../schemas/draft.schema.json", import.meta.url),
    workspacePath: "/tmp",
  }), { ok: true });
});

test("Claude Code failures expose only exit metadata and stderr hash", async () => {
  const sensitive = "private-message-body";
  const runtime = new ClaudeCodeAgentRuntime({
    spawnProcess: fakeSpawn({ exitCode: 7 }),
  });
  await assert.rejects(
    runtime.generateDraft({
      prompt: sensitive,
      schemaPath: new URL("../schemas/draft.schema.json", import.meta.url),
      workspacePath: "/tmp",
    }),
    (error) => {
      assert.equal(error.code, "AGENT_RUNTIME_EXECUTION");
      assert.match(error.message, /exit=7 stderrBytes=\d+ stderrSha256=[a-f0-9]{64}/u);
      assert.equal(error.message.includes(sensitive), false);
      assert.equal(error.message.includes("sensitive provider failure"), false);
      return true;
    },
  );
});

test("Claude Code rejects malformed structured output", async () => {
  const runtime = new ClaudeCodeAgentRuntime({
    spawnProcess: fakeSpawn({ output: "not-json" }),
  });
  await assert.rejects(
    runtime.generateDraft({
      prompt: "fixture",
      schemaPath: new URL("../schemas/draft.schema.json", import.meta.url),
      workspacePath: "/tmp",
    }),
    (error) =>
      error.code === "AGENT_RUNTIME_EXECUTION" &&
      error.message.includes("invalid_json_output"),
  );
});
