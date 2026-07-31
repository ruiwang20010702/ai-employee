import assert from "node:assert/strict";
import test from "node:test";
import { classifyMessage } from "../src/draft.mjs";

test("明确闭环消息不回复", () => {
  for (const message of [
    "收到",
    "好的！",
    "辛苦了",
    "不用回，我先处理",
    "你先忙，晚点再说",
    "[图片]",
    "👍",
    "系统通知：你有一条新的审批",
    "盘",
  ]) {
    assert.equal(
      classifyMessage(message).decision,
      "no_reply",
      `expected no_reply: ${message}`,
    );
  }
});

test("非明确闭环消息交给上下文模型复核", () => {
  for (const message of [
    "这个方案怎么优化？",
    "帮我看一下代码",
    "测试环境报错了",
    "什么时候能上线",
    "明天把周报整理下",
    "文档还是老样子吗",
    "我已经到公司了。",
    "这一批很少",
  ]) {
    assert.equal(
      classifyMessage(message).decision,
      "review",
      `expected review: ${message}`,
    );
  }
});
