import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, constants } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { adminHtml } from "./admin-ui.mjs";
import { capabilityCatalog } from "./capability-policy.mjs";
import { loadConfig } from "./config.mjs";
import { evaluateHealth } from "./health-check.mjs";
import { applyProductionConfigFile } from "./production-config-file.mjs";
import { createProductionStore } from "./production-store.mjs";
import { loadProjectManifests } from "./project-manifests.mjs";
import {
  buildDecisionReviewQueue,
  decisionSha256,
  evaluateDecisionQuality,
  evaluateDecisionQualityBreakdown,
  evaluateDecisionReviewCoverage,
} from "./decision-quality.mjs";
import { safeCommandEnvironment } from "./controlled-command-runner.mjs";
import { isMainModule } from "./main-module.mjs";
import { buildPlanTakeover } from "./plan-takeover.mjs";
import { assessWorkPlan } from "./work-plan.mjs";

const execFileAsync = promisify(execFile);

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const implementedCapabilities = new Set(
  Object.entries(capabilityCatalog)
    .filter(([, definition]) => definition.runtime)
    .map(([name]) => name),
);
const securityHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function equalToken(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response, status, value) {
  response.writeHead(status, {
    ...securityHeaders,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJson(request, maxBytes = 65_536) {
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
    throw Object.assign(new Error("content_type_must_be_json"), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw Object.assign(new Error("request_too_large"), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function taskSummary(task, review = null) {
  const draft = String(task.result?.reply ?? "");
  return {
    id: task.id,
    status: task.status,
    senderName: task.payload?.senderName ?? null,
    contentPreview: String(task.payload?.content ?? "").slice(0, 180),
    draft,
    draftSha256: createHash("sha256").update(draft).digest("hex"),
    decisionSha256: decisionSha256(task.result),
    shouldReply: task.result?.shouldReply ?? null,
    riskLevel: task.result?.riskLevel ?? null,
    reason: task.result?.reason ?? null,
    expectedShouldReply:
      review?.decisionCurrent === false ? null : review?.expectedShouldReply ?? null,
    reviewedAt: review?.updatedAt ?? null,
    attempts: task.attempts,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

function planSummary(plan, stepRecords = []) {
  const executionByStep = new Map(
    stepRecords.map((step) => [step.step_id, step]),
  );
  return {
    id: plan.id,
    projectId: plan.project_id,
    objective: plan.objective,
    maxLevel: plan.max_level,
    status: plan.status,
    policyDecision: plan.policy_decision,
    planHash: plan.plan_hash,
    supersedesWorkPlanId: plan.supersedes_work_plan_id ?? null,
    revisionActor: plan.revision_actor ?? null,
    steps: (plan.plan?.steps ?? []).map((step) => {
      const execution = executionByStep.get(step.id);
      return {
        id: step.id,
        capability: step.capability,
        description: step.description,
        workingDirectory: step.workingDirectory,
        inputs: step.inputs,
        expectedEvidence: step.expectedEvidence,
        rollback: step.rollback,
        execution: execution
          ? {
              status: execution.status,
              evidenceKind: execution.evidence?.kind ?? null,
              verification: execution.evidence?.verification ?? null,
              terminationSignal: execution.evidence?.terminationSignal ?? null,
              error: execution.error ?? null,
              startedAt: execution.started_at ?? null,
              completedAt: execution.completed_at ?? null,
            }
          : null,
      };
    }),
    updatedAt: plan.updated_at,
  };
}

function memorySummary(memory) {
  return {
    id: memory.id,
    type: memory.type,
    subject: memory.subject,
    statement: memory.statement,
    status: memory.status,
    sensitivity: memory.sensitivity,
    projectId: memory.project_id,
    expiresAt: memory.expires_at,
    updatedAt: memory.updated_at,
  };
}

async function executable(path) {
  return access(path, constants.X_OK).then(() => true).catch(() => false);
}

async function dwsCapabilityAvailable(path, probe) {
  if (!(await executable(path))) return false;
  if (!probe) return true;
  return execFileAsync(path, [...probe, "--help", "--format", "json"], {
    timeout: 5_000,
    maxBuffer: 512 * 1024,
    env: safeCommandEnvironment(path),
  }).then(() => true).catch(() => false);
}

async function capabilityAvailable(name, rule, config) {
  const runtime = capabilityCatalog[name]?.runtime;
  if (!runtime) return false;
  if (runtime === "codex") return executable(config.codexPath);
  if (runtime === "gbrain") {
    return execFileAsync(config.gbrainPath, ["version"], {
      timeout: 5_000,
      maxBuffer: 512 * 1024,
      env: safeCommandEnvironment(config.gbrainPath),
    }).then(() => true).catch(() => false);
  }
  if (runtime === "dws") {
    return dwsCapabilityAvailable(config.dwsPath, capabilityCatalog[name].probe);
  }
  if (runtime === "git") return executable("/usr/bin/git");
  if (runtime === "commands") {
    const commands = Object.values(rule?.commands ?? {});
    return commands.length > 0 &&
      (await Promise.all(commands.map((command) => executable(command.executable))))
        .every(Boolean);
  }
  return runtime === "builtin";
}

async function capabilitySnapshot(config) {
  const projects = config.projectsDirectory
    ? [...(await loadProjectManifests(config.projectsDirectory)).values()]
    : [];
  return {
    global: [
      "draft_reply",
      "work_plan_proposal",
      "work_plan_execution",
      "send_message",
      "send_group_message",
    ].map((name) => ({ name, enabled: config.capabilities.has(name) })),
    catalog: Object.entries(capabilityCatalog).map(([name, definition]) => ({
      name,
      level: definition.level,
      sideEffect: definition.sideEffect,
      implemented: implementedCapabilities.has(name),
    })),
    projects: await Promise.all(projects.map(async (project) => ({
      projectId: project.projectId,
      name: project.name,
      rootLabel: basename(project.rootDirectory),
      requesterCount: project.requesters.length,
      capabilities: await Promise.all(
        Object.entries(project.capabilities).map(async ([name, rule]) => ({
          name,
          level: capabilityCatalog[name].level,
          mode: rule.mode,
          expiresAt: rule.expiresAt,
          maxRuns: rule.maxRuns,
          available:
            rule.mode !== "disabled" &&
            (!rule.expiresAt || new Date(rule.expiresAt) > new Date()) &&
            await capabilityAvailable(name, rule, config),
        })),
      ),
    }))),
  };
}

export async function startAdminServer({
  config = loadConfig({ requireTargets: false, production: true }),
  store = null,
  manifestLoader = loadProjectManifests,
} = {}) {
  if (!loopbackHosts.has(config.adminHost)) {
    throw new Error("Admin server must remain loopback-only");
  }
  if (!config.adminReadToken || !config.adminWriteToken) {
    throw new Error("Admin read and write tokens are required");
  }
  store = store ?? (await createProductionStore(config));
  const readAuthorized = (request) =>
    equalToken(
      request.headers.authorization?.replace(/^Bearer\s+/iu, ""),
      config.adminReadToken,
    );
  const writeAuthorized = (request) =>
    readAuthorized(request) &&
    equalToken(
      request.headers["x-ai-employee-write-token"],
      config.adminWriteToken,
    );

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      const nonce = randomBytes(18).toString("base64");
      response.writeHead(200, {
        ...securityHeaders,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      response.end(adminHtml.replaceAll("__NONCE__", nonce));
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (!readAuthorized(request)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method !== "GET" && !writeAuthorized(request)) {
      json(response, 403, { error: "write_token_required" });
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/overview") {
        const [health, plans, memories, capabilities] = await Promise.all([
          evaluateHealth({ store, config }),
          store.listWorkPlans({ limit: 100 }),
          store.listMemories({ status: "confirmed", limit: 100 }),
          capabilitySnapshot(config),
        ]);
        json(response, 200, {
          ready: health.ready,
          paused: health.state.paused,
          checks: health.checks,
          taskCounts: health.state.tasks,
          planCount: plans.length,
          planCounts: Object.fromEntries(
            [...new Set(plans.map((plan) => plan.status))].map((status) => [
              status,
              plans.filter((plan) => plan.status === status).length,
            ]),
          ),
          confirmedMemoryCount: memories.length,
          projectCount: capabilities.projects.length,
          sendMode: config.capabilities.has("send_message")
            ? "真实发送已启用"
            : "真实发送关闭",
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/tasks") {
        const status = url.searchParams.get("status") || undefined;
        const [items, reviews] = await Promise.all([
          store.listTasks({ status, limit: 100 }),
          store.listDecisionReviews({ limit: 10_000 }),
        ]);
        const reviewByTask = new Map(reviews.map((review) => [review.taskId, review]));
        json(response, 200, {
          items: items.map((task) => taskSummary(task, reviewByTask.get(task.id))),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/plans") {
        const status = url.searchParams.get("status") || undefined;
        const items = await store.listWorkPlans({ status, limit: 100 });
        const summaries = await Promise.all(items.map(async (plan) =>
          planSummary(
            plan,
            await (store.listWorkPlanSteps?.(plan.id) ?? Promise.resolve([])),
          )));
        json(response, 200, { items: summaries });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/takeover") {
        const plans = await store.listWorkPlans({ limit: 100 });
        const relevant = plans.filter((plan) => [
          "ready", "awaiting_approval", "approved", "executing", "verifying",
          "failed", "cancelled",
        ].includes(plan.status));
        const items = await Promise.all(relevant.map(async (plan) => {
          const steps = await (store.listWorkPlanSteps?.(plan.id) ?? Promise.resolve([]));
          return {
            ...planSummary(plan, steps),
            takeover: buildPlanTakeover(plan, steps),
          };
        }));
        const rank = new Map([
          ["lease_expired", 0],
          ["safe_finishing", 1],
          ["interrupt_requested", 2],
          ["side_effect_running", 3],
          ["interruptible_running", 4],
          ["needs_reconciliation", 5],
          ["interrupt_confirmed", 6],
          ["not_running", 7],
          ["cancelled", 8],
        ]);
        items.sort((left, right) =>
          (rank.get(left.takeover.state) ?? 99) -
            (rank.get(right.takeover.state) ?? 99) ||
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
        json(response, 200, { items: items.slice(0, 50) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/operations") {
        const now = new Date();
        json(response, 200, await store.operationalMetrics({
          since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
          now,
          availabilityIntervalMs: config.availabilitySampleIntervalMs,
          availabilityWindowMs: config.availabilityWindowMs,
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/memories") {
        const status = url.searchParams.get("status") || undefined;
        const items = await store.listMemories({ status, limit: 100 });
        const conflictReport = await store.memoryConflictMetrics();
        const conflicts = new Map(
          conflictReport.items.map((item) => [item.memoryId, item]),
        );
        json(response, 200, {
          items: items.map((memory) => ({
            ...memorySummary(memory),
            conflict: conflicts.get(memory.id) ?? null,
          })),
          conflictReport: {
            candidates: conflictReport.candidates,
            conflictCandidates: conflictReport.conflictCandidates,
            duplicateCandidates: conflictReport.duplicateCandidates,
            activeConflictGroups: conflictReport.activeConflictGroups,
            conflictRate: conflictReport.conflictRate,
            healthy: conflictReport.healthy,
          },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/scoped-pauses") {
        json(response, 200, { items: await store.listScopedPauses() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/capabilities") {
        json(response, 200, await capabilitySnapshot(config));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/quality") {
        const [reviews, tasks] = await Promise.all([
          store.listDecisionReviews({ limit: 10_000 }),
          store.listTasks({ limit: 500 }),
        ]);
        const report = evaluateDecisionQuality(reviews, {
          minimumSamples: config.shadowMinimumSamples,
          minimumNoReplyAccuracy: config.shadowMinimumNoReplyAccuracy,
        });
        const coverage = evaluateDecisionReviewCoverage(tasks, reviews, {
          targetGroupIds: config.targetGroupIds,
          minimumSamples: config.shadowMinimumSamples,
        });
        report.gates.coverage = coverage.accepted;
        report.accepted = Object.values(report.gates).every(Boolean);
        const queue = buildDecisionReviewQueue(tasks, reviews, {
          targetGroupIds: config.targetGroupIds,
          limit: 50,
        });
        json(response, 200, {
          ...report,
          coverage,
          breakdown: evaluateDecisionQualityBreakdown(reviews, {
            targetGroupIds: config.targetGroupIds,
          }),
          queue: queue.map(({ task, priority, priorityReasons, selectionKind }) => ({
            ...taskSummary(task),
            reviewContent: String(task.payload?.content ?? "").slice(0, 4_000),
            priority,
            priorityReasons,
            selectionKind,
          })),
        });
        return;
      }

      const taskDecision = url.pathname.match(/^\/api\/tasks\/([^/]+)\/decision$/u);
      const taskRetry = url.pathname.match(/^\/api\/tasks\/([^/]+)\/retry$/u);
      const taskDismiss = url.pathname.match(/^\/api\/tasks\/([^/]+)\/dismiss$/u);
      const taskReview = url.pathname.match(/^\/api\/tasks\/([^/]+)\/review$/u);
      const planDecision = url.pathname.match(/^\/api\/plans\/([^/]+)\/decision$/u);
      const planCancellation = url.pathname.match(/^\/api\/plans\/([^/]+)\/cancel$/u);
      const planRevision = url.pathname.match(/^\/api\/plans\/([^/]+)\/revise$/u);
      const memoryDecision = url.pathname.match(/^\/api\/memories\/([^/]+)\/decision$/u);
      if (request.method === "POST" && url.pathname === "/api/scoped-pauses") {
        const body = await readJson(request);
        const type = String(body.type ?? "").trim();
        const value = String(body.value ?? "").trim();
        const paused = Boolean(body.paused);
        const existing = await store.listScopedPauses();
        let allowed = existing.some(
          (item) => item.type === type && item.value === value,
        );
        if (paused && type === "contact") {
          allowed = (config.targetUserIds ?? []).includes(value);
        } else if (paused && type === "project") {
          const projects = await manifestLoader(config.projectsDirectory);
          allowed = projects.has(value);
        } else if (paused && type === "capability") {
          allowed = Object.hasOwn(capabilityCatalog, value);
        }
        if (!allowed) {
          throw Object.assign(new Error("scope_is_not_configured"), { status: 400 });
        }
        const status = await store.setScopedPause({
          type,
          value,
          paused,
          actor: "admin-ui",
          reason: String(body.reason ?? ""),
        });
        json(response, 200, { paused: status });
        return;
      }
      if (request.method === "POST" && taskDecision) {
        const body = await readJson(request);
        if (!["approved", "rejected"].includes(body.decision)) {
          throw Object.assign(new Error("invalid_decision"), { status: 400 });
        }
        const taskId = decodeURIComponent(taskDecision[1]);
        if (body.decision === "approved") {
          const current = await store.getTask(taskId);
          const draftSha256 = createHash("sha256")
            .update(String(current?.result?.reply ?? ""))
            .digest("hex");
          if (!current || !equalToken(body.draftSha256, draftSha256)) {
            throw Object.assign(new Error("draft_changed_review_again"), { status: 409 });
          }
        }
        const status = await store.decideTask(taskId, {
          decision: body.decision,
          actor: "admin-ui",
          reason: String(body.reason ?? ""),
        });
        json(response, 200, { status });
        return;
      }
      if (request.method === "POST" && taskRetry) {
        await readJson(request);
        await store.retryTask(decodeURIComponent(taskRetry[1]));
        json(response, 200, { status: "queued" });
        return;
      }
      if (request.method === "POST" && taskDismiss) {
        const body = await readJson(request);
        const status = await store.dismissDeadTask(
          decodeURIComponent(taskDismiss[1]),
          "admin-ui",
          String(body.reason ?? ""),
        );
        json(response, 200, { status });
        return;
      }
      if (request.method === "POST" && taskReview) {
        const body = await readJson(request);
        if (typeof body.expectedShouldReply !== "boolean") {
          throw Object.assign(new Error("expected_should_reply_must_be_boolean"), { status: 400 });
        }
        const taskId = decodeURIComponent(taskReview[1]);
        const current = await store.getTask(taskId);
        if (!current) throw Object.assign(new Error("task_not_found"), { status: 404 });
        const currentSummary = taskSummary(current);
        if (!equalToken(body.decisionSha256, currentSummary.decisionSha256)) {
          throw Object.assign(new Error("decision_changed_review_again"), { status: 409 });
        }
        const note = String(body.note ?? "").trim();
        if (body.expectedShouldReply !== current.result?.shouldReply && !note) {
          throw Object.assign(new Error("note_required_for_disagreement"), { status: 400 });
        }
        const review = await store.upsertDecisionReview(taskId, {
          expectedShouldReply: body.expectedShouldReply,
          reviewer: config.approver,
          note,
        });
        json(response, 200, { review });
        return;
      }
      if (request.method === "POST" && planRevision) {
        const body = await readJson(request, 512 * 1024);
        const planId = decodeURIComponent(planRevision[1]);
        const current = await store.getWorkPlan(planId);
        if (!current) {
          throw Object.assign(new Error("work_plan_not_found"), { status: 404 });
        }
        if (!equalToken(body.currentPlanHash, current.plan_hash)) {
          throw Object.assign(new Error("plan_changed_review_again"), { status: 409 });
        }
        if (!body.plan || typeof body.plan !== "object" || Array.isArray(body.plan)) {
          throw Object.assign(new Error("revised_plan_is_required"), { status: 400 });
        }
        const projects = await manifestLoader(config.projectsDirectory);
        const manifest = projects.get(current.project_id);
        if (!manifest) {
          throw Object.assign(new Error("project_manifest_unavailable"), { status: 409 });
        }
        let assessment;
        try {
          assessment = assessWorkPlan({
            manifest,
            plan: {
              ...current.plan,
              objective: body.plan.objective,
              steps: body.plan.steps,
            },
          });
        } catch {
          throw Object.assign(new Error("invalid_revised_plan"), { status: 400 });
        }
        if (!["ALLOW", "REQUIRE_APPROVAL"].includes(assessment.decision)) {
          throw Object.assign(new Error("revised_plan_denied_by_policy"), { status: 403 });
        }
        const revised = await store.reviseWorkPlan(
          planId,
          assessment,
          "admin-ui",
        );
        json(response, 200, { plan: planSummary(revised) });
        return;
      }
      if (request.method === "POST" && planDecision) {
        const body = await readJson(request);
        if (!["approved", "rejected"].includes(body.decision)) {
          throw Object.assign(new Error("invalid_decision"), { status: 400 });
        }
        const planId = decodeURIComponent(planDecision[1]);
        if (body.decision === "approved") {
          const current = await store.getWorkPlan(planId);
          if (!current || !equalToken(body.planHash, current.plan_hash)) {
            throw Object.assign(new Error("plan_changed_review_again"), { status: 409 });
          }
        }
        const status = await store.decideWorkPlan(planId, {
          decision: body.decision,
          actor: "admin-ui",
          reason: String(body.reason ?? ""),
        });
        json(response, 200, { status });
        return;
      }
      if (request.method === "POST" && planCancellation) {
        const body = await readJson(request);
        const planId = decodeURIComponent(planCancellation[1]);
        const current = await store.getWorkPlan(planId);
        if (!current || !equalToken(body.planHash, current.plan_hash)) {
          throw Object.assign(new Error("plan_changed_review_again"), { status: 409 });
        }
        const status = await store.requestWorkPlanCancellation(
          planId,
          "admin-ui",
        );
        json(response, 200, { status });
        return;
      }
      if (request.method === "POST" && memoryDecision) {
        const body = await readJson(request);
        const id = decodeURIComponent(memoryDecision[1]);
        const status = body.decision === "confirmed"
          ? await store.confirmMemory(id, "admin-ui", new Date(), {
              supersedesId: body.supersedesId ?? null,
            })
          : body.decision === "revoked"
            ? await store.revokeMemory(id, "admin-ui")
            : null;
        if (!status) throw Object.assign(new Error("invalid_decision"), { status: 400 });
        json(response, 200, { status });
        return;
      }
      if (
        request.method === "POST" &&
        ["/api/system/pause", "/api/system/resume"].includes(url.pathname)
      ) {
        await readJson(request);
        await store.setPaused(url.pathname.endsWith("/pause"));
        json(response, 200, { paused: await store.isPaused() });
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      json(response, error.status ?? 409, { error: error.message ?? "operation_failed" });
    }
  });

  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(config.adminPort, config.adminHost, accept);
  });
  console.log(JSON.stringify({ type: "admin.started", host: config.adminHost }));
  return {
    server,
    async stop(signal = "manual") {
      await new Promise((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
      await store.close();
      console.log(JSON.stringify({ type: "admin.stopped", signal }));
    },
  };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  if (process.env.AI_EMPLOYEE_CONFIG_FILE) await applyProductionConfigFile();
  const service = await startAdminServer();
  const shutdown = async (signal) => {
    await service.stop(signal);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
