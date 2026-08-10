import { loadConfig } from "./config.mjs";
import { createProductionStore } from "./production-store.mjs";
import { controlStoreOptions } from "./control-access.mjs";
import { applyProductionConfigFile } from "./production-config-file.mjs";
import { readStdin } from "./stdin.mjs";
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { validateProjectManifest } from "./capability-policy.mjs";
import { assessWorkPlan } from "./work-plan.mjs";
import { createControlledWorkAdapters } from "./work-adapters.mjs";
import { executeWorkPlan } from "./work-executor.mjs";
import {
  createStructuredDecisionReviewNote,
  evaluateDecisionQuality,
  evaluateDecisionQualityDiagnostics,
  evaluateDecisionReviewCoverage,
  summarizeDecisionDisagreementReasons,
} from "./decision-quality.mjs";
import {
  createMemoryExport,
  memoryDeletionConfirmation,
  validateMemoryExportMode,
  writeMemoryExport,
} from "./memory-portability.mjs";
import {
  checkMemorySourceAccess,
  reconcileMemorySources,
} from "./memory-source-access.mjs";
import { loadProjectManifests } from "./project-manifests.mjs";

const [command = "list", argument, ...rest] = process.argv.slice(2);
if (process.env.AI_EMPLOYEE_CONFIG_FILE) {
  await applyProductionConfigFile();
}
const config = loadConfig({ requireTargets: false, production: true });
const store = await createProductionStore(config, controlStoreOptions(command));

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function parseReviewOptions(tokens) {
  const names = new Map([
    ["--response-reason", "responseReasonCode"],
    ["--draft", "draftAssessment"],
    ["--draft-reason", "draftReasonCode"],
    ["--detail", "detail"],
  ]);
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const field = names.get(tokens[index]);
    const value = tokens[index + 1];
    if (!field || value == null || String(value).startsWith("--")) {
      throw new Error("Invalid review-label options");
    }
    if (Object.hasOwn(options, field)) throw new Error("Duplicate review-label option");
    options[field] = value;
  }
  return options;
}

async function refreshMemorySource(memory) {
  const change = await checkMemorySourceAccess(memory, {
    projects: await loadProjectManifests(config.projectsDirectory),
    gbrainPath: config.gbrainPath,
    leaseMs: config.memorySourceLeaseMs,
  });
  await store.setMemorySourceAccess(
    memory.id,
    change,
    "system:memory-source",
  );
  return change;
}

async function readPrivacySelector() {
  const value = (await readStdin()).trim();
  if (!value) {
    throw new Error("Privacy erasure selector JSON is required on stdin");
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Privacy erasure selector on stdin must be valid JSON");
  }
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
  } else if (command === "privacy-delete-preview") {
    print(await store.previewPrivacyErasure(await readPrivacySelector()));
  } else if (command === "privacy-delete") {
    if (!argument) {
      throw new Error(
        "Usage: selector JSON on stdin | control privacy-delete <confirmation>",
      );
    }
    print(await store.erasePrivacyData(
      await readPrivacySelector(),
      argument,
      config.approver,
    ));
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
    if (!argument) {
      throw new Error(
        command === "memory-confirm"
          ? "Usage: control memory-confirm <memoryId> [supersedesMemoryId]"
          : "Usage: control memory-revoke <memoryId>",
      );
    }
    const actor = process.env.AI_EMPLOYEE_APPROVER ?? "local-user";
    if (command === "memory-confirm") {
      const memory = await store.getMemory(argument);
      if (!memory) throw new Error(`Memory not found: ${argument}`);
      if (memory?.source_type === "gbrain") {
        const sourceAccess = await refreshMemorySource(memory);
        if (sourceAccess.status !== "verified") {
          throw new Error(`Memory source access is not verified: ${sourceAccess.reason}`);
        }
      }
    }
    const status =
      command === "memory-confirm"
        ? await store.confirmMemory(argument, actor, new Date(), {
            supersedesId: rest[0] ?? null,
          })
        : await store.revokeMemory(argument, actor);
    print({ id: argument, status });
  } else if (command === "memory-list") {
    print(await store.listMemories({ status: argument, limit: 100 }));
  } else if (command === "memory-source-check") {
    if (!argument || argument === "all") {
      const report = await reconcileMemorySources({
        store,
        projects: await loadProjectManifests(config.projectsDirectory),
        gbrainPath: config.gbrainPath,
        leaseMs: config.memorySourceLeaseMs,
        limit: config.memorySourceLimit,
      });
      print(report);
    } else {
      const memory = await store.getMemory(argument);
      if (!memory || memory.source_type !== "gbrain") {
        throw new Error("gbrain memory not found");
      }
      const change = await refreshMemorySource(memory);
      print({ id: memory.id, ...change });
    }
  } else if (command === "memory-delete-preview") {
    if (!argument) throw new Error("Usage: control memory-delete-preview <memoryId>");
    print({
      id: argument,
      confirmation: memoryDeletionConfirmation(argument),
      warning: "This permanently erases memory content and cannot be undone.",
    });
  } else if (command === "memory-delete") {
    if (!argument || !rest[0]) {
      throw new Error("Usage: control memory-delete <memoryId> <confirmation>");
    }
    print({
      id: argument,
      status: await store.deleteMemory(
        argument,
        config.approver,
        rest[0],
      ),
    });
  } else if (command === "memory-export") {
    const [projectScope = "all", mode = "metadata", confirmation] = rest;
    if (!argument) {
      throw new Error(
        "Usage: control memory-export <absolute.json> <projectId|all> <metadata|content> [EXPORT-CONTENT]",
      );
    }
    const includeContent = validateMemoryExportMode(mode, confirmation);
    const projectId = projectScope === "all" ? null : projectScope;
    const memories = await store.listMemories({
      projectId: projectId ?? undefined,
      // Fetch one extra row so an oversized export fails instead of silently
      // producing a truncated file.
      limit: 10_001,
    });
    const payload = createMemoryExport(memories, { projectId, includeContent });
    const destination = await writeMemoryExport(argument, payload);
    try {
      await store.recordMemoryExport({
        actor: config.approver,
        projectId,
        includeContent,
        count: payload.itemCount,
        destination,
      });
    } catch (error) {
      await unlink(destination).catch(() => {});
      throw error;
    }
    print({
      exported: true,
      path: destination,
      itemCount: payload.itemCount,
      contentIncluded: payload.contentIncluded,
      mode: "600",
    });
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
      throw new Error("Usage: control review-label <taskId> reply|no-reply [--response-reason code] [--draft usable|needs_revision|unsafe] [--draft-reason code] [--detail text]");
    }
    const task = await store.getTask(argument);
    if (!task || typeof task.result?.shouldReply !== "boolean") {
      throw new Error("Task has no completed reply decision");
    }
    const expectedShouldReply = label === "reply";
    const note = createStructuredDecisionReviewNote({
      predictedShouldReply: task.result.shouldReply,
      expectedShouldReply,
      draft: task.result.reply ?? "",
      ...parseReviewOptions(rest.slice(1)),
    });
    print(await store.upsertDecisionReview(argument, {
      expectedShouldReply,
      reviewer: config.approver,
      note,
    }));
  } else if (command === "review-report") {
    const [reviews, tasks] = await Promise.all([
      store.listDecisionReviews({ limit: 10_000 }),
      store.listTasks({ limit: 500 }),
    ]);
    const quality = evaluateDecisionQuality(reviews, {
      minimumSamples: config.shadowMinimumSamples,
      minimumReplyAccuracy: config.shadowMinimumReplyAccuracy,
      minimumNoReplyAccuracy: config.shadowMinimumNoReplyAccuracy,
      minimumDraftSamples: config.shadowMinimumDraftSamples,
      minimumDraftUsability: config.shadowMinimumDraftUsability,
    });
    quality.coverage = evaluateDecisionReviewCoverage(tasks, reviews, {
      targetGroupIds: config.targetGroupIds,
      minimumSamples: config.shadowMinimumSamples,
    });
    quality.diagnostics = evaluateDecisionQualityDiagnostics(reviews, {
      targetGroupIds: config.targetGroupIds,
    });
    quality.disagreementReasons = summarizeDecisionDisagreementReasons(reviews);
    quality.gates.coverage = quality.coverage.accepted;
    quality.accepted = Object.values(quality.gates).every(Boolean);
    print(quality);
  } else {
    throw new Error(
      "Commands: list, show, approve, reject, retry, dismiss-dead, resolve-sent, resolve-not-sent, purge, privacy-delete-preview, privacy-delete, pause, resume, scope-list, scope-pause, scope-resume, memory-propose, memory-confirm, memory-revoke, memory-list, memory-search, memory-source-check, memory-delete-preview, memory-delete, memory-export, plan-register, plan-show, plan-revise, plan-approve, plan-reject, plan-cancel, plan-execute, plan-evidence, review-label, review-report",
    );
  }
} finally {
  await store.close();
}
