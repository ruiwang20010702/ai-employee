import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = new URL("../", import.meta.url);
const runtimeDir = new URL(".runtime/", projectRoot);
const draftsDir = new URL("drafts/", runtimeDir);
const pendingFile = new URL("pending-drafts.jsonl", runtimeDir);
const taskQueueFile = new URL("codex-task-queue.jsonl", runtimeDir);
const schemaFile = new URL("../schemas/draft.schema.json", import.meta.url);
const dwsPath = process.env.DWS_PATH ?? `${homedir()}/.local/bin/dws`;
const codexPath = process.env.CODEX_PATH ?? "/opt/homebrew/bin/codex";
const projectPath = fileURLToPath(projectRoot);
const schemaPath = fileURLToPath(schemaFile);

export function classifyMessage(content) {
  const text = String(content ?? "").trim();
  const normalized = text.replace(/[！!。.\s]+$/g, "").toLowerCase();
  const acknowledgements = new Set([
    "收到",
    "好的",
    "好",
    "ok",
    "okay",
    "行",
    "可以",
    "知道了",
    "明白",
    "谢谢",
    "多谢",
    "辛苦了",
    "嗯",
    "嗯嗯",
    "是的",
    "是滴",
    "没问题",
  ]);
  if (!text || acknowledgements.has(normalized)) {
    return {
      decision: "no_reply",
      kind: "closed",
      reason: "对方只是确认、致谢或结束对话。",
    };
  }

  if (
    /(不用回|无需回复|不用回复|先不用管|你先忙|晚点再说|之后再说|回头再聊)/i.test(
      text,
    )
  ) {
    return {
      decision: "no_reply",
      kind: "explicit_no_reply",
      reason: "对方明确表示不需要当前回复。",
    };
  }

  if (
    /^(\[?(图片|表情|文件|视频|语音|链接|聊天记录)\]?|[👍👌🙏😂🤣😊🙂😀😁]+)$/u.test(
      normalized,
    )
  ) {
    return {
      decision: "no_reply",
      kind: "attachment_or_reaction",
      reason: "只有表情或附件占位，没有可处理的问题。",
    };
  }

  if (
    /^(收到请回复|你有一条新的|系统通知|自动提醒|本消息由系统自动发送)/i.test(
      normalized,
    )
  ) {
    return {
      decision: "no_reply",
      kind: "automated_notice",
      reason: "这是自动通知，不代表对方提出了任务。",
    };
  }

  const actionable =
    /[?？]/.test(text) ||
    /(帮我|麻烦|请你|能否|可不可以|可以吗|怎么|如何|为什么|什么时候|多久|看一下|确认一下|回复一下|发我|给我|需要你|等你|轮到你)/i.test(
      text,
    ) ||
    /(出问题|报错|失败|异常|阻塞|来不及|延期|紧急|尽快|马上)/i.test(text) ||
    /(方案|需求|代码|开发|测试|上线|部署|排期|优化|处理|修复|设计|评审)/i.test(
      text,
    );

  if (actionable) {
    return {
      decision: "queue_codex",
      kind: "actionable",
      reason: "消息包含问题、请求、任务、风险或决策事项。",
    };
  }

  if (
    text.length <= 6 &&
    !/[，,。.!！;；:：]/.test(text) &&
    !/(到了|好了|完成|结束|开始|可以|不行)/i.test(text)
  ) {
    return {
      decision: "no_reply",
      kind: "possible_fragment",
      reason: "消息很短且像连续输入片段，先等待对方补充。",
    };
  }

  return {
    decision: "no_reply",
    kind: "informational",
    reason: "这是一条告知性消息，没有明确问题或行动要求。",
  };
}

function localTimestamp(date) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

async function fetchConversation(userId) {
  const now = new Date();
  const { stdout } = await execFileAsync(
    dwsPath,
    [
      "chat",
      "message",
      "list-direct",
      "--user",
      userId,
      "--time",
      localTimestamp(now),
      "--forward",
      "false",
      "--limit",
      "30",
      "-f",
      "json",
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const messages = JSON.parse(stdout)?.result?.messages ?? [];
  return messages
    .slice()
    .reverse()
    .map((message) => ({
      sender: message.sender,
      createTime: message.createTime,
      content: message.content,
    }));
}

async function appendPending(draft) {
  const previous = await readFile(pendingFile, "utf8").catch(() => "");
  await writeFile(pendingFile, `${previous}${JSON.stringify(draft)}\n`);
}

async function appendTask(task) {
  const previous = await readFile(taskQueueFile, "utf8").catch(() => "");
  await writeFile(taskQueueFile, `${previous}${JSON.stringify(task)}\n`);
}

export async function generateDraft(event) {
  const classification = classifyMessage(event.content);
  const key = createHash("sha256").update(event.messageId).digest("hex").slice(0, 16);
  await mkdir(draftsDir, { recursive: true });

  if (classification.decision === "no_reply") {
    const draft = {
      type: "dingtalk.reply.draft",
      status: "pending",
      createdAt: new Date().toISOString(),
      sourceMessageId: event.messageId,
      conversationId: event.conversationId,
      recipientUserId: event.senderUserId,
      recipientName: event.sender,
      sourceContent: event.content,
      shouldReply: false,
      reply: "",
      confidence:
        classification.kind === "closed" ||
        classification.kind === "explicit_no_reply"
          ? 0.99
          : 0.82,
      riskLevel: "low",
      reason: classification.reason,
      decisionSource: "local-rule",
      decisionKind: classification.kind,
    };
    const draftFile = new URL(`${key}.json`, draftsDir);
    await writeFile(draftFile, `${JSON.stringify(draft, null, 2)}\n`);
    await appendPending(draft);
    return draft;
  }

  if (
    classification.decision === "queue_codex" &&
    process.env.DINGTALK_CODEX_INLINE !== "true"
  ) {
    const task = {
      type: "codex.task.queued",
      status: "queued",
      createdAt: new Date().toISOString(),
      sourceMessageId: event.messageId,
      conversationId: event.conversationId,
      recipientUserId: event.senderUserId,
      recipientName: event.sender,
      sourceContent: event.content,
      queueReason: classification.reason,
    };
    await appendTask(task);
    return task;
  }

  const conversation = await fetchConversation(event.senderUserId);
  const outputFile = new URL(`${key}.response.json`, draftsDir);
  const outputPath = fileURLToPath(outputFile);

  const prompt = [
    "你是负责人的钉钉回复草稿助手。只生成草稿，不发送消息，不调用任何外部工具，不修改任何文件。",
    "根据下面的单聊上下文判断最新消息是否需要回复。",
    "要求：简洁自然；不编造事实；涉及金额、承诺、排期、人事、合同、生产发布或不确定事实时风险至少为 medium；",
    "若只是“收到”“好的”等已经闭环的确认，可以 shouldReply=false 且 reply 为空字符串。",
    "聊天记录（按时间从旧到新）：",
    JSON.stringify(conversation.slice(-12), null, 2),
    `待处理消息 ID：${event.messageId}`,
  ].join("\n\n");

  await execFileAsync(
    codexPath,
    [
      "--ask-for-approval",
      "never",
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "--cd",
      projectPath,
      prompt,
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
  );

  const response = JSON.parse(await readFile(outputPath, "utf8"));
  const draft = {
    type: "dingtalk.reply.draft",
    status: "pending",
    createdAt: new Date().toISOString(),
    sourceMessageId: event.messageId,
    conversationId: event.conversationId,
    recipientUserId: event.senderUserId,
    recipientName: event.sender,
    sourceContent: event.content,
    decisionSource: "codex",
    ...response,
  };
  const draftFile = new URL(`${key}.json`, draftsDir);
  await writeFile(draftFile, `${JSON.stringify(draft, null, 2)}\n`);
  await appendPending(draft);
  return draft;
}
