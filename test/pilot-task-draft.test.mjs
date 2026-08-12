import assert from "node:assert/strict";
import test from "node:test";
import { buildPilotTaskDraft } from "../src/pilot-task-draft.mjs";

test("外部体验任务草稿为每个名额生成唯一合成 Issue 和表单默认值", () => {
  const candidateSha = "a".repeat(40);
  const draft = buildPilotTaskDraft({ participantAlias: "tester-01", candidateSha });
  const url = new URL(draft.newIssueUrl);
  assert.equal(draft.schema, "foursday-pilot-task-draft/v1");
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/ruiwang20010702/foursday/issues/new");
  assert.match(url.searchParams.get("title"), /tester-01/u);
  assert.match(url.searchParams.get("body"), /immutable candidate: a{40}/u);
  assert.match(url.searchParams.get("body"), /source: external pilot intake Issue #49/u);
  assert.match(draft.changeRequest, /docs\/pilot-notes\/tester-01\.md/u);
  assert.equal(draft.prTitle, "test(pilot): validate tester-01 fork loop");
  assert.equal(draft.baseBranch, "codex/v0.5-candidate");
  assert.equal(draft.testCommandId, "check");
  assert.equal(draft.externalSystemsModified, false);
  assert.doesNotMatch(
    JSON.stringify(draft),
    /Bearer\s|ghp_[A-Za-z0-9]{10}|github_pat_[A-Za-z0-9_]{10}|(?:^|[^A-Za-z])sk-[A-Za-z0-9]{16}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+|\/Users\/|\/home\//u,
  );
});

test("外部体验任务草稿拒绝未分配名额和可变提交", () => {
  for (const participantAlias of ["tester-XX", "tester-00", "tester-11", "maintainer", "tester-01?body=x"]) {
    assert.throws(
      () => buildPilotTaskDraft({ participantAlias, candidateSha: "a".repeat(40) }),
      /assigned alias/u,
    );
  }
  assert.throws(
    () => buildPilotTaskDraft({ participantAlias: "tester-10", candidateSha: "main" }),
    /immutable candidate SHA/u,
  );
});
