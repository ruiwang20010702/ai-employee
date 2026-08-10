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
      "printf '%s' '{\"shouldReply\":true,\"reply\":\"收到，我来看一下。\",\"reason\":\"需要处理\",\"riskLevel\":\"low\",\"confidence\":0.9,\"needsInformation\":false,\"relatedToWaitingTask\":false,\"workRequest\":null}' > \"$output\"",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskId = "temporary-output-cleanup";
  const result = await generateReplyDraft(
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
  assert.deepEqual(result.memoryCandidates, []);
  const prompt = await readFile(promptFile, "utf8");
  assert.match(prompt, /帮我看看/u);
  assert.doesNotMatch(prompt, /secret-user-id|secret-message-id|secret-gateway/u);
  const outputPath = fileURLToPath(
    new URL(`../.runtime/drafts/${taskId}.response.json`, import.meta.url),
  );
  await assert.rejects(access(outputPath), { code: "ENOENT" });
});

test("等待任务中的简短补充必须交给上下文判断而不是硬规则静默", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-waiting-fragment-"));
  const executable = join(directory, "fake-codex");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      "output=''",
      "while [ \"$#\" -gt 0 ]; do",
      "  if [ \"$1\" = '--output-last-message' ]; then shift; output=\"$1\"; fi",
      "  shift",
      "done",
      "cat >/dev/null",
      "printf '%s' '{\"shouldReply\":true,\"reply\":\"收到，按周五规划。\",\"reason\":\"回答了原追问\",\"riskLevel\":\"low\",\"confidence\":0.95,\"needsInformation\":false,\"relatedToWaitingTask\":true,\"workRequest\":null}' > \"$output\"",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await generateReplyDraft(
    {
      taskId: "waiting-short-fragment",
      content: "周五",
      messages: [{ content: "周五" }],
      waitingTask: {
        originalRequest: "帮我做上线方案",
        clarificationQuestion: "计划什么时候上线？",
      },
    },
    { codexPath: executable },
  );
  assert.equal(result.relatedToWaitingTask, true);
  assert.equal(result.decisionSource, "codex");
});

test("可执行工作请求必须同时生成回复草稿", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-work-reply-"));
  const executable = join(directory, "fake-codex");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      "output=''",
      "while [ \"$#\" -gt 0 ]; do",
      "  if [ \"$1\" = '--output-last-message' ]; then shift; output=\"$1\"; fi",
      "  shift",
      "done",
      "cat >/dev/null",
      "printf '%s' '{\"shouldReply\":false,\"reply\":\"\",\"reason\":\"请求执行工作\",\"riskLevel\":\"low\",\"confidence\":0.95,\"needsInformation\":false,\"relatedToWaitingTask\":false,\"workRequest\":{\"requested\":true,\"objective\":\"整理方案\",\"projectHint\":\"\"},\"memoryCandidates\":[]}' > \"$output\"",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    generateReplyDraft(
      {
        taskId: "work-request-needs-reply",
        content: "帮我整理一份方案",
        messages: [{ content: "帮我整理一份方案" }],
      },
      { codexPath: executable },
    ),
    /executable work request must include a reply draft/iu,
  );
});

test("记忆候选使用脱敏消息别名并回绑精确平台消息", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-memory-source-"));
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
      "printf '%s' '{\"shouldReply\":false,\"reply\":\"\",\"reason\":\"无需回复\",\"riskLevel\":\"low\",\"confidence\":0.95,\"needsInformation\":false,\"relatedToWaitingTask\":false,\"workRequest\":null,\"memoryCandidates\":[{\"type\":\"person\",\"statement\":\"对方偏好简短回复。\",\"factKey\":\"communication.reply_length\",\"sensitivity\":\"internal\",\"retentionDays\":90,\"confidence\":0.95,\"projectHint\":\"\",\"sourceMessageId\":\"message_0\"}]}' > \"$output\"",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await generateReplyDraft({
    taskId: "memory-source-alias",
    content: "以后请简短回复\n另外帮我看下方案",
    messages: [
      { id: "actual-first-message", content: "以后请简短回复" },
      { id: "actual-latest-message", content: "另外帮我看下方案" },
    ],
  }, { codexPath: executable });
  assert.equal(result.memoryCandidates[0].sourceMessageId, "actual-first-message");
  const prompt = await readFile(promptFile, "utf8");
  assert.match(prompt, /"sourceMessageId": "message_0"/u);
  assert.doesNotMatch(prompt, /actual-first-message|actual-latest-message/u);
});
