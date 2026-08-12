import { summarizeTimeReturns } from "./time-return.mjs";
import { buildGovernedGraphExplanations } from "./governed-work-graph-query.mjs";

const activePlanStatuses = new Set([
  "ready", "awaiting_approval", "approved", "executing", "verifying",
]);

export function buildProjectDashboard({
  manifest,
  plans = [],
  memories = [],
  timeReturns = [],
  recipes = [],
  planSteps = new Map(),
  graph = null,
}) {
  if (!manifest?.projectId || !manifest?.name) {
    throw new Error("Project dashboard requires a project manifest");
  }
  const projectPlans = plans.filter((plan) => plan.project_id === manifest.projectId);
  const projectMemories = memories.filter(
    (memory) => memory.project_id === manifest.projectId && memory.status === "confirmed",
  );
  const projectTimeReturns = timeReturns.filter(
    (entry) => entry.projectId === manifest.projectId,
  );
  const recordedPlanIds = new Set(projectTimeReturns.map((entry) => entry.workPlanId));
  const latestUpdate = projectPlans
    .map((plan) => plan.updated_at)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const workItems = [...projectPlans]
    .sort((left, right) => new Date(right.updated_at) - new Date(left.updated_at))
    .slice(0, 20)
    .map((plan) => {
      const steps = planSteps.get(plan.id) ?? [];
      return {
        id: plan.id,
        objective: plan.objective,
        status: plan.status,
        recipeId: plan.plan?.recipe?.id ?? null,
        updatedAt: plan.updated_at,
        steps: {
          total: steps.length,
          completed: steps.filter((step) => step.status === "completed").length,
          failed: steps.filter((step) => step.status === "failed").length,
        },
      };
    });
  const deliverables = workItems.flatMap((item) =>
    (planSteps.get(item.id) ?? [])
      .filter((step) => step.status === "completed" && step.evidence)
      .map((step) => ({
        workPlanId: item.id,
        stepId: step.step_id,
        capability: step.capability,
        kind: step.evidence.kind ?? null,
        verification: step.evidence.verification ?? null,
        reference: step.evidence.url ?? step.evidence.docUrl ?? step.evidence.commit ??
          step.evidence.taskId ?? step.evidence.eventId ?? step.evidence.sha256 ?? null,
      })),
  ).slice(0, 50);
  const graphExplanations = graph
    ? buildGovernedGraphExplanations({
        tenantId: graph.tenantId,
        projectId: manifest.projectId,
        nodes: graph.nodes ?? [],
        edges: graph.edges ?? [],
        plans: projectPlans,
        now: graph.now,
        limits: { maxDepth: 4, maxResults: 500 },
      })
    : [];
  const graphByPlan = new Map(graphExplanations.map((item) => [item.planId, item]));
  for (const item of workItems) {
    const explanation = graphByPlan.get(item.id);
    item.graph = explanation
      ? {
          driftStatus: explanation.drift.status,
          driftReason: explanation.drift.reason,
          changeStatus: explanation.changes.status,
          changeReason: explanation.changes.reason,
        }
      : null;
  }
  return {
    projectId: manifest.projectId,
    name: manifest.name,
    objective: manifest.profile?.objective ?? null,
    successCriteria: manifest.profile?.successCriteria ?? [],
    milestones: manifest.profile?.milestones ?? [],
    collaborationObjects: manifest.profile?.collaborationObjects ?? [],
    plans: {
      total: projectPlans.length,
      active: projectPlans.filter((plan) => activePlanStatuses.has(plan.status)).length,
      completed: projectPlans.filter((plan) => plan.status === "completed").length,
      failed: projectPlans.filter((plan) => plan.status === "failed").length,
      latestUpdate,
      items: workItems,
    },
    memory: {
      confirmed: projectMemories.length,
      decisions: projectMemories.filter((memory) => memory.scope?.factKey?.includes("decision")).length,
      risks: projectMemories.filter((memory) => memory.scope?.factKey?.includes("risk")).length,
      items: projectMemories.map((memory) => ({
        id: memory.id,
        factKey: memory.scope?.factKey ?? null,
        statement: memory.statement,
        updatedAt: memory.updated_at,
      })),
    },
    deliverables,
    governedGraph: {
      available: Boolean(graph),
      contractVersion: graph?.nodes?.[0]?.graphVersion ?? graph?.edges?.[0]?.graphVersion ?? null,
      nodeCount: graph?.nodes?.length ?? 0,
      edgeCount: graph?.edges?.length ?? 0,
      alignedPlans: graphExplanations.filter((item) => item.drift.status === "aligned").length,
      driftedPlans: graphExplanations.filter((item) => item.drift.status === "drift_detected").length,
      incompletePlans: graphExplanations.filter((item) =>
        ["incomplete", "denied"].includes(item.drift.status)
      ).length,
      explanations: graphExplanations,
    },
    recipes: recipes.filter((recipe) =>
      (manifest.profile?.selectedRecipeIds ?? []).includes(recipe.id)
    ),
    timeReturn: summarizeTimeReturns(
      projectTimeReturns,
    ),
    timeReturnCandidates: projectPlans
      .filter((plan) =>
        plan.status === "completed" &&
        plan.plan?.recipe?.id &&
        !recordedPlanIds.has(plan.id)
      )
      .map((plan) => ({
        workPlanId: plan.id,
        objective: plan.objective,
        recipeId: plan.plan.recipe.id,
        baselineMinutes: plan.plan.recipe.baselineMinutes,
        baselineMethod: plan.plan.recipe.baselineMethod,
      })),
  };
}
