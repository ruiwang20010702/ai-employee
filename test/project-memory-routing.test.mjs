import assert from "node:assert/strict";
import test from "node:test";
import { routeProjectMemories } from "../src/project-memory-routing.mjs";

function identity(subject, aliases, statement = `${subject} 项目身份`) {
  return {
    id: `identity-${subject}`,
    type: "project",
    subject,
    project_id: subject,
    statement,
    status: "confirmed",
    sensitivity: "internal",
    scope: {
      factKey: "identity.project_aliases",
      canonicalName: aliases[0],
      aliases,
    },
  };
}

test("项目别名路由优先最长名称且返回该项目全部正式记忆", () => {
  const memories = [
    identity("vocab", ["单词"]),
    identity("vocab_2_2", ["单词2.2"]),
    {
      ...identity("vocab_2_2", ["unused"], "单词2.2 当前里程碑"),
      id: "vocab-fact",
      scope: { factKey: "milestone.current" },
    },
  ];
  assert.deepEqual(
    routeProjectMemories({ text: "继续处理单词2.2", memories }).map((m) => m.id),
    ["identity-vocab_2_2", "vocab-fact"],
  );
});

test("项目别名支持中英文多个项目且短英文别名有单词边界", () => {
  const memories = [
    identity("foursday", ["Foursday", "ai员工", "AI员工设计"]),
    identity("s9", ["S9-Vocab-Pipeline", "S9"]),
    identity("dsh", ["DSH", "deepseek-harness"]),
  ];
  assert.deepEqual(
    routeProjectMemories({
      text: "把 AI员工设计 和 S9-Vocab-Pipeline 对齐",
      memories,
    }).map((m) => m.subject),
    ["foursday", "s9"],
  );
  assert.deepEqual(
    routeProjectMemories({ text: "这只是 dashboard 文案", memories }),
    [],
  );
});
