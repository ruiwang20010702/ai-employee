import assert from "node:assert/strict";
import { classifyMessage } from "../src/draft.mjs";

const noReplyCases = [
  "收到",
  "好的！",
  "辛苦了",
  "不用回，我先处理",
  "你先忙，晚点再说",
  "[图片]",
  "👍",
  "我已经到公司了。",
  "这一批很少",
  "盘",
];

const actionableCases = [
  "这个方案怎么优化？",
  "帮我看一下代码",
  "测试环境报错了",
  "什么时候能上线",
  "麻烦确认一下排期",
  "这个需求需要你处理",
];

for (const message of noReplyCases) {
  assert.equal(
    classifyMessage(message).decision,
    "no_reply",
    `expected no_reply: ${message}`,
  );
}

for (const message of actionableCases) {
  assert.equal(
    classifyMessage(message).decision,
    "queue_codex",
    `expected queue_codex: ${message}`,
  );
}

console.log(`classifier tests passed: ${noReplyCases.length + actionableCases.length}`);
