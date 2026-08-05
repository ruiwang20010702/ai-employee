import assert from "node:assert/strict";
import test from "node:test";
import { runStructuredDraftProbe } from "../src/codex-draft-probe.mjs";

test("structured draft probe uses synthetic data and exposes no reply", async () => {
  const ticks = [1000, 1450];
  const result = await runStructuredDraftProbe({
    codexPath: "codex",
    now: () => ticks.shift(),
    generateDraft: async (event, options) => {
      assert.match(event.taskId, /^synthetic_probe_/u);
      assert.equal(event.content, "请确认收到这条结构化草稿测试消息。");
      assert.equal(options.codexPath, "codex");
      assert.deepEqual(options.conversation, []);
      assert.deepEqual(options.memories, []);
      return {
        shouldReply: true,
        reply: "收到。",
        riskLevel: "low",
        decisionSource: "codex",
        workRequest: null,
      };
    },
  });
  assert.deepEqual(result, {
    passed: true,
    probe: "structured_draft",
    durationMs: 450,
    schemaValidated: true,
    businessDataUsed: false,
    replyContentStored: false,
  });
  assert.equal("reply" in result, false);
});

test("structured draft probe rejects a non-Codex or work-request result", async () => {
  await assert.rejects(
    () => runStructuredDraftProbe({
      codexPath: "codex",
      generateDraft: async () => ({
        shouldReply: true,
        reply: "收到。",
        riskLevel: "low",
        decisionSource: "hard-rule",
        workRequest: null,
      }),
    }),
    /unexpected shape/u,
  );
});
