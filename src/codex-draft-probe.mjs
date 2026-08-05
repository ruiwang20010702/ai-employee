import { randomUUID } from "node:crypto";
import { generateReplyDraft } from "./draft.mjs";

export async function runStructuredDraftProbe({
  codexPath,
  generateDraft = generateReplyDraft,
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  const createTime = new Date().toISOString();
  const result = await generateDraft(
    {
      taskId: `synthetic_probe_${randomUUID()}`,
      chatType: "direct",
      content: "请确认收到这条结构化草稿测试消息。",
      messages: [
        {
          createTime,
          content: "请确认收到这条结构化草稿测试消息。",
        },
      ],
    },
    {
      codexPath,
      conversation: [],
      memories: [],
      timeoutMs: 120_000,
    },
  );
  if (
    result.decisionSource !== "codex" ||
    typeof result.shouldReply !== "boolean" ||
    typeof result.reply !== "string" ||
    !["low", "medium", "high"].includes(result.riskLevel) ||
    result.workRequest != null
  ) {
    throw new Error("Codex structured draft probe returned an unexpected shape");
  }
  return {
    passed: true,
    probe: "structured_draft",
    durationMs: Math.max(0, now() - startedAt),
    schemaValidated: true,
    businessDataUsed: false,
    replyContentStored: false,
  };
}
