import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  normalizeGithubIssueEvent,
  normalizeMeetingEndedEvent,
} from "../src/work-event-adapters.mjs";

test("会议结束事件保留执行闭环所需的精确字段", () => {
  const event = normalizeMeetingEndedEvent({
    id: "meeting-42",
    endedAt: "2026-08-12T02:00:00.000Z",
    title: "项目复盘",
    notes: "决定先完成安全评审，再开放自动执行。",
    executorUserIds: ["user-1"],
    attendeeUserIds: ["user-1", "user-2"],
    decisionStatement: "发布前必须完成安全检查。",
    decisionFactKey: "decision.release_gate",
    memoryRetentionDays: 90,
    actionDue: "2026-08-13T10:00:00.000Z",
    followupStart: "2026-08-14T02:00:00.000Z",
    followupEnd: "2026-08-14T03:00:00.000Z",
  });
  assert.equal(event.type, "meeting.ended");
  assert.equal(event.payload.meetingTitle, "项目复盘");
  assert.deepEqual(event.payload.executorUserIds, ["user-1"]);
});

test("GitHub Issue 事件必须通过签名和仓库白名单", () => {
  const secret = "test-webhook-secret";
  const rawBody = Buffer.from(JSON.stringify({
    action: "opened",
    repository: { full_name: "example/project" },
    issue: {
      number: 42,
      created_at: "2026-08-12T03:00:00.000Z",
      title: "修复登录问题",
      body: "请补负向测试。",
      html_url: "https://github.com/example/project/issues/42",
    },
  }));
  const headers = {
    "x-github-event": "issues",
    "x-github-delivery": "delivery-42",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
  };
  const event = normalizeGithubIssueEvent({
    rawBody, headers, webhookSecret: secret, allowedRepositories: ["example/project"],
  });
  assert.equal(event.type, "github.issue.opened");
  assert.equal(event.payload.number, 42);
  assert.throws(
    () => normalizeGithubIssueEvent({
      rawBody, headers: { ...headers, "x-hub-signature-256": "sha256=00" },
      webhookSecret: secret, allowedRepositories: ["example/project"],
    }),
    /signature/u,
  );
  assert.throws(
    () => normalizeGithubIssueEvent({
      rawBody, headers, webhookSecret: secret, allowedRepositories: ["other/project"],
    }),
    /allowlisted/u,
  );
});
