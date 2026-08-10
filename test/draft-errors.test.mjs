import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
      assert.match(error.message, /exit=1 stderrBytes=\d+ stderrSha256=[a-f0-9]{64}/u);
      assert.doesNotMatch(error.message, /tool failed with args/u);
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
      { codexPath: executable, timeoutMs: 5_000 },
    ),
    (error) => error.code === "CODEX_DRAFT_TIMEOUT",
  );
  const argumentsText = await readFile(argumentsFile, "utf8");
  assert.equal(argumentsText.includes(sensitive), false);
  assert.match(argumentsText, /exec --skip-git-repo-check --ephemeral/u);
  const childPid = Number(await readFile(childPidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

test("Codex 只接收最小会话字段且临时草稿会被删除", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-codex-clean-"));
  const executable = join(directory, "fake-codex");
  const promptFile = join(directory, "prompt.txt");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      "output=''",
      "while [ \"$#\" -gt 0 ]; do",
      "  if [ \"$1\" = '--output-last-message' ]; then shift; output=\"$1\"; fi",
      "  shift",
      "done",
      `cat > '${promptFile}'`,
      "printf '%s' '{\"shouldReply\":true,\"reply\":\"收到，我来看一下。\",\"reason\":\"需要处理\",\"riskLevel\":\"low\",\"confidence\":0.9}' > \"$output\"",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskId = "temporary-output-cleanup";
  await generateReplyDraft(
    {
      taskId,
      content: "帮我看看",
      messages: [
        { id: "secret-message-id", createTime: "2026-08-04T10:00:00Z", content: "帮我看看" },
      ],
    },
    {
      codexPath: executable,
      conversation: [
        {
          createTime: "2026-08-04T09:59:00Z",
          content: "上文",
          isSelf: false,
          senderUserId: "secret-user-id",
          raw: { gateway: "secret-gateway" },
        },
      ],
    },
  );
  const prompt = await readFile(promptFile, "utf8");
  assert.match(prompt, /帮我看看/u);
  assert.doesNotMatch(prompt, /secret-user-id|secret-message-id|secret-gateway/u);
  const outputPath = fileURLToPath(
    new URL(`../.runtime/drafts/${taskId}.response.json`, import.meta.url),
  );
  await assert.rejects(access(outputPath), { code: "ENOENT" });
});
