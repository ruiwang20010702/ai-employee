import assert from "node:assert/strict";
import test from "node:test";
import { buildSetupCheckin } from "../src/setup-checkin.mjs";

const readiness = {
  schema: "foursday-activation-readiness/v1",
  externalSystemsModified: false,
  github: { cliAvailable: false, authenticated: false },
  runtimes: { codex: false, claudeCode: false, openAiCompatible: false },
  readyForPilotPreparation: false,
  readyForGovernedExecution: false,
};

test("安装签到只包含不可变候选和用户可补充的隐私安全字段", () => {
  const checkin = buildSetupCheckin({
    candidateSha: "a".repeat(40),
    nodeVersion: "24.7.0",
    readiness,
  });
  assert.equal(checkin.schema, "foursday-setup-checkin/v1");
  assert.match(checkin.issueUrl, /issues\/50#new_comment_field$/u);
  assert.match(checkin.markdown, /immutable candidate: a{40}/u);
  assert.match(checkin.markdown, /Node\.js: 24/u);
  assert.match(checkin.markdown, /read-only readiness check completed: yes/u);
  assert.match(checkin.markdown, /created by this readiness check: no/u);
  assert.match(checkin.markdown, /platform: macOS \/ Linux \(choose one\)/u);
  assert.doesNotMatch(
    checkin.markdown,
    /username|email|token|credential|model output|\/Users\/|\/home\//iu,
  );
  assert.equal(checkin.externalSystemsModified, false);
});

test("安装签到要求完整提交、只读 readiness 和受支持 Node", () => {
  assert.throws(
    () => buildSetupCheckin({ candidateSha: "main", nodeVersion: "24.7.0", readiness }),
    /immutable candidate SHA/u,
  );
  assert.throws(
    () => buildSetupCheckin({
      candidateSha: "a".repeat(40),
      nodeVersion: "24.7.0",
      readiness: { ...readiness, externalSystemsModified: true },
    }),
    /completed read-only readiness/u,
  );
  assert.throws(
    () => buildSetupCheckin({
      candidateSha: "a".repeat(40), nodeVersion: "20.19.0", readiness,
    }),
    /supported Node\.js/u,
  );
});
