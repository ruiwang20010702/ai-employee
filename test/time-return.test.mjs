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
  assert.deepEqual(summarizeTimeReturns([proposal]), {
    confirmedEntries: 0,
    proposedEntries: 1,
    returnedMinutes: 0,
    returnedHours: 0,
    weeklyTargetMinutes: 480,
    targetProgress: 0,
    evidenceBoundary: "confirmed_verified_outcomes_only",
  });
  const summary = summarizeTimeReturns([{ ...proposal, status: "confirmed" }]);
  assert.equal(summary.returnedMinutes, 25);
  assert.equal(summary.confirmedEntries, 1);
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
