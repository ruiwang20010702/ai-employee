import { assessWorkPlan } from "./work-plan.mjs";
import { safeErrorCode } from "./logging.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { pausedPlanScopes } from "./scoped-pause.mjs";

export async function executeWorkPlan({
  store,
  planId,
  manifest,
  adapters,
  now = () => new Date(),
  executionOwner = null,
  leaseMs = 300_000,
  leaseRenewMs = Math.max(1_000, Math.floor(leaseMs / 3)),
  cancellationPollMs = 500,
  scopePausePollMs = 500,
  manifestProvider = null,
}) {
  if (executionOwner && (!Number.isFinite(leaseMs) || leaseMs <= leaseRenewMs)) {
    throw new Error("Execution lease must be longer than its renewal interval");
  }
  if (!Number.isFinite(cancellationPollMs) || cancellationPollMs < 50) {
    throw new Error("Cancellation polling interval must be at least 50ms");
  }
  if (!Number.isFinite(scopePausePollMs) || scopePausePollMs < 50) {
    throw new Error("Scope pause polling interval must be at least 50ms");
  }
  const registered = await store.getWorkPlan(planId);
  if (!registered) throw new Error("Work plan not found");
  const current = assessWorkPlan({ plan: registered.plan, manifest, now: now() });
  if (current.planHash !== registered.plan_hash) {
    throw new Error("Work plan or project authorization changed after registration");
  }
  if (!["ALLOW", "REQUIRE_APPROVAL"].includes(current.decision)) {
    throw new Error(`Work plan is no longer allowed: ${current.reason}`);
  }
  if (
    registered.policy_decision === "ALLOW" &&
    current.decision === "REQUIRE_APPROVAL"
  ) {
    throw new Error("Project policy became stricter; register and approve a new plan");
  }
  const executionPlan = {
    ...registered.plan,
    planHash: registered.plan_hash,
  };
  for (const step of registered.plan.steps) {
    if (!adapters[step.capability]) {
      throw new Error(`No execution adapter registered: ${step.capability}`);
    }
    if (adapters[step.capability].preflight) {
      await adapters[step.capability].preflight({
        plan: executionPlan,
        step,
        manifest,
      });
    }
  }
  if (await store.isPaused?.()) {
    throw new Error("System is paused; work plan authorization was not consumed");
  }
  if ((await pausedPlanScopes(store, registered.plan)).length > 0) {
    throw new Error("Work plan scope is paused; authorization was not consumed");
  }
  const authorizationTime = now();
  await store.consumeWorkPlanAuthorization(
    planId,
    authorizationTime,
    executionOwner
      ? {
          owner: executionOwner,
          leaseExpiresAt: new Date(authorizationTime.getTime() + leaseMs),
        }
      : {},
  );
  let leaseError = null;
  let leaseRenewal = Promise.resolve();
  const renewLease = () => {
    leaseRenewal = leaseRenewal.then(async () => {
      if (leaseError) return;
      const renewalTime = now();
      try {
        await store.renewWorkPlanLease(
          planId,
          executionOwner,
          new Date(renewalTime.getTime() + leaseMs),
          renewalTime,
        );
      } catch (error) {
        leaseError = error;
      }
    });
  };
  const leaseTimer = executionOwner
    ? setInterval(renewLease, leaseRenewMs)
    : null;
  leaseTimer?.unref?.();
  const priorEvidence = {};
  try {
    for (const step of registered.plan.steps) {
      if (await store.isWorkPlanCancellationRequested?.(planId)) {
        await store.finalizeWorkPlanCancellation(planId, now());
        return { status: "cancelled", cancelledBeforeStep: step.id };
      }
      while ((await pausedPlanScopes(store, registered.plan)).length > 0) {
        if (leaseError) throw new Error("Work plan execution lease was lost");
        if (await store.isWorkPlanCancellationRequested?.(planId)) {
          await store.finalizeWorkPlanCancellation(planId, now());
          return { status: "cancelled", cancelledBeforeStep: step.id };
        }
        await delay(scopePausePollMs);
      }
      const adapter = adapters[step.capability];
      const stepController = new AbortController();
      let cancellationObserved = false;
      let cancellationPollError = null;
      let cancellationPoll = Promise.resolve();
      let cancellationCheckRunning = false;
      const checkCancellation = async () => {
        if (cancellationObserved || cancellationCheckRunning) return;
        cancellationCheckRunning = true;
        try {
          if (await store.isWorkPlanCancellationRequested?.(planId)) {
            cancellationObserved = true;
            if (adapter.interruptible) stepController.abort();
          }
        } catch (error) {
          cancellationPollError = error;
          if (adapter.interruptible) stepController.abort();
        } finally {
          cancellationCheckRunning = false;
        }
      };
      const cancellationTimer = setInterval(() => {
        cancellationPoll = cancellationPoll.then(checkCancellation);
      }, cancellationPollMs);
      cancellationTimer.unref?.();
      try {
        if (leaseError) throw new Error("Work plan execution lease was lost");
        if (await store.isPaused?.()) {
          throw new Error("System was paused during work plan execution");
        }
        const activeManifest = manifestProvider
          ? await manifestProvider(registered.plan.projectId)
          : manifest;
        if (!activeManifest) throw new Error("Project authorization is unavailable");
        const activeAssessment = assessWorkPlan({
          plan: registered.plan,
          manifest: activeManifest,
          now: now(),
        });
        if (activeAssessment.planHash !== registered.plan_hash) {
          throw new Error("Project authorization changed during execution");
        }
      await store.updateWorkPlanStep(
        planId,
        step.id,
        { status: "executing" },
        now(),
      );
      const result = await adapter.execute({
        plan: executionPlan,
        step,
        manifest: activeManifest,
        priorEvidence: structuredClone(priorEvidence),
        signal: stepController.signal,
      });
      await checkCancellation();
      if (cancellationPollError) throw cancellationPollError;
      if (!result || result.verified !== true || !result.evidence) {
        throw new Error("Execution adapter did not provide verified evidence");
      }
      await leaseRenewal;
      if (leaseError) {
        const error = new Error("Work plan execution lease was lost");
        error.executionEvidence = result.evidence;
        throw error;
      }
      await store.updateWorkPlanStep(
        planId,
        step.id,
        { status: "verifying", evidence: result.evidence },
        now(),
      );
      priorEvidence[step.id] = result.evidence;
      await store.updateWorkPlanStep(
        planId,
        step.id,
        { status: "completed", evidence: result.evidence },
        now(),
      );
      if (cancellationObserved) {
        const currentIndex = registered.plan.steps.findIndex(
          (candidate) => candidate.id === step.id,
        );
        await store.finalizeWorkPlanCancellation(planId, now());
        return {
          status: "cancelled",
          completedBeforeCancellation: step.id,
          cancelledBeforeStep:
            registered.plan.steps[currentIndex + 1]?.id ?? null,
          interruptConfirmed: false,
        };
      }
      } catch (error) {
        await cancellationPoll;
        await checkCancellation();
        if (
          cancellationObserved &&
          adapter.interruptible &&
          error?.code === "WORK_PLAN_CANCELLED"
        ) {
          await store.updateWorkPlanStep(
            planId,
            step.id,
            {
              status: "cancelled",
              error: "operator_interrupted",
              evidence: error.executionEvidence ?? null,
            },
            now(),
          );
          await store.finalizeWorkPlanCancellation(planId, now());
          return {
            status: "cancelled",
            cancelledDuringStep: step.id,
            interruptConfirmed: true,
            evidence: error.executionEvidence ?? null,
          };
        }
        const errorCode = safeErrorCode(error);
        await store.updateWorkPlanStep(
          planId,
          step.id,
          {
            status: "failed",
            error: errorCode,
            evidence: error.executionEvidence ?? null,
          },
          now(),
        );
        await store.finishWorkPlan(
          planId,
          { success: false, error: errorCode },
          now(),
        );
        return { status: "failed", failedStep: step.id, errorCode };
      } finally {
        clearInterval(cancellationTimer);
        await cancellationPoll;
      }
    }
    if (await store.isWorkPlanCancellationRequested?.(planId)) {
      await store.finalizeWorkPlanCancellation(planId, now());
      return { status: "cancelled" };
    }
    await store.finishWorkPlan(planId, { success: true }, now());
    return {
      status: "completed",
      evidence: await store.listWorkPlanSteps(planId),
    };
  } finally {
    if (leaseTimer) clearInterval(leaseTimer);
    await leaseRenewal;
  }
}
