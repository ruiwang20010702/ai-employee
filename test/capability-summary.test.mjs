import assert from "node:assert/strict";
import test from "node:test";
import {
  createCapabilityDraft,
  isCapabilityQuestion,
} from "../src/capability-summary.mjs";

const config = {
  capabilities: new Set(["draft_reply", "work_plan_proposal"]),
  projectsDirectory: "/not-read-in-test",
};

const manifests = new Map([
  ["alpha", {
    projectId: "alpha",
    name: "词汇学习项目",
    rootDirectory: "/secret/project/root",
    requesters: ["requester-1"],
    capabilities: {
      research: { mode: "automatic" },
      document_draft: { mode: "automatic" },
      git_push: { mode: "disabled" },
      production_deploy: {
        mode: "approval_required",
        expiresAt: "2026-08-04T00:00:00.000Z",
      },
    },
  }],
  ["other", {
    projectId: "other",
    name: "未授权项目",
    rootDirectory: "/other/secret/root",
    requesters: ["someone-else"],
    capabilities: { code_patch: { mode: "automatic" } },
  }],
]);

test("只把明确询问 Foursday 能力的消息识别为能力问题", () => {
  for (const content of [
    "你能做什么？",
    "这个 AI 有哪些能力",
    "AI员工能干啥",
    "你可以帮我做什么",
    "Foursday 能做什么",
    "机器人支持哪些功能",
    "介绍一下你的能力清单",
  ]) {
    assert.equal(isCapabilityQuestion(content), true, content);
  }
  for (const content of [
    "这个模型的语言能力需要优化",
    "帮我做一个能力清单",
    "你能帮我做个能力清单吗",
    "项目现在能做什么？",
  ]) {
    assert.equal(isCapabilityQuestion(content), false, content);
  }
});

test("私聊能力自述只包含请求人当前有效授权且不泄露执行细节", async () => {
  const draft = await createCapabilityDraft({
    config,
    requesterId: "requester-1",
    now: new Date("2026-08-05T00:00:00.000Z"),
    manifestLoader: async () => manifests,
  });
  assert.equal(draft.shouldReply, true);
  assert.equal(draft.decisionSource, "capability_catalog");
  assert.match(draft.reply, /词汇学习项目/u);
  assert.match(draft.reply, /研究与方案分析/u);
  assert.match(draft.reply, /文档草稿/u);
  assert.match(draft.reply, /计划提案/u);
  const authorizationLine = draft.reply
    .split("\n")
    .find((line) => line.includes("已获授权的项目"));
  assert.ok(authorizationLine);
  assert.doesNotMatch(authorizationLine, /未授权项目|代码补丁|Git|生产发布/u);
  assert.doesNotMatch(draft.reply, /\/secret\/project\/root|requester-1|alpha/u);
  assert.match(draft.reply, /真实发送关闭/u);
  assert.match(draft.reply, /计划自动执行关闭/u);
});

test("群聊能力自述隐藏项目名称并在授权状态不可读时安全降级", async () => {
  const groupDraft = await createCapabilityDraft({
    config,
    requesterId: "requester-1",
    isGroup: true,
    manifestLoader: async () => manifests,
  });
  assert.match(groupDraft.reply, /已获授权的 1 个项目/u);
  assert.doesNotMatch(groupDraft.reply, /词汇学习项目|未授权项目/u);

  const degraded = await createCapabilityDraft({
    config,
    requesterId: "requester-1",
    manifestLoader: async () => { throw new Error("unavailable"); },
  });
  assert.match(degraded.reply, /项目授权状态暂时无法读取/u);
  assert.match(degraded.reply, /不会据此声称/u);
  assert.doesNotMatch(degraded.reply, /计划提案/u);
});

test("能力自述准确说明发送与计划执行开关", async () => {
  const draft = await createCapabilityDraft({
    config: {
      ...config,
      capabilities: new Set([
        "draft_reply",
        "work_plan_proposal",
        "work_plan_execution",
        "send_message",
        "send_group_message",
      ]),
    },
    requesterId: "requester-1",
    manifestLoader: async () => manifests,
  });
  assert.match(draft.reply, /计划提案/u);
  assert.match(draft.reply, /私聊或群聊回复可在逐条人工审批后发送/u);
  assert.match(draft.reply, /计划执行已开启/u);
  assert.doesNotMatch(draft.reply, /真实发送关闭|计划自动执行关闭/u);
});
