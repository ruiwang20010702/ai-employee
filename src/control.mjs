import { loadConfig } from "./config.mjs";
import { createProductionStore } from "./production-store.mjs";
import { applyProductionConfigFile } from "./production-config-file.mjs";
import { readStdin } from "./stdin.mjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateProjectManifest } from "./capability-policy.mjs";
import { assessWorkPlan } from "./work-plan.mjs";
import { createControlledWorkAdapters } from "./work-adapters.mjs";
import { executeWorkPlan } from "./work-executor.mjs";
import {
  evaluateDecisionQuality,
  evaluateDecisionReviewCoverage,
} from "./decision-quality.mjs";

const [command = "list", argument, ...rest] = process.argv.slice(2);
if (process.env.AI_EMPLOYEE_CONFIG_FILE) {
  await applyProductionConfigFile();
}
const config = loadConfig({ requireTargets: false, production: true });
const store = await createProductionStore(config);

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

try {
  if (command === "list") {
    print(
      (await store.listTasks({ status: argument, limit: 100 })).map((task) => ({
        id: task.id,
        status: task.status,
        senderName: task.payload?.senderName,
        content: task.payload?.content,
        draft: task.result?.reply,
        riskLevel: task.result?.riskLevel,
        reason: task.result?.reason,
        attempts: task.attempts,
        lastError: task.last_error,
        createdAt: task.created_at,
      })),
    );
  } else if (command === "show") {
    if (!argument) throw new Error("Usage: control show <taskId>");
    print(await store.getTask(argument));
  } else if (command === "approve" || command === "reject") {
    if (!argument) throw new Error(`Usage: control ${command} <taskId> [reason]`);
    const decision = command === "approve" ? "approved" : "rejected";
    print({
      taskId: argument,
      status: await store.decideTask(argument, {
        decision,
        actor: process.env.AI_EMPLOYEE_APPROVER ?? "local-user",
        reason: rest.join(" "),
      }),
    });
  } else if (command === "pause" || command === "resume") {
    await store.setPaused(command === "pause");
    print({ paused: await store.isPaused() });
  } else if (command === "retry") {
    if (!argument) throw new Error("Usage: control retry <taskId>");
    await store.retryTask(argument);
    print({ taskId: argument, status: "queued" });
  } else if (command === "dismiss-dead") {
    if (!argument) throw new Error("Usage: control dismiss-dead <taskId> [reason]");
    print({
      taskId: argument,
      status: await store.dismissDeadTask(
        argument,
        process.env.AI_EMPLOYEE_APPROVER ?? "local-user",
        rest.join(" "),
      ),
    });
  } else if (command === "resolve-sent" || command === "resolve-not-sent") {
    if (!argument) throw new Error(`Usage: control ${command} <taskId>`);
    const resolution = command === "resolve-sent" ? "sent" : "not_sent";
    await store.resolveUnknownSend(
      argument,
      resolution,
      process.env.AI_EMPLOYEE_APPROVER ?? "local-user",
    );
    print({ taskId: argument, resolution });
  } else if (command === "purge") {
    const days = Number(argument ?? 30);
    if (!Number.isFinite(days) || days < 1) {
      throw new Error("Usage: control purge <days>, days must be >= 1");
    }
    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    print({ purgedTasks: await store.purgeCompleted({ before }), before });
  } else if (command === "memory-propose") {
    const [subject, sourceType, sourceId, projectId, expiresAt] = rest;
    if (!argument || !subject || !sourceType || !sourceId) {
      throw new Error(
        "Usage: control memory-propose <type> <subject> <sourceType> <sourceId> [projectId] [expiresAt], statement from stdin",
      );
    }
    const statement = (await readStdin()).trim();
    const id = await store.proposeMemory({
      type: argument,
      subject,
      sourceType,
      sourceId,
      projectId: projectId || null,
      expiresAt: expiresAt || null,
      statement,
      createdBy: process.env.AI_EMPLOYEE_APPROVER ?? "local-user",
    });
    print({ id, status: "proposed" });
  } else if (command === "memory-confirm" || command === "memory-revoke") {
    if (!argument) throw new Error(`Usage: control ${command} <memoryId>`);
    const actor = process.env.AI_EMPLOYEE_APPROVER ?? "local-user";
    const status =
      command === "memory-confirm"
        ? await store.confirmMemory(argument, actor)
        : await store.revokeMemory(argument, actor);
    print({ id: argument, status });
  } else if (command === "memory-list") {
    print(await store.listMemories({ status: argument, limit: 100 }));
  } else if (command === "memory-search") {
    const query = (await readStdin()).trim();
    print(
      await store.searchMemories({
        query,
        type: argument || undefined,
        subject: rest[0] || undefined,
      }),
    );
  } else if (command === "scope-list") {
    print(await store.listScopedPauses());
  } else if (command === "scope-pause" || command === "scope-resume") {
    const value = rest[0];
    if (!argument || !value) {
      throw new Error(`Usage: control ${command} <contact|project|capability> <value> [reason]`);
    }
    const paused = command === "scope-pause";
    print({
      type: argument,
      value,
      paused: await store.setScopedPause({
        type: argument,
        value,
        paused,
        actor: process.env.AI_EMPLOYEE_APPROVER ?? "local-user",
        reason: rest.slice(1).join(" "),
      }),
    });
  } else if (command === "plan-register") {
    if (!argument) throw new Error("Usage: control plan-register <manifestPath>, plan from stdin");
    const [manifestInput, planInput] = await Promise.all([
      readFile(resolve(argument), "utf8"),
      readStdin(),
    ]);
    const assessment = assessWorkPlan({
      manifest: validateProjectManifest(JSON.parse(manifestInput)),
      plan: JSON.parse(planInput),
    });
    if (!["ALLOW", "REQUIRE_APPROVAL"].includes(assessment.decision)) {
      print({ decision: assessment.decision, reason: assessment.reason });
    } else {
      const plan = await store.registerWorkPlan(assessment);
      print({
        id: plan.id,
        status: plan.status,
        planHash: plan.plan_hash,
        maxLevel: plan.max_level,
      });
    }
  } else if (command === "plan-show") {
    if (!argument) throw new Error("Usage: control plan-show <workPlanId>");
    print(await store.getWorkPlan(argument));
  } else if (command === "plan-revise") {
    const manifestPath = rest[0];
    if (!argument || !manifestPath) {
      throw new Error(
        "Usage: control plan-revise <workPlanId> <manifestPath>, revised plan from stdin",
      );
    }
    const [manifestInput, planInput] = await Promise.all([
      readFile(resolve(manifestPath), "utf8"),
      readStdin(),
    ]);
    const assessment = assessWorkPlan({
      manifest: validateProjectManifest(JSON.parse(manifestInput)),
      plan: JSON.parse(planInput),
    });
    const revised = await store.reviseWorkPlan(
      argument,
      assessment,
      process.env.AI_EMPLOYEE_APPROVER ?? "local-user",
    );
    print({
      previousId: argument,
      id: revised.id,
      status: revised.status,
      planHash: revised.plan_hash,
      maxLevel: revised.max_level,
      supersedesWorkPlanId: revised.supersedes_work_plan_id,
    });
  } else if (command === "plan-approve" || command === "plan-reject") {
    if (!argument) throw new Error(`Usage: control ${command} <workPlanId> [reason]`);
    const decision = command === "plan-approve" ? "approved" : "rejected";
    const status = await store.decideWorkPlan(argument, {
      decision,
      actor: process.env.AI_EMPLOYEE_APPROVER ?? "local-user",
      reason: rest.join(" "),
    });
    print({ id: argument, status });
  } else if (command === "plan-cancel") {
    if (!argument) throw new Error("Usage: control plan-cancel <workPlanId>");
    const current = await store.getWorkPlan(argument);
    if (!current) throw new Error("Work plan not found");
    print({
      id: argument,
      planHash: current.plan_hash,
      status: await store.requestWorkPlanCancellation(
        argument,
        process.env.AI_EMPLOYEE_APPROVER ?? "local-user",
      ),
    });
  } else if (command === "plan-execute") {
    const manifestPath = rest[0];
    if (!argument || !manifestPath) {
      throw new Error("Usage: control plan-execute <workPlanId> <manifestPath>");
    }
    const manifest = validateProjectManifest(
      JSON.parse(await readFile(resolve(manifestPath), "utf8")),
    );
    const result = await executeWorkPlan({
      store,
      planId: argument,
      manifest,
      adapters: createControlledWorkAdapters({
        codexPath: config.codexPath,
        dwsPath: config.dwsPath,
      }),
    });
    const notification = await store.ensureWorkPlanResultDraft?.(argument);
    print({
      status: result.status,
      failedStep: result.failedStep,
      errorCode: result.errorCode,
      notificationTaskId: notification?.id,
      steps: result.evidence?.map((step) => ({
        id: step.step_id,
        status: step.status,
        kind: step.evidence?.kind,
        bytes: step.evidence?.bytes,
        sha256: step.evidence?.sha256,
        verification: step.evidence?.verification,
      })),
    });
  } else if (command === "plan-evidence") {
    if (!argument) throw new Error("Usage: control plan-evidence <workPlanId>");
    print(await store.listWorkPlanSteps(argument));
  } else if (command === "review-label") {
    const label = rest[0];
    if (!argument || !["reply", "no-reply"].includes(label)) {
      throw new Error("Usage: control review-label <taskId> reply|no-reply [note]");
    }
    print(await store.upsertDecisionReview(argument, {
      expectedShouldReply: label === "reply",
      reviewer: config.approver,
      note: rest.slice(1).join(" "),
    }));
  } else if (command === "review-report") {
    const [reviews, tasks] = await Promise.all([
      store.listDecisionReviews({ limit: 10_000 }),
      store.listTasks({ limit: 500 }),
    ]);
    const quality = evaluateDecisionQuality(reviews, {
      minimumSamples: config.shadowMinimumSamples,
      minimumNoReplyAccuracy: config.shadowMinimumNoReplyAccuracy,
    });
    quality.coverage = evaluateDecisionReviewCoverage(tasks, reviews, {
      targetGroupIds: config.targetGroupIds,
      minimumSamples: config.shadowMinimumSamples,
    });
    quality.gates.coverage = quality.coverage.accepted;
    quality.accepted = Object.values(quality.gates).every(Boolean);
    print(quality);
  } else {
    throw new Error(
      "Commands: list, show, approve, reject, retry, dismiss-dead, resolve-sent, resolve-not-sent, purge, pause, resume, scope-list, scope-pause, scope-resume, memory-propose, memory-confirm, memory-revoke, memory-list, memory-search, plan-register, plan-show, plan-revise, plan-approve, plan-reject, plan-cancel, plan-execute, plan-evidence, review-label, review-report",
    );
  }
} finally {
  await store.close();
}
