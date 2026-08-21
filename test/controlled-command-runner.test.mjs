import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runControlledCommand } from "../src/controlled-command-runner.mjs";

test("受控命令收到人工中断后终止进程组并留下确认凭据", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-command-interrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "long-command");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      "trap 'exit 143' TERM",
      "while :; do sleep 1; done",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const controller = new AbortController();
  const startedAt = Date.now();
  const running = runControlledCommand({
    commandId: "长任务",
    command: {
      executable,
      args: [],
      timeoutMs: 30_000,
      maxOutputBytes: 10_000,
    },
    workingDirectory: directory,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50).unref();
  await assert.rejects(running, (error) => {
    assert.equal(error.code, "WORK_PLAN_CANCELLED");
    assert.equal(
      error.executionEvidence.verification,
      "operator_interrupt_confirmed",
    );
    assert.equal(error.executionEvidence.outputStored, false);
    return true;
  });
  assert.ok(Date.now() - startedAt < 2_000);
});
