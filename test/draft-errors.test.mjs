import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateReplyDraft } from "../src/draft.mjs";

test("Codex 执行失败不会把消息正文带入错误日志", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-codex-"));
  const executable = join(directory, "fake-codex");
  await writeFile(
    executable,
    "#!/bin/sh\nprintf 'tool failed with args: %s' \"$*\" >&2\nexit 1\n",
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sensitive = "这是一条不能进入日志的私聊正文";
  await assert.rejects(
    generateReplyDraft(
      {
        taskId: "sanitized-error",
        content: sensitive,
        messages: [{ content: sensitive }],
      },
      { codexPath: executable },
    ),
    (error) => {
      assert.equal(error.code, "CODEX_DRAFT_EXECUTION");
      assert.equal(error.message.includes(sensitive), false);
      return true;
    },
  );
});

test("Codex 超时会终止整个进程组且正文只从 stdin 传入", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-codex-timeout-"));
  const executable = join(directory, "fake-codex");
  const argumentsFile = join(directory, "arguments.txt");
  const childPidFile = join(directory, "child.pid");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      `printf '%s' "$*" > "${argumentsFile}"`,
      `sleep 30 & echo $! > "${childPidFile}"`,
      "cat >/dev/null",
      "wait",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sensitive = "只允许通过标准输入传递的私聊正文";
  await assert.rejects(
    generateReplyDraft(
      {
        taskId: "timeout-process-group",
        content: sensitive,
        messages: [{ content: sensitive }],
      },
      { codexPath: executable, timeoutMs: 2_000 },
    ),
    (error) => error.code === "CODEX_DRAFT_TIMEOUT",
  );
  const argumentsText = await readFile(argumentsFile, "utf8");
  assert.equal(argumentsText.includes(sensitive), false);
  const childPid = Number(await readFile(childPidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});
