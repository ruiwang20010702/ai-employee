import { assessWorkPlan } from "./work-plan.mjs";
import { projectWorkPlanGraph } from "./governed-work-graph.mjs";

export async function captureWorkPlanGraph({
  store,
  tenantId,
  manifest,
  assessment = null,
  recipe = null,
  workPlan = null,
  sourceTask = null,
  approval = null,
  trigger = null,
  triggerRun = null,
  event = null,
  memoriesUsed = [],
  memoriesProposed = null,
  timeReturn = null,
  observedAt = new Date(),
}) {
  if (!store?.appendGraphProjection) {
    return { captured: false, reason: "graph_store_unavailable" };
  }
  const at = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (Number.isNaN(at.getTime())) throw new Error("Graph capture observedAt must be a timestamp");
  let currentPlan = workPlan;
  if (!currentPlan && assessment?.planHash) {
    currentPlan = await store.getWorkPlan(`plan_${assessment.planHash.slice(0, 24)}`);
  }
  if (!currentPlan) throw new Error("Graph capture requires a persisted work plan");
  const graphTenantId = tenantId ?? store.tenantId ?? "local";
  const currentAssessment = assessment ?? assessWorkPlan({
    manifest,
    plan: currentPlan.plan,
    now: at,
  });
  if (currentAssessment.planHash !== currentPlan.plan_hash) {
    throw new Error("Graph capture plan assessment is stale");
  }
  const steps = await store.listWorkPlanSteps(currentPlan.id);
  if (currentPlan.plan?.sourceTaskId) {
    if (sourceTask && sourceTask.id !== currentPlan.plan.sourceTaskId) {
      throw new Error("Graph capture source task identity is inconsistent");
    }
    const persistedSource = await store.getTask?.(currentPlan.plan.sourceTaskId);
    if (persistedSource) sourceTask = persistedSource;
  }
  if (currentPlan.policy_decision === "REQUIRE_APPROVAL" && !approval) {
    approval = await store.getWorkPlanApproval?.(currentPlan.id);
  }
  const triggerId = currentPlan.plan?.recipe?.triggerId;
  const runKey = currentPlan.plan?.recipe?.triggerRunKey;
  if (triggerId && !trigger) trigger = await store.getWorkTrigger?.(triggerId);
  if (triggerId && runKey && !triggerRun) {
    triggerRun = await store.getWorkTriggerRun?.(triggerId, runKey);
  }
  if (memoriesProposed == null && store.listMemories) {
    memoriesProposed = (await store.listMemories({
      projectId: currentPlan.project_id ?? currentPlan.projectId,
      limit: 500,
    })).filter((memory) =>
      memory.source_type === "work_plan" && memory.source_id === currentPlan.plan_hash
    );
  }
  const projection = projectWorkPlanGraph({
    tenantId: graphTenantId,
    manifest,
    assessment: currentAssessment,
    recipe,
    workPlan: currentPlan,
    steps,
    approval,
    sourceTask,
    trigger,
    triggerRun,
    event,
    memoriesUsed,
    memoriesProposed: memoriesProposed ?? [],
    timeReturn,
    observedAt: at,
  });
  return {
    captured: true,
    planId: currentPlan.id,
    ...(await store.appendGraphProjection(projection, at)),
  };
}
