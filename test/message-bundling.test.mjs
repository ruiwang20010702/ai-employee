import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldFlushMessageBundleEarly,
  splitMessageBursts,
} from "../src/message-bundling.mjs";

function message(id, createTime) {
  return { id, createTime };
}

test("消息按时间排序并按间隔拆分", () => {
  const bursts = splitMessageBursts(
    [
      message("m3", "2026-07-31T10:05:00.000Z"),
      message("m1", "2026-07-31T10:00:00.000Z"),
      message("m2", "2026-07-31T10:01:00.000Z"),
    ],
    { gapMs: 120_000 },
  );
  assert.deepEqual(
    bursts.map((burst) => burst.map(({ id }) => id)),
    [["m1", "m2"], ["m3"]],
  );
});

test("单个任务的消息数量有硬上限", () => {
  const bursts = splitMessageBursts(
    [0, 1, 2].map((index) =>
      message(`m${index}`, `2026-07-31T10:00:0${index}.000Z`),
    ),
    { maxMessages: 2 },
  );
  assert.deepEqual(bursts.map((burst) => burst.length), [2, 1]);
});

test("追问送达时间强制切开历史补录与新回复", () => {
  const boundary = new Date("2026-08-10T08:00:20.000Z");
  const bursts = splitMessageBursts(
    [
      message("old", "2026-08-10T08:00:10.000Z"),
      message("answer", "2026-08-10T08:00:30.000Z"),
    ],
    { gapMs: 120_000, boundaryAt: boundary },
  );
  assert.deepEqual(
    bursts.map((items) => items.map((item) => item.id)),
    [["old"], ["answer"]],
  );
});

test("只有显式紧急或发完信号可以提前结束安静窗口", () => {
  assert.equal(shouldFlushMessageBundleEarly([{ content: "[紧急] 生产服务异常" }]), true);
  assert.equal(shouldFlushMessageBundleEarly([{ content: "需求描述完毕。" }]), true);
  assert.equal(shouldFlushMessageBundleEarly([{ content: "你觉得这个方案怎么样？" }]), false);
  assert.equal(shouldFlushMessageBundleEarly([{ content: "我还在继续输入" }]), false);
});
