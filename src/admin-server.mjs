import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, constants, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { adminHtml } from "./admin-ui.mjs";
import { personalDashboardHtml } from "./personal-dashboard-ui.mjs";
import { capabilityCatalog } from "./capability-policy.mjs";
import { loadConfig } from "./config.mjs";
import { evaluateHealth } from "./health-check.mjs";
import { applyProductionConfigFile } from "./production-config-file.mjs";
import { createProductionStore } from "./production-store.mjs";
import { loadProjectManifests } from "./project-manifests.mjs";
import {
  buildDecisionReviewQueue,
  decisionSha256,
  draftSha256,
  evaluateDecisionQuality,
  evaluateDecisionQualityBreakdown,
  createStructuredDecisionReviewNote,
  isDecisionResponseReviewUsable,
  isDraftAssessmentCurrent,
  summarizeDecisionDisagreementReasons,
  evaluateDecisionReviewCoverage,
} from "./decision-quality.mjs";
import { safeCommandEnvironment } from "./controlled-command-runner.mjs";
import { isMainModule } from "./main-module.mjs";
import { safeErrorCode } from "./logging.mjs";
import { buildPlanTakeover } from "./plan-takeover.mjs";
import { evaluateBusinessAcceptance } from "./business-acceptance.mjs";
import { validatePrivacySelector } from "./privacy-erasure.mjs";
import { assessWorkPlan } from "./work-plan.mjs";
import { buildProjectOnboardingDraft } from "./project-onboarding.mjs";
import { buildProjectDashboard } from "./project-dashboard.mjs";
import { loadWorkRecipes } from "./recipe-library.mjs";
import { instantiateWorkRecipe } from "./work-recipe.mjs";
import { validateWorkTrigger } from "./work-trigger.mjs";
import { validateWorkEvent } from "./work-trigger.mjs";
import { ingestProactiveEvent } from "./proactive-runtime.mjs";
import { captureWorkPlanGraph } from "./governed-work-graph-runtime.mjs";

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

function projectMemorySyncState(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
    return {
      state: ["synchronized", "unchanged", "review_required", "failed"]
        .includes(parsed.state) ? parsed.state : "unknown",
      lastCheckedAt: typeof parsed.lastCheckedAt === "string" ? parsed.lastCheckedAt : null,
      lastSuccessAt: typeof parsed.lastSuccessAt === "string" ? parsed.lastSuccessAt : null,
      sourceDigest: /^[a-f0-9]{64}$/u.test(String(parsed.sourceDigest ?? ""))
        ? parsed.sourceDigest
        : null,
      candidatesCreated: Number.isSafeInteger(parsed.candidatesCreated)
        ? Math.max(0, parsed.candidatesCreated)
        : 0,
      memoriesConfirmed: Number.isSafeInteger(parsed.memoriesConfirmed)
        ? Math.max(0, parsed.memoriesConfirmed)
        : 0,
      reviewRequired: Number.isSafeInteger(parsed.reviewRequired)
        ? Math.max(0, parsed.reviewRequired)
        : 0,
      errorCode: typeof parsed.errorCode === "string"
        ? parsed.errorCode.slice(0, 100)
        : null,
    };
  } catch {
    return null;
  }
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
  const responseReviewUsable = isDecisionResponseReviewUsable(review);
  return {
    id: task.id,
    status: task.status,
    senderName: task.payload?.senderName ?? null,
    contentPreview: String(task.payload?.content ?? "").slice(0, 180),
    draft,
    draftSha256: draftSha256(draft),
    decisionSha256: decisionSha256(task.result),
    shouldReply: task.result?.shouldReply ?? null,
    needsInformation: task.result?.needsInformation ?? false,
    relatedToWaitingTask: task.result?.relatedToWaitingTask ?? false,
    continuationOfTaskId: task.continuation_of_task_id ?? null,
    waitingInformationAt: task.waiting_information_at ?? null,
    riskLevel: task.result?.riskLevel ?? null,
    reason: task.result?.reason ?? null,
    expectedShouldReply:
      responseReviewUsable ? review.expectedShouldReply : null,
    responseReviewUsable,
    draftReviewCurrent: isDraftAssessmentCurrent(review),
    reviewedAt: review?.updatedAt ?? null,
    attempts: task.attempts,
    failureCode: task.last_error ? safeErrorCode(task.last_error) : null,
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
    recipe: plan.plan?.recipe ?? null,
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

function memorySourceEvidence(memory, sourceTasks) {
  if (memory.source_type !== "dingtalk_message") return null;
  const task = sourceTasks.get(memory.source_version);
  if (!task) {
    return { status: "unavailable", reason: "source_task_unavailable" };
  }
  const message = (task.payload?.messages ?? []).find(
    (item) => String(item.id) === String(memory.source_id),
  );
  if (!message) {
    return { status: "unavailable", reason: "source_message_unavailable" };
  }
  return {
    status: "available",
    messageId: String(message.id),
    senderName: String(message.senderName ?? task.payload?.senderName ?? ""),
    occurredAt: message.createTime ?? message.occurredAt ?? null,
    excerpt: String(message.content ?? "").trim().slice(0, 500),
  };
}

function memorySummary(memory, sourceEvidence = null) {
  return {
    id: memory.id,
    type: memory.type,
    subject: memory.subject,
    statement: memory.statement,
    status: memory.status,
    sensitivity: memory.sensitivity,
    projectId: memory.project_id,
    sourceType: memory.source_type,
    sourceId: memory.source_id,
    sourceVersion: memory.source_version,
    sourceAccessStatus: memory.source_access_status,
    sourceAccessReason: memory.source_access_reason,
    sourceAccessCheckedAt: memory.source_access_checked_at,
    sourceAccessExpiresAt: memory.source_access_expires_at,
    sourceEvidence,
    scope: memory.scope,
    confidence: memory.confidence,
    expiresAt: memory.expires_at,
    updatedAt: memory.updated_at,
  };
}

const privacyEligibleCountKeys = Object.freeze([
  "tasks",
  "messages",
  "workPlans",
  "memories",
  "capabilityBudgets",
  "timeReturns",
  "workTriggers",
  "auditEvents",
  "identityReferences",
]);
const privacyBlockedCountKeys = Object.freeze([
  "tasks",
  "messages",
  "workPlans",
  "workTriggers",
  "scopedPauses",
]);

function safePrivacyCounts(input, keys) {
  return Object.fromEntries(keys.map((key) => {
    const value = input?.[key];
    return [key, Number.isSafeInteger(value) && value >= 0 ? value : 0];
  }));
}

function privacyPreviewSummary(preview) {
  const counts = safePrivacyCounts(preview.counts, privacyEligibleCountKeys);
  const blocked = safePrivacyCounts(preview.blocked, privacyBlockedCountKeys);
  const eligibleTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const blockedTotal = Object.values(blocked).reduce((sum, count) => sum + count, 0);
  const type = ["person", "project", "time"].includes(preview.selector?.type)
    ? preview.selector.type
    : null;
  const fingerprint = /^[a-f0-9]{24}$/u.test(preview.selector?.fingerprint ?? "")
    ? preview.selector.fingerprint
    : null;
  const snapshotDigest = /^[a-f0-9]{64}$/u.test(preview.snapshotDigest ?? "")
    ? preview.snapshotDigest
    : null;
  const confirmationCandidate = /^ERASE-[A-F0-9]{16}$/u.test(
    preview.confirmation ?? "",
  ) ? preview.confirmation : null;
  const confirmation =
    eligibleTotal > 0 && blockedTotal === 0 && type && fingerprint && snapshotDigest
      ? confirmationCandidate
      : null;
  return {
    selector: { type, fingerprint },
    counts,
    blocked,
    eligibleTotal,
    blockedTotal,
    confirmation,
    snapshotDigest,
  };
}

function targetFingerprint(config, kind, value) {
  return createHmac("sha256", config.dataKey ?? config.adminWriteToken)
    .update(`admin-target:${kind}:${value}`)
    .digest("hex")
    .slice(0, 16);
}

async function targetSnapshot(config, store) {
  const definitions = [
    ...config.targetUserIds.map((value) => ({ kind: "user", value })),
    ...config.targetGroupIds.map((value) => ({ kind: "group", value })),
  ];
  const items = await Promise.all(definitions.map(async ({ kind, value }) => ({
    kind,
    fingerprint: targetFingerprint(config, kind, value),
    paused: Boolean(await store.isScopedPaused?.(
      kind === "user" ? "contact" : "group",
      value,
    )),
    replyEnabled: kind === "user"
      ? config.capabilities.has("send_message")
      : config.capabilities.has("send_message") &&
        config.capabilities.has("send_group_message"),
  })));
  return {
    counts: {
      users: config.targetUserIds.length,
      groups: config.targetGroupIds.length,
    },
    rules: {
      privateTrigger: "whitelist_message",
      groupTrigger: "whitelist_mention_only",
      mentionRequiresReply: false,
      identifiers: "hmac_fingerprint_only",
    },
    items,
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
  if (runtime === "gh") return Boolean(config.ghPath) && executable(config.ghPath);
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
      "proactive_work",
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
  recipeLoader = loadWorkRecipes,
} = {}) {
  if (!loopbackHosts.has(config.adminHost)) {
    throw new Error("Admin server must remain loopback-only");
  }
  if (!config.adminReadToken || !config.adminWriteToken) {
    throw new Error("Admin read and write tokens are required");
  }
  store = store ?? (await createProductionStore(config));
  const readChallenges = new Map();
  const bearerAuthorized = (request) =>
    equalToken(
      request.headers.authorization?.replace(/^Bearer\s+/iu, ""),
      config.adminReadToken,
    );
  const challengeAuthorized = (request, url, now = Date.now()) => {
    const nonce = String(
      request.headers["x-foursday-challenge"] ??
        request.headers["x-ai-employee-challenge"] ??
        "",
    );
    const proof = String(
      request.headers["x-foursday-proof"] ??
        request.headers["x-ai-employee-proof"] ??
        "",
    );
    const expiresAt = readChallenges.get(nonce);
    if (!expiresAt || expiresAt < now || request.method !== "GET") return false;
    readChallenges.delete(nonce);
    const expected = createHmac("sha256", config.adminReadToken)
      .update(`${nonce}\nGET\n${url.pathname}${url.search}`)
      .digest("hex");
    return equalToken(proof, expected);
  };
  const writeAuthorized = (request) =>
    bearerAuthorized(request) &&
    equalToken(
      request.headers["x-foursday-write-token"] ??
        request.headers["x-ai-employee-write-token"],
      config.adminWriteToken,
    );
  const captureTimeReturnGraph = async (entry, observedAt = new Date()) => {
    const [projects, recipes, plan] = await Promise.all([
      manifestLoader(config.projectsDirectory),
      recipeLoader(config.recipesDirectory),
      store.getWorkPlan(entry.workPlanId),
    ]);
    const manifest = projects.get(entry.projectId);
    const recipe = recipes.get(entry.recipeId);
    if (!manifest || !recipe || !plan) {
      throw new Error("time_return_graph_context_unavailable");
    }
    return captureWorkPlanGraph({
      store,
      tenantId: config.tenantId,
      manifest,
      recipe,
      workPlan: plan,
      timeReturn: entry,
      observedAt,
    });
  };

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
    if (request.method === "GET" && url.pathname === "/projects") {
      const nonce = randomBytes(18).toString("base64");
      response.writeHead(200, {
        ...securityHeaders,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      response.end(personalDashboardHtml.replaceAll("__NONCE__", nonce));
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/challenge") {
      const now = Date.now();
      for (const [nonce, expiresAt] of readChallenges) {
        if (expiresAt < now) readChallenges.delete(nonce);
      }
      if (readChallenges.size >= 1_000) {
        json(response, 429, { error: "too_many_auth_challenges" });
        return;
      }
      const nonce = randomBytes(32).toString("base64url");
      readChallenges.set(nonce, now + 30_000);
      json(response, 200, { nonce, expiresAt: new Date(now + 30_000).toISOString() });
      return;
    }
    if (!bearerAuthorized(request) && !challengeAuthorized(request, url)) {
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
      if (request.method === "GET" && url.pathname === "/api/recipes") {
        const recipes = await recipeLoader(config.recipesDirectory);
        json(response, 200, { items: [...recipes.values()] });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/projects") {
        const [projects, recipes, plans, memories, timeReturns] = await Promise.all([
          manifestLoader(config.projectsDirectory),
          recipeLoader(config.recipesDirectory),
          store.listWorkPlans({ limit: 1_000 }),
          store.listMemories({ statuses: ["proposed", "confirmed"], limit: 1_000 }),
          store.listTimeReturns({ limit: 1_000 }),
        ]);
        const planSteps = new Map(await Promise.all(plans.map(async (plan) => [
          plan.id,
          await (store.listWorkPlanSteps?.(plan.id) ?? Promise.resolve([])),
        ])));
        const dashboardNow = new Date();
        const graphByProject = new Map(await Promise.all(
          [...projects.values()].map(async (manifest) => {
            if (!store.listGraphNodes || !store.listGraphEdges) {
              return [manifest.projectId, null];
            }
            const scope = {
              tenantId: config.tenantId,
              projectId: manifest.projectId,
              limit: 500,
            };
            const [nodes, edges] = await Promise.all([
              store.listGraphNodes(scope),
              store.listGraphEdges(scope),
            ]);
            return [manifest.projectId, {
              tenantId: config.tenantId,
              nodes,
              edges,
              now: dashboardNow,
            }];
          }),
        ));
        const memorySyncByProject = new Map(await Promise.all(
          [...projects.values()].map(async (manifest) => [
            manifest.projectId,
            projectMemorySyncState(await store.getCheckpoint?.(
              `project-memory-sync:${manifest.projectId}:status`,
            )),
          ]),
        ));
        json(response, 200, {
          items: [...projects.values()].map((manifest) => buildProjectDashboard({
            manifest,
            plans,
            memories,
            timeReturns,
            recipes: [...recipes.values()],
            planSteps,
            graph: graphByProject.get(manifest.projectId),
            memorySyncState: memorySyncByProject.get(manifest.projectId),
            now: dashboardNow,
          })),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/time-returns") {
        json(response, 200, {
          items: await store.listTimeReturns({
            projectId: url.searchParams.get("projectId") || null,
            status: url.searchParams.get("status") || null,
            limit: 1_000,
          }),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/triggers") {
        const projectId = url.searchParams.get("projectId") || null;
        const items = await store.listWorkTriggers({ projectId });
        json(response, 200, { items: items.map((trigger) => ({
          id: trigger.id,
          projectId: trigger.projectId,
          recipeId: trigger.recipeId,
          recipeVersion: trigger.recipeVersion,
          kind: trigger.kind,
          status: trigger.status,
          schedule: trigger.kind === "schedule" ? trigger.schedule : null,
          eventType: trigger.kind === "event" ? trigger.event.type : null,
          maxRunsPerDay: trigger.maxRunsPerDay,
          cooldownMinutes: trigger.cooldownMinutes,
          nextRunAt: trigger.nextRunAt,
          lastRunAt: trigger.lastRunAt,
        })) });
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
        const [health, reviews, tasks] = await Promise.all([
          evaluateHealth({
            store,
            config,
            includeOperationalMetrics: true,
          }),
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
        const coverage = evaluateDecisionReviewCoverage(tasks, reviews, {
          targetGroupIds: config.targetGroupIds,
          minimumSamples: config.shadowMinimumSamples,
        });
        quality.gates.coverage = coverage.accepted;
        quality.accepted = Object.values(quality.gates).every(Boolean);
        const operationalMetrics = health.checks.operationalMetrics;
        json(response, 200, {
          ...operationalMetrics,
          businessAcceptance: evaluateBusinessAcceptance({ health, quality }),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/memories") {
        const status = url.searchParams.get("status") || undefined;
        const items = await store.listMemories({ status, limit: 100 });
        const sourceTaskIds = [...new Set(items
          .filter((memory) =>
            memory.source_type === "dingtalk_message" && memory.source_version)
          .map((memory) => memory.source_version))];
        const sourceTasks = new Map(await Promise.all(sourceTaskIds.map(async (id) => {
          try {
            return [id, await store.getTask(id)];
          } catch {
            return [id, null];
          }
        })));
        const conflictReport = await store.memoryConflictMetrics();
        const conflicts = new Map(
          conflictReport.items.map((item) => [item.memoryId, item]),
        );
        const memoriesById = new Map(items.map((memory) => [memory.id, memory]));
        const referencedMemoryIds = [...new Set(items.flatMap((memory) => {
          const conflict = conflicts.get(memory.id);
          return conflict
            ? [...conflict.conflictIds, ...conflict.duplicateIds]
            : [];
        }))].filter((id) => !memoriesById.has(id));
        const referencedMemories = [];
        if (typeof store.getMemory === "function") {
          referencedMemories.push(...await Promise.all(
            referencedMemoryIds.map((id) => store.getMemory(id)),
          ));
          for (const memory of referencedMemories) {
            if (memory) memoriesById.set(memory.id, memory);
          }
        }
        json(response, 200, {
          items: items.map((memory) => {
            const conflict = conflicts.get(memory.id) ?? null;
            return {
              ...memorySummary(
              memory,
              memorySourceEvidence(memory, sourceTasks),
              ),
              conflict: conflict
                ? {
                    ...conflict,
                    conflicts: conflict.conflictIds.flatMap((id) => {
                      const existing = memoriesById.get(id);
                      return existing ? [memorySummary(existing)] : [];
                    }),
                    duplicates: conflict.duplicateIds.flatMap((id) => {
                      const existing = memoriesById.get(id);
                      return existing ? [memorySummary(existing)] : [];
                    }),
                  }
                : null,
            };
          }),
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
      if (request.method === "GET" && url.pathname === "/api/targets") {
        json(response, 200, await targetSnapshot(config, store));
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
          minimumReplyAccuracy: config.shadowMinimumReplyAccuracy,
          minimumNoReplyAccuracy: config.shadowMinimumNoReplyAccuracy,
          minimumDraftSamples: config.shadowMinimumDraftSamples,
          minimumDraftUsability: config.shadowMinimumDraftUsability,
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
          disagreementReasons: summarizeDecisionDisagreementReasons(reviews),
          queue: queue.map(({ task, existingReview, priority, priorityReasons, selectionKind }) => ({
            ...taskSummary(task, existingReview),
            reviewContent: String(task.payload?.content ?? "").slice(0, 4_000),
            priority,
            priorityReasons,
            selectionKind,
          })),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/privacy/preview") {
        const selector = await readJson(request, 4_096);
        try {
          validatePrivacySelector(selector);
        } catch {
          throw Object.assign(new Error("privacy_selector_invalid"), { status: 400 });
        }
        json(
          response,
          200,
          privacyPreviewSummary(await store.previewPrivacyErasure(selector)),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/projects/onboarding") {
        const body = await readJson(request, 128 * 1024);
        const recipes = await recipeLoader(config.recipesDirectory);
        const draft = await buildProjectOnboardingDraft({
          projectId: body.projectId,
          name: body.name,
          rootDirectory: body.rootDirectory,
          requesterIds: body.requesterIds,
          profile: body.profile,
        });
        if (draft.manifest.profile.selectedRecipeIds.some((id) => !recipes.has(id))) {
          throw Object.assign(new Error("selected_recipe_not_found"), { status: 400 });
        }
        const existing = await manifestLoader(config.projectsDirectory);
        if (existing.has(draft.manifest.projectId)) {
          throw Object.assign(new Error("project_already_exists"), { status: 409 });
        }
        await mkdir(config.projectsDirectory, { recursive: true, mode: 0o700 });
        await writeFile(
          join(config.projectsDirectory, `${draft.manifest.projectId}.json`),
          `${JSON.stringify(draft.manifest, null, 2)}\n`,
          { mode: 0o600, flag: "wx" },
        );
        json(response, 201, {
          projectId: draft.manifest.projectId,
          checklist: draft.checklist,
          externalSideEffectsEnabled: false,
        });
        return;
      }
      const recipeInstantiation = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/recipes\/([^/]+)\/instantiate$/u,
      );
      if (request.method === "POST" && recipeInstantiation) {
        const body = await readJson(request, 128 * 1024);
        const projectId = decodeURIComponent(recipeInstantiation[1]);
        const recipeId = decodeURIComponent(recipeInstantiation[2]);
        const [projects, recipes] = await Promise.all([
          manifestLoader(config.projectsDirectory),
          recipeLoader(config.recipesDirectory),
        ]);
        const manifest = projects.get(projectId);
        const recipe = recipes.get(recipeId);
        if (!manifest || !recipe) {
          throw Object.assign(new Error("project_or_recipe_not_found"), { status: 404 });
        }
        if (!(manifest.profile?.selectedRecipeIds ?? []).includes(recipeId)) {
          throw Object.assign(new Error("recipe_not_selected_for_project"), { status: 403 });
        }
        const requestedRequester = String(body.requesterId ?? "").trim();
        const requesterId = manifest.requesters.length === 1
          ? manifest.requesters[0]
          : requestedRequester;
        if (!requesterId || !manifest.requesters.includes(requesterId)) {
          throw Object.assign(new Error("requester_not_authorized"), { status: 403 });
        }
        const instantiated = instantiateWorkRecipe(recipe, {
          projectId,
          requesterId,
          projectRoot: manifest.rootDirectory,
          values: body.values ?? {},
        });
        const assessment = assessWorkPlan({ manifest, plan: instantiated.plan });
        if (!["ALLOW", "REQUIRE_APPROVAL"].includes(assessment.decision)) {
          throw Object.assign(new Error("recipe_plan_denied_by_policy"), { status: 403 });
        }
        const plan = await store.registerWorkPlan(assessment);
        await captureWorkPlanGraph({
          store,
          tenantId: config.tenantId,
          manifest,
          assessment,
          recipe,
          workPlan: plan,
          observedAt: new Date(),
        });
        json(response, 201, {
          plan: planSummary(plan),
          assessment: { decision: assessment.decision, maxLevel: assessment.maxLevel },
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/time-returns") {
        const body = await readJson(request, 4_096);
        const entry = await store.proposeTimeReturn(
          String(body.workPlanId ?? ""),
          body.humanActiveMinutes,
          "admin-ui",
        );
        await captureTimeReturnGraph(entry);
        json(response, 201, { entry });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/triggers") {
        const body = await readJson(request, 128 * 1024);
        const [projects, recipes] = await Promise.all([
          manifestLoader(config.projectsDirectory),
          recipeLoader(config.recipesDirectory),
        ]);
        const manifest = projects.get(String(body.projectId ?? ""));
        const recipe = recipes.get(String(body.recipeId ?? ""));
        if (!manifest || !recipe) {
          throw Object.assign(new Error("project_or_recipe_not_found"), { status: 404 });
        }
        if (!(manifest.profile?.selectedRecipeIds ?? []).includes(recipe.id)) {
          throw Object.assign(new Error("recipe_not_selected_for_project"), { status: 403 });
        }
        const requesterId = manifest.requesters.length === 1
          ? manifest.requesters[0]
          : String(body.requesterId ?? "").trim();
        if (!manifest.requesters.includes(requesterId)) {
          throw Object.assign(new Error("requester_not_authorized"), { status: 403 });
        }
        let trigger;
        try {
          trigger = validateWorkTrigger({
            ...body,
            version: 1,
            recipeVersion: recipe.version,
            requesterId,
            enabled: false,
          });
        } catch {
          throw Object.assign(new Error("invalid_work_trigger"), { status: 400 });
        }
        const created = await store.createWorkTrigger(trigger, "admin-ui");
        json(response, 201, { id: created.id, status: created.status });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/events") {
        if (!config.capabilities.has("proactive_work")) {
          throw Object.assign(new Error("proactive_work_globally_disabled"), { status: 403 });
        }
        let event;
        try {
          event = validateWorkEvent(await readJson(request, 128 * 1024));
        } catch {
          throw Object.assign(new Error("invalid_work_event"), { status: 400 });
        }
        const [projects, recipes] = await Promise.all([
          manifestLoader(config.projectsDirectory),
          recipeLoader(config.recipesDirectory),
        ]);
        const results = await ingestProactiveEvent({
          store,
          tenantId: config.tenantId,
          manifests: projects,
          recipes,
          event,
          owner: `admin-event:${event.source}`,
        });
        json(response, 202, {
          eventId: event.id,
          results: results.map((result) => ({
            created: result.created,
            triggerId: result.triggerId,
            reason: result.reason ?? null,
            plan: result.plan ? planSummary(result.plan) : null,
          })),
        });
        return;
      }
      const timeReturnDecision = url.pathname.match(
        /^\/api\/time-returns\/([^/]+)\/decision$/u,
      );
      if (request.method === "POST" && timeReturnDecision) {
        const body = await readJson(request, 4_096);
        if (!["confirmed", "rejected"].includes(body.decision)) {
          throw Object.assign(new Error("invalid_decision"), { status: 400 });
        }
        const entry = await store.decideTimeReturn(
          decodeURIComponent(timeReturnDecision[1]),
          body.decision,
          "admin-ui",
        );
        await captureTimeReturnGraph(entry);
        json(response, 200, { entry });
        return;
      }
      const triggerEnable = url.pathname.match(/^\/api\/triggers\/([^/]+)\/enabled$/u);
      if (request.method === "POST" && triggerEnable) {
        const body = await readJson(request, 4_096);
        if (typeof body.enabled !== "boolean") {
          throw Object.assign(new Error("enabled_must_be_boolean"), { status: 400 });
        }
        if (body.enabled && !config.capabilities.has("proactive_work")) {
          throw Object.assign(new Error("proactive_work_globally_disabled"), { status: 403 });
        }
        const updated = await store.setWorkTriggerEnabled(
          decodeURIComponent(triggerEnable[1]), body.enabled, "admin-ui",
        );
        json(response, 200, { id: updated.id, status: updated.status });
        return;
      }
      const targetPause = url.pathname.match(
        /^\/api\/targets\/(user|group)\/([a-f0-9]{16})\/pause$/u,
      );
      if (request.method === "POST" && targetPause) {
        const body = await readJson(request, 4_096);
        if (typeof body.paused !== "boolean") {
          throw Object.assign(new Error("paused_must_be_boolean"), { status: 400 });
        }
        const kind = targetPause[1];
        const fingerprint = targetPause[2];
        const values = kind === "user" ? config.targetUserIds : config.targetGroupIds;
        const value = values.find(
          (candidate) => targetFingerprint(config, kind, candidate) === fingerprint,
        );
        if (!value) {
          throw Object.assign(new Error("target_not_found"), { status: 404 });
        }
        const paused = await store.setScopedPause({
          type: kind === "user" ? "contact" : "group",
          value,
          paused: body.paused,
          actor: "admin-ui",
          reason: String(body.reason ?? ""),
        });
        json(response, 200, { paused });
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
        } else if (paused && type === "group") {
          allowed = (config.targetGroupIds ?? []).includes(value);
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
        const draftApplicable =
          current.result?.shouldReply === true &&
          body.expectedShouldReply === true &&
          String(current.result?.reply ?? "").trim().length > 0;
        if (
          draftApplicable &&
          !equalToken(body.draftSha256, currentSummary.draftSha256)
        ) {
          throw Object.assign(new Error("draft_changed_review_again"), { status: 409 });
        }
        let note;
        try {
          note = createStructuredDecisionReviewNote({
            predictedShouldReply: current.result?.shouldReply,
            expectedShouldReply: body.expectedShouldReply,
            draft: current.result?.reply ?? "",
            responseReasonCode: body.responseReasonCode ?? null,
            draftAssessment: body.draftAssessment ?? null,
            draftReasonCode: body.draftReasonCode ?? null,
            detail: body.detail ?? "",
          });
        } catch {
          throw Object.assign(new Error("invalid_review_metadata"), { status: 400 });
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
        if (body.decision === "confirmed" && body.supersedesId) {
          throw Object.assign(new Error("memory_replacement_requires_explicit_action"), {
            status: 400,
          });
        }
        if (body.decision === "replaced" && !body.supersedesId) {
          throw Object.assign(new Error("memory_replacement_target_required"), {
            status: 400,
          });
        }
        const status = body.decision === "confirmed"
          ? await store.confirmMemory(id, "admin-ui", new Date())
          : body.decision === "replaced"
            ? await store.confirmMemory(id, "admin-ui", new Date(), {
                supersedesId: body.supersedesId,
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
