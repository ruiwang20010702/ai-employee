import assert from "node:assert/strict";
import test from "node:test";
import { splitMessageBursts } from "../src/message-bundling.mjs";

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
