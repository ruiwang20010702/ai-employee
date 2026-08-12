import { buildTriggeredWorkPlan, workTriggerMatchesEvent } from "./work-trigger.mjs";
import { captureWorkPlanGraph } from "./governed-work-graph-runtime.mjs";

async function registerTriggerPlan({ store, tenantId, trigger, recipe, manifest, owner, scheduledFor, event, now }) {
  const built = buildTriggeredWorkPlan({ trigger, recipe, manifest, scheduledFor, event });
  if (!["ALLOW", "REQUIRE_APPROVAL"].includes(built.assessment.decision)) {
    throw new Error(`Triggered plan denied: ${built.assessment.reason}`);
  }
  const reserved = await store.reserveWorkTriggerRun(trigger.id, built.runKey, owner, now);
  if (!reserved) return { created: false, reason: "duplicate_or_budget_limited" };
  let plan;
  try {
    plan = await store.registerWorkPlan(built.assessment, now);
    await store.completeWorkTriggerRun(trigger.id, built.runKey, plan.id, owner, now);
  } catch (error) {
    await store.failWorkTriggerRun(trigger.id, built.runKey, error.message, owner, now);
    throw error;
  }
  try {
    await captureWorkPlanGraph({
      store,
      tenantId: tenantId ?? store.tenantId ?? "default",
      manifest,
      assessment: built.assessment,
      recipe,
      workPlan: plan,
      trigger,
      triggerRun: {
        trigger_id: trigger.id,
        run_key: built.runKey,
        work_plan_id: plan.id,
        status: "completed",
      },
      event,
      observedAt: now,
    });
  } catch (error) {
    await store.setCheckpoint?.("proactive:last-graph-failure", "graph_capture_failed");
    return {
      created: true,
      triggerId: trigger.id,
      runKey: built.runKey,
      plan,
      graphCaptured: false,
    };
  }
  return { created: true, triggerId: trigger.id, runKey: built.runKey, plan, graphCaptured: true };
}

export async function runDueProactiveTrigger({ store, tenantId, manifests, recipes, owner, now = new Date() }) {
  const trigger = await store.claimDueWorkTrigger(
    owner,
    new Date(now.getTime() + 60_000),
    now,
  );
  if (!trigger) return null;
  const manifest = manifests.get(trigger.projectId);
  const recipe = recipes.get(trigger.recipeId);
  if (!manifest || !recipe) {
    await store.advanceWorkTrigger(trigger.id, owner, now);
    throw new Error("Triggered project or recipe is unavailable");
  }
  let result;
  try {
    result = await registerTriggerPlan({
      store,
      tenantId,
      trigger,
      recipe,
      manifest,
      owner,
      scheduledFor: trigger.nextRunAt,
      now,
    });
  } catch (error) {
    if (trigger.leaseOwner === owner) {
      try { await store.advanceWorkTrigger(trigger.id, owner, now); } catch {}
    }
    throw error;
  }
  if (!result.created) await store.advanceWorkTrigger(trigger.id, owner, now);
  return result;
}

export async function ingestProactiveEvent({ store, tenantId, manifests, recipes, event, owner, now = new Date() }) {
  const triggers = (await store.listWorkTriggers({ status: "enabled" }))
    .filter((trigger) => trigger.kind === "event" && workTriggerMatchesEvent(trigger, event));
  const results = [];
  for (const trigger of triggers) {
    const manifest = manifests.get(trigger.projectId);
    const recipe = recipes.get(trigger.recipeId);
    if (!manifest || !recipe) {
      results.push({ created: false, triggerId: trigger.id, reason: "configuration_unavailable" });
      continue;
    }
    try {
      results.push(await registerTriggerPlan({
        store, tenantId, trigger, recipe, manifest, event, owner, now,
      }));
    } catch {
      results.push({ created: false, triggerId: trigger.id, reason: "trigger_failed" });
    }
  }
  return results;
}
