import { loadProjectManifests } from "./project-manifests.mjs";
import { inspectConfirmedProjectRecipeShadowReview } from "./project-recipe-shadow.mjs";
import { loadWorkRecipes } from "./recipe-library.mjs";

export function shadowTimeReturnAdmissionConfirmation(evidenceSha256) {
  const normalized = String(evidenceSha256 ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error("Shadow time return evidence SHA-256 is invalid");
  }
  return `ADMIT-${normalized.slice(0, 12).toUpperCase()}`;
}

export async function previewShadowTimeReturnAdmission({
  evidenceDirectory,
  evidenceSha256,
  projectsDirectory,
  recipesDirectory,
  store = null,
  inspector = inspectConfirmedProjectRecipeShadowReview,
  manifestLoader = loadProjectManifests,
  recipeLoader = loadWorkRecipes,
} = {}) {
  const proof = await inspector({ evidenceDirectory, evidenceSha256 });
  const [projects, recipes] = await Promise.all([
    manifestLoader(projectsDirectory),
    recipeLoader(recipesDirectory),
  ]);
  const manifest = projects.get(proof.projectId);
  const recipe = recipes.get(proof.recipeId);
  if (!manifest) throw new Error("Shadow time return project is not authorized");
  if (!recipe || !(manifest.profile?.selectedRecipeIds ?? []).includes(recipe.id)) {
    throw new Error("Shadow time return recipe is not authorized for this project");
  }
  if (
    recipe.version !== 1 ||
    recipe.baselineMinutes !== proof.baselineMinutes ||
    recipe.baselineMethod !== proof.baselineMethod
  ) {
    throw new Error("Shadow time return recipe baseline changed after the evidence was created");
  }
  const existing = store?.getTimeReturn
    ? await store.getTimeReturn(`shadow_time_${proof.evidenceSha256}`)
    : null;
  if (
    existing &&
    (
      existing.sourceType !== "shadow_evidence" ||
      existing.sourceId !== proof.evidenceSha256 ||
      existing.projectId !== proof.projectId ||
      existing.recipeId !== proof.recipeId ||
      existing.returnedMinutes !== proof.returnedMinutes
    )
  ) {
    throw new Error("Existing shadow time return does not match the inspected evidence");
  }
  return {
    schema: "foursday-shadow-time-return-admission-preview/v1",
    projectId: proof.projectId,
    recipeId: proof.recipeId,
    evidenceSha256: proof.evidenceSha256,
    repositoryCommit: proof.repositoryCommit,
    baselineMinutes: proof.baselineMinutes,
    humanActiveMinutes: proof.humanActiveMinutes,
    returnedMinutes: proof.returnedMinutes,
    confirmedAt: proof.confirmedAt,
    alreadyImported: Boolean(existing),
    confirmation: shadowTimeReturnAdmissionConfirmation(proof.evidenceSha256),
    productionDatabaseWrite: false,
    externalSystemsTouched: false,
    proof,
  };
}

export async function applyShadowTimeReturnAdmission({
  evidenceDirectory,
  evidenceSha256,
  projectsDirectory,
  recipesDirectory,
  store,
  confirmation,
  actor,
  now = new Date(),
  ...dependencies
} = {}) {
  if (!store?.importConfirmedShadowTimeReturn) {
    throw new Error("Shadow time return admission requires a writable store");
  }
  const preview = await previewShadowTimeReturnAdmission({
    evidenceDirectory,
    evidenceSha256,
    projectsDirectory,
    recipesDirectory,
    store,
    ...dependencies,
  });
  if (confirmation !== preview.confirmation) {
    throw new Error("Shadow time return admission confirmation does not match the evidence");
  }
  const imported = await store.importConfirmedShadowTimeReturn(preview.proof, actor, now);
  return {
    schema: "foursday-shadow-time-return-admission-result/v1",
    status: "confirmed",
    projectId: imported.entry.projectId,
    recipeId: imported.entry.recipeId,
    evidenceSha256: imported.entry.sourceId,
    baselineMinutes: imported.entry.baselineMinutes,
    humanActiveMinutes: imported.entry.humanActiveMinutes,
    returnedMinutes: imported.entry.returnedMinutes,
    confirmedAt: imported.entry.confirmedAt,
    created: imported.created,
    productionDatabaseWrite: imported.created,
    externalSystemsTouched: false,
  };
}
