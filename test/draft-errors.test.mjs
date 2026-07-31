import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
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
