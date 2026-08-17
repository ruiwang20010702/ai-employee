import assert from "node:assert/strict";
import test from "node:test";
import {
  applyShadowTimeReturnAdmission,
  previewShadowTimeReturnAdmission,
  shadowTimeReturnAdmissionConfirmation,
} from "../src/shadow-time-return-admission.mjs";

const proof = {
  projectId: "project_1",
  recipeId: "project-follow-up",
  evidenceSha256: "a".repeat(64),
  planHash: "b".repeat(64),
  repositoryCommit: "c".repeat(40),
  baselineMinutes: 45,
  humanActiveMinutes: 5,
  returnedMinutes: 40,
  baselineMethod: "user_confirmed",
  confirmedAt: "2026-08-13T10:00:00.000Z",
  outcomeEvidence: { kind: "confirmed_shadow_recipe_evidence" },
};

const manifestLoader = async () => new Map([["project_1", {
  projectId: "project_1",
  profile: { selectedRecipeIds: ["project-follow-up"] },
}]]);
const recipeLoader = async () => new Map([["project-follow-up", {
  id: "project-follow-up",
  version: 1,
  baselineMinutes: 45,
  baselineMethod: "user_confirmed",
}]]);
const inspector = async () => structuredClone(proof);

test("影子时间返还默认只形成证据绑定预览", async () => {
  const preview = await previewShadowTimeReturnAdmission({
    evidenceDirectory: "/evidence",
    evidenceSha256: proof.evidenceSha256,
    projectsDirectory: "/projects",
    recipesDirectory: "/recipes",
    inspector,
    manifestLoader,
    recipeLoader,
  });
  assert.equal(preview.productionDatabaseWrite, false);
  assert.equal(preview.returnedMinutes, 40);
  assert.equal(preview.confirmation, `ADMIT-${"A".repeat(12)}`);
});

test("影子时间返还仅在精确确认后写入且重复应用幂等", async () => {
  const calls = [];
  const store = {
    async getTimeReturn() { return null; },
    async importConfirmedShadowTimeReturn(input, actor) {
      calls.push({ input, actor });
      return {
        created: true,
        entry: {
          ...input,
          sourceId: input.evidenceSha256,
          sourceType: "shadow_evidence",
          status: "confirmed",
        },
      };
    },
  };
  await assert.rejects(
    () => applyShadowTimeReturnAdmission({
      evidenceDirectory: "/evidence",
      evidenceSha256: proof.evidenceSha256,
      projectsDirectory: "/projects",
      recipesDirectory: "/recipes",
      store,
      confirmation: "ADMIT-WRONG",
      actor: "owner",
      inspector,
      manifestLoader,
      recipeLoader,
    }),
    /confirmation does not match/u,
  );
  assert.equal(calls.length, 0);
  const result = await applyShadowTimeReturnAdmission({
    evidenceDirectory: "/evidence",
    evidenceSha256: proof.evidenceSha256,
    projectsDirectory: "/projects",
    recipesDirectory: "/recipes",
    store,
    confirmation: shadowTimeReturnAdmissionConfirmation(proof.evidenceSha256),
    actor: "owner",
    inspector,
    manifestLoader,
    recipeLoader,
  });
  assert.equal(calls.length, 1);
  assert.equal(result.productionDatabaseWrite, true);
  assert.equal(result.returnedMinutes, 40);
});

test("项目或配方未授权时拒绝纳入时间返还", async () => {
  await assert.rejects(
    () => previewShadowTimeReturnAdmission({
      evidenceDirectory: "/evidence",
      evidenceSha256: proof.evidenceSha256,
      projectsDirectory: "/projects",
      recipesDirectory: "/recipes",
      inspector,
      manifestLoader: async () => new Map(),
      recipeLoader,
    }),
    /project is not authorized/u,
  );
});
