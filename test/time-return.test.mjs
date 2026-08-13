import assert from "node:assert/strict";
import test from "node:test";
import { buildTimeReturnProposal, summarizeTimeReturns } from "../src/time-return.mjs";

test("时间返还必须绑定回读证据且只有确认记录计入", () => {
  const proposal = buildTimeReturnProposal({
    projectId: "project_1",
    workPlanId: "plan_1",
    recipeId: "daily-report",
    baselineMinutes: 30,
    humanActiveMinutes: 5,
    baselineMethod: "user_confirmed",
    outcomeEvidence: { kind: "verified_document", sha256: "a".repeat(64) },
  });
  assert.equal(proposal.returnedMinutes, 25);
  assert.equal(proposal.status, "proposed");
  const summaryOptions = {
    now: new Date("2026-08-13T06:00:00.000Z"),
    timeZoneOffsetMinutes: 480,
  };
  assert.deepEqual(summarizeTimeReturns([proposal], summaryOptions), {
    confirmedEntries: 0,
    proposedEntries: 1,
    confirmedBaselineMinutes: 0,
    confirmedHumanActiveMinutes: 0,
    returnedMinutes: 0,
    returnedHours: 0,
    automationCoverage: null,
    weekStart: "2026-08-09T16:00:00.000Z",
    weekEnd: "2026-08-16T16:00:00.000Z",
    weeklyConfirmedEntries: 0,
    weeklyBaselineMinutes: 0,
    weeklyHumanActiveMinutes: 0,
    weeklyReturnedMinutes: 0,
    weeklyReturnedHours: 0,
    weeklyAutomationCoverage: null,
    weeklyTargetMinutes: 480,
    targetProgress: 0,
    evidenceBoundary: "confirmed_verified_outcomes_only",
    coverageBoundary: "confirmed_recipe_baseline_only",
    targetBoundary: "confirmed_in_current_local_week_only",
  });
  const summary = summarizeTimeReturns([{
    ...proposal,
    status: "confirmed",
    updatedAt: "2026-08-13T06:00:00.000Z",
  }], summaryOptions);
  assert.equal(summary.returnedMinutes, 25);
  assert.equal(summary.confirmedEntries, 1);
  assert.equal(summary.confirmedBaselineMinutes, 30);
  assert.equal(summary.confirmedHumanActiveMinutes, 5);
  assert.equal(summary.automationCoverage, 0.8333);
  assert.equal(summary.weeklyReturnedMinutes, 25);
  assert.equal(summary.weeklyAutomationCoverage, 0.8333);
  assert.equal(summary.targetProgress, 25 / 480);
});

test("北极星只计算本周确认返还而保留全历史审计", () => {
  const entries = [
    {
      status: "confirmed", baselineMinutes: 30, humanActiveMinutes: 5,
      returnedMinutes: 25, updatedAt: "2026-08-13T06:00:00.000Z",
    },
    {
      status: "confirmed", baselineMinutes: 30, humanActiveMinutes: 5,
      returnedMinutes: 25, updatedAt: "2026-08-06T06:00:00.000Z",
    },
  ];
  const summary = summarizeTimeReturns(entries, {
    now: new Date("2026-08-13T06:00:00.000Z"),
    timeZoneOffsetMinutes: 480,
  });
  assert.equal(summary.returnedMinutes, 50);
  assert.equal(summary.weeklyReturnedMinutes, 25);
  assert.equal(summary.weeklyConfirmedEntries, 1);
  assert.equal(summary.targetProgress, 25 / 480);
});

test("时间返还拒绝无证据和人工耗时大于基线", () => {
  assert.throws(
    () => buildTimeReturnProposal({
      projectId: "project_1",
      workPlanId: "plan_1",
      baselineMinutes: 30,
      humanActiveMinutes: 31,
      baselineMethod: "measured",
      outcomeEvidence: { kind: "verified" },
    }),
    /cannot exceed/u,
  );
  assert.throws(
    () => buildTimeReturnProposal({
      projectId: "project_1",
      workPlanId: "plan_1",
      baselineMinutes: 30,
      humanActiveMinutes: 5,
      baselineMethod: "measured",
    }),
    /verified outcome evidence/u,
  );
});
