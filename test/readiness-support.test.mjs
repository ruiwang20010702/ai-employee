import assert from "node:assert/strict";
import test from "node:test";
import { buildReadinessSupportReport } from "../src/readiness-support.mjs";

const readiness = {
  schema: "foursday-activation-readiness/v1",
  externalSystemsModified: false,
  github: { cliAvailable: true, authenticated: false },
  runtimes: {
    codex: false,
    claudeCode: true,
    openAiCompatible: false,
    openAiCompatibleConfigurationError: true,
  },
  readyForPilotPreparation: false,
  readyForGovernedExecution: false,
  injected: "/Users/private/token-secret",
};

test("readiness 求助报告只导出候选、布尔状态和用户占位符", () => {
  const report = buildReadinessSupportReport({
    candidateSha: "a".repeat(40),
    nodeVersion: "24.7.0",
    readiness,
  });
  assert.equal(report.schema, "foursday-readiness-support/v1");
  assert.match(report.issueUrl, /issues\/new\?template=bug_report\.yml$/u);
  assert.match(report.markdown, /immutable candidate: a{40}/u);
  assert.match(report.markdown, /GitHub CLI: ready/u);
  assert.match(report.markdown, /GitHub authentication: not ready/u);
  assert.match(report.markdown, /Claude Code runtime: ready/u);
  assert.match(report.markdown, /external systems modified by this check: no/u);
  assert.doesNotMatch(
    report.markdown,
    /\/Users\/|token-secret|private\/home|must-not-leak/iu,
  );
  assert.equal(report.externalSystemsModified, false);
});

test("readiness 求助报告拒绝可变提交、写入结果和畸形布尔字段", () => {
  assert.throws(
    () => buildReadinessSupportReport({
      candidateSha: "main", nodeVersion: "24.7.0", readiness,
    }),
    /immutable candidate SHA/u,
  );
  assert.throws(
    () => buildReadinessSupportReport({
      candidateSha: "a".repeat(40),
      nodeVersion: "24.7.0",
      readiness: { ...readiness, externalSystemsModified: true },
    }),
    /completed read-only result/u,
  );
  assert.throws(
    () => buildReadinessSupportReport({
      candidateSha: "a".repeat(40),
      nodeVersion: "24.7.0",
      readiness: { ...readiness, github: { cliAvailable: "yes", authenticated: false } },
    }),
    /github\.cliAvailable/u,
  );
});
