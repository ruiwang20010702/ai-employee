import { createHmac, timingSafeEqual } from "node:crypto";
import { validateWorkEvent } from "./work-trigger.mjs";

function text(value, name, maximum = 10_000) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function stringList(value, name, maximum = 100) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new Error(`${name} must be a non-empty bounded list`);
  }
  return [...new Set(value.map((item) => text(item, name, 500)))];
}

function timestamp(value, name) {
  const date = new Date(text(value, name, 100));
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a timestamp`);
  return date.toISOString();
}

export function normalizeMeetingEndedEvent(input) {
  const retentionDays = Number(input?.memoryRetentionDays);
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error("meeting.memoryRetentionDays is invalid");
  }
  const followupStart = timestamp(input?.followupStart, "meeting.followupStart");
  const followupEnd = timestamp(input?.followupEnd, "meeting.followupEnd");
  if (new Date(followupEnd) <= new Date(followupStart)) {
    throw new Error("meeting follow-up end must be after start");
  }
  return validateWorkEvent({
    version: 1,
    id: text(input?.id, "meeting.id", 200),
    type: "meeting.ended",
    occurredAt: timestamp(input?.endedAt, "meeting.endedAt"),
    source: text(input?.source ?? "meeting", "meeting.source", 100),
    payload: {
      meetingTitle: text(input?.title, "meeting.title", 500),
      meetingNotes: text(input?.notes, "meeting.notes", 50_000),
      executorUserIds: stringList(input?.executorUserIds, "meeting.executorUserIds"),
      attendeeUserIds: stringList(input?.attendeeUserIds, "meeting.attendeeUserIds"),
      decisionStatement: text(input?.decisionStatement, "meeting.decisionStatement", 1_000),
      decisionFactKey: text(input?.decisionFactKey, "meeting.decisionFactKey", 120),
      memoryRetentionDays: retentionDays,
      actionDue: timestamp(input?.actionDue, "meeting.actionDue"),
      followupStart,
      followupEnd,
    },
  });
}

function verifiedGithubSignature(rawBody, signature, secret) {
  const value = String(signature ?? "").trim();
  const key = String(secret ?? "");
  if (!value.startsWith("sha256=") || !key) return false;
  const received = Buffer.from(value.slice(7), "hex");
  const expected = createHmac("sha256", key).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function normalizeGithubIssueEvent({
  rawBody,
  headers = {},
  webhookSecret,
  allowedRepositories,
}) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""));
  if (body.length === 0 || body.length > 1024 * 1024) throw new Error("GitHub webhook body is invalid");
  if (!verifiedGithubSignature(body, headers["x-hub-signature-256"], webhookSecret)) {
    throw new Error("GitHub webhook signature is invalid");
  }
  if (headers["x-github-event"] !== "issues") throw new Error("GitHub webhook event is unsupported");
  const deliveryId = text(headers["x-github-delivery"], "github.delivery", 200);
  const payload = JSON.parse(body.toString("utf8"));
  if (payload.action !== "opened") throw new Error("GitHub issue action is unsupported");
  const repository = text(payload.repository?.full_name, "github.repository", 200);
  if (!Array.isArray(allowedRepositories) || !allowedRepositories.includes(repository)) {
    throw new Error("GitHub repository is not allowlisted");
  }
  const issueNumber = Number(payload.issue?.number);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("GitHub issue number is invalid");
  }
  return validateWorkEvent({
    version: 1,
    id: deliveryId,
    type: "github.issue.opened",
    occurredAt: timestamp(payload.issue?.created_at, "github.issue.createdAt"),
    source: "github",
    payload: {
      repository,
      number: issueNumber,
      title: text(payload.issue?.title, "github.issue.title", 500),
      body: String(payload.issue?.body ?? "").trim().slice(0, 50_000),
      htmlUrl: text(payload.issue?.html_url, "github.issue.htmlUrl", 2_000),
    },
  });
}
