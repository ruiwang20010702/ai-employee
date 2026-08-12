import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ClaudeCodeAgentRuntime, CodexAgentRuntime } from "../src/agent-runtime.mjs";

function pendingSpawn(capture) {
  return () => {
    const child = new EventEmitter();
    child.pid = 999_999;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    capture.child = child;
    return child;
  };
}

async function cancellationFixture(Runtime, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "foursday-runtime-cancel-"));
  const schemaPath = join(root, "schema.json");
  await writeFile(schemaPath, '{"type":"object"}\n');
  const capture = {};
  const runtime = new Runtime({
    executable: "/trusted/runtime",
    spawnProcess: pendingSpawn(capture),
  });
  const controller = new AbortController();
  const run = runtime.generateDraft({
    prompt: "generate a patch",
    schemaPath,
    workspacePath: root,
    outputDirectory: root,
    signal: controller.signal,
    ...options,
  });
  while (!capture.child) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  capture.child.emit("close", null, "SIGTERM");
  await assert.rejects(run, (error) => error.code === "WORK_PLAN_CANCELLED");
  await rm(root, { recursive: true, force: true });
}

test("Codex artifact generation stops when a governed plan is cancelled", async () => {
  await cancellationFixture(CodexAgentRuntime);
});

test("Claude Code artifact generation stops when a governed plan is cancelled", async () => {
  await cancellationFixture(ClaudeCodeAgentRuntime);
});

test("an already-cancelled signal never starts a model subprocess", async () => {
  let spawned = false;
  const controller = new AbortController();
  controller.abort();
  const runtime = new ClaudeCodeAgentRuntime({
    spawnProcess() {
      spawned = true;
      throw new Error("must not spawn");
    },
  });
  await assert.rejects(
    runtime.generateDraft({
      prompt: "fixture",
      schemaPath: new URL("../schemas/draft.schema.json", import.meta.url),
      workspacePath: "/tmp",
      signal: controller.signal,
    }),
    (error) => error.code === "WORK_PLAN_CANCELLED",
  );
  assert.equal(spawned, false);
});
