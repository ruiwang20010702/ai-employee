import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
export const pluginVersion = "0.6.0";
const statusResourceUri = "ui://foursday/status.html";
const allowedAdminPaths = new Set([
  "/api/overview",
  "/api/tasks?status=awaiting_approval",
  "/api/plans",
  "/api/takeover",
  "/api/capabilities",
  "/api/weekly-plan",
]);

const statusPanelHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#17211b;background:transparent}
    body{margin:0;padding:8px}.card{border:1px solid #dce5df;border-radius:16px;padding:16px;background:#fbfdfb}
    .head{display:flex;align-items:center;gap:10px}.dot{width:10px;height:10px;border-radius:50%;background:#d04a3a}.dot.ok{background:#238b57}
    h2{font-size:16px;margin:0}.sub{margin:6px 0 14px;color:#66736b;font-size:13px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
    .metric{border-radius:12px;background:#eef4f0;padding:10px;font-size:12px;color:#66736b}.metric strong{display:block;margin-top:4px;font-size:20px;color:#17211b}
    a{display:inline-block;margin-top:14px;color:#176b46;text-decoration:none;font-weight:600}@media(max-width:420px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body><main class="card"><div class="head"><span id="dot" class="dot"></span><h2 id="title">Foursday 状态</h2></div><p id="sub" class="sub">正在读取…</p><div class="grid"><div class="metric">待审批草稿<strong id="drafts">—</strong></div><div class="metric">等待补充信息<strong id="waiting">—</strong></div><div class="metric">异常任务<strong id="errors">—</strong></div><div class="metric">授权项目<strong id="projects">—</strong></div></div><a href="http://127.0.0.1:9465" target="_blank" rel="noreferrer">打开完整管理台</a></main>
<script>
  let rpcId=0;const pending=new Map();function request(method,params){return new Promise((resolve,reject)=>{const id=++rpcId;pending.set(id,{resolve,reject});window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*')})}function notify(method,params){window.parent.postMessage({jsonrpc:'2.0',method,params},'*')}
  function render(value){if(!value)return;document.getElementById('dot').classList.toggle('ok',Boolean(value.ready));document.getElementById('title').textContent=value.ready?'Foursday 运行正常':'Foursday 需要处理';document.getElementById('sub').textContent=(value.paused?'系统已暂停':'系统运行中')+' · '+(value.sendMode||'发送状态未知');document.getElementById('drafts').textContent=Number(value.taskCounts?.awaiting_approval||0);document.getElementById('waiting').textContent=Number(value.taskCounts?.waiting_information||0);document.getElementById('errors').textContent=Number(value.taskCounts?.dead||0)+Number(value.taskCounts?.send_unknown||0);document.getElementById('projects').textContent=Number(value.projectCount||0)}
  window.addEventListener('message',event=>{if(event.source!==window.parent)return;const message=event.data;if(message?.id!=null&&pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);message.error?item.reject(message.error):item.resolve(message.result);return}if(message?.method==='ui/notifications/tool-result')render(message.params?.structuredContent)});
  request('ui/initialize',{appInfo:{name:'foursday-status',version:'${pluginVersion}'},appCapabilities:{},protocolVersion:'2026-01-26'}).then(()=>notify('ui/notifications/initialized',{})).catch(()=>{document.getElementById('sub').textContent='宿主暂不支持状态卡片，请查看对话中的结构化结果'});
</script></body></html>`;

function stableError(message) {
  return new Error(message, { cause: undefined });
}

export function adminBaseUrl(
  value = process.env.FOURSDAY_ADMIN_URL ?? process.env.AI_EMPLOYEE_ADMIN_URL,
) {
  const url = new URL(value || "http://127.0.0.1:9465");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw stableError("Foursday admin URL must be a local loopback HTTP origin");
  }
  return url.origin;
}

async function keychainReadToken() {
  if (process.platform !== "darwin") {
    throw stableError("Foursday read credential is unavailable on this platform");
  }
  for (const service of ["foursday-production", "ai-employee-production"]) {
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/security",
        ["find-generic-password", "-s", service, "-a", "admin-read-token", "-w"],
        {
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          env: Object.fromEntries(
            ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL"]
              .filter((name) => typeof process.env[name] === "string")
              .map((name) => [name, process.env[name]]),
          ),
        },
      );
      const token = stdout.trim();
      if (token) return token;
    } catch {
      // Try the legacy service so an installed production profile can migrate safely.
    }
  }
  throw stableError("Foursday read credential could not be loaded");
}

export function createAdminReader({
  baseUrl = adminBaseUrl(),
  tokenReader = keychainReadToken,
  request = fetch,
} = {}) {
  return async function readAdmin(path) {
    if (!allowedAdminPaths.has(path)) {
      throw stableError("Unsupported Foursday admin path");
    }
    const token = await tokenReader();
    let challengeResponse;
    try {
      challengeResponse = await request(`${baseUrl}/api/auth/challenge`, {
        method: "POST",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw stableError("Foursday admin service is unavailable");
    }
    if (!challengeResponse.ok) {
      throw stableError("Foursday admin authentication challenge failed");
    }
    let nonce;
    try {
      ({ nonce } = await challengeResponse.json());
    } catch {
      throw stableError("Foursday admin returned invalid authentication data");
    }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce ?? "")) {
      throw stableError("Foursday admin returned invalid authentication data");
    }
    const proof = createHmac("sha256", token)
      .update(`${nonce}\nGET\n${path}`)
      .digest("hex");
    let response;
    try {
      response = await request(`${baseUrl}${path}`, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-foursday-challenge": nonce,
          "x-foursday-proof": proof,
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw stableError("Foursday admin service is unavailable");
    }
    if (!response.ok) {
      if (path === "/api/weekly-plan" && response.status === 404) {
        return {
          available: false,
          reason: "weekly_plan_unavailable",
          items: [],
        };
      }
      throw stableError(response.status === 401
        ? "Foursday read credential was rejected"
        : "Foursday admin request failed");
    }
    try {
      return await response.json();
    } catch {
      throw stableError("Foursday admin returned invalid data");
    }
  };
}

function counts(value) {
  return Object.fromEntries(Object.entries(value ?? {}).flatMap(([key, count]) =>
    Number.isSafeInteger(count) && count >= 0 ? [[key, count]] : []));
}

function projectStatus(value) {
  const healthChecks = value.checks && typeof value.checks === "object"
    ? value.checks
    : {};
  return {
    ready: Boolean(value.ready),
    runtime: value.runtime && typeof value.runtime === "object" ? {
      ready: Boolean(value.runtime.ready),
      splitBrain: Boolean(value.runtime.splitBrain),
      current: value.runtime.current ? {
        runtime: String(value.runtime.current.runtime ?? "unknown").slice(0, 80),
        label: String(value.runtime.current.label ?? "").slice(0, 100),
        mode: String(value.runtime.current.mode ?? "unknown").slice(0, 20),
        sendEnabled: Boolean(value.runtime.current.sendEnabled),
      } : null,
      native: {
        installed: Boolean(value.runtime.native?.installed),
        running: Boolean(value.runtime.native?.running),
        mode: String(value.runtime.native?.mode ?? "unknown").slice(0, 20),
      },
      managed: {
        installed: Boolean(value.runtime.managed?.installed),
        running: Boolean(value.runtime.managed?.running),
        mode: String(value.runtime.managed?.mode ?? "unknown").slice(0, 20),
      },
    } : null,
    paused: Boolean(value.paused),
    sendMode: String(value.sendMode ?? "状态未知").slice(0, 80),
    taskCounts: counts(value.taskCounts),
    planCounts: counts(value.planCounts),
    confirmedMemoryCount: Number(value.confirmedMemoryCount ?? 0),
    projectCount: Number(value.projectCount ?? 0),
    checks: {
      database: Boolean(healthChecks.database),
      dwsExecutable: Boolean(healthChecks.dwsExecutable),
      codexExecutable: Boolean(healthChecks.codexExecutable),
      deadTasks: Number(healthChecks.deadTasks ?? 0),
      unknownSends: Number(healthChecks.unknownSends ?? 0),
      expiredExecutionLeases: Number(healthChecks.expiredExecutionLeases ?? 0),
      heartbeats: Object.fromEntries(
        Object.entries(healthChecks.heartbeats ?? {}).map(([name, status]) => [
          String(name).slice(0, 80),
          Boolean(status?.healthy),
        ]),
      ),
      operationalChecks: Object.fromEntries(
        Object.entries(healthChecks.operationalChecks ?? {}).map(([name, status]) => [
          String(name).slice(0, 100),
          Boolean(status?.healthy),
        ]),
      ),
      messageCoverage: {
        required: Boolean(healthChecks.messageCoverage?.required),
        healthy: Boolean(healthChecks.messageCoverage?.healthy),
      },
    },
  };
}

function draftItems(value) {
  return (Array.isArray(value.items) ? value.items : []).slice(0, 20).map((item) => ({
    id: String(item.id ?? "").slice(0, 100),
    senderName: item.senderName == null ? null : String(item.senderName).slice(0, 100),
    originalMessage: String(item.contentPreview ?? "").slice(0, 180),
    draft: String(item.draft ?? "").slice(0, 4_000),
    riskLevel: String(item.riskLevel ?? "unknown").slice(0, 20),
    reason: String(item.reason ?? "").slice(0, 500),
    updatedAt: item.updatedAt ?? null,
  }));
}

function planItems(value) {
  return (Array.isArray(value.items) ? value.items : []).slice(0, 30).map((item) => ({
    id: String(item.id ?? "").slice(0, 100),
    projectId: String(item.projectId ?? "").slice(0, 100),
    objective: String(item.objective ?? "").slice(0, 1_000),
    status: String(item.status ?? "unknown").slice(0, 40),
    maxLevel: String(item.maxLevel ?? "").slice(0, 10),
    steps: (Array.isArray(item.steps) ? item.steps : []).slice(0, 30).map((step) => ({
      id: String(step.id ?? "").slice(0, 100),
      capability: String(step.capability ?? "").slice(0, 100),
      description: String(step.description ?? "").slice(0, 500),
      execution: step.execution == null ? null : {
        status: String(step.execution.status ?? "unknown").slice(0, 40),
        verification: step.execution.verification ?? null,
        error: step.execution.error ?? null,
      },
    })),
    updatedAt: item.updatedAt ?? null,
  }));
}

function takeoverItems(value) {
  return (Array.isArray(value.items) ? value.items : []).slice(0, 30).map((item) => ({
    id: String(item.id ?? "").slice(0, 100),
    projectId: String(item.projectId ?? "").slice(0, 100),
    objective: String(item.objective ?? "").slice(0, 1_000),
    status: String(item.status ?? "unknown").slice(0, 40),
    takeover: {
      state: String(item.takeover?.state ?? "unknown").slice(0, 40),
      stateLabel: String(item.takeover?.stateLabel ?? "").slice(0, 100),
      handoffAction: String(item.takeover?.handoffAction ?? "").slice(0, 500),
      currentStep: item.takeover?.currentStep == null ? null : {
        id: String(item.takeover.currentStep.id ?? "").slice(0, 100),
        capability: String(item.takeover.currentStep.capability ?? "").slice(0, 100),
        status: String(item.takeover.currentStep.status ?? "").slice(0, 40),
        verification: item.takeover.currentStep.verification ?? null,
      },
    },
    updatedAt: item.updatedAt ?? null,
  }));
}

function capabilityItems(value) {
  return {
    global: (Array.isArray(value.global) ? value.global : []).map((item) => ({
      name: String(item.name ?? "").slice(0, 100),
      enabled: Boolean(item.enabled),
    })),
    projects: (Array.isArray(value.projects) ? value.projects : []).slice(0, 50).map((project) => ({
      name: String(project.name ?? "").slice(0, 100),
      capabilities: (Array.isArray(project.capabilities) ? project.capabilities : []).map((item) => ({
        name: String(item.name ?? "").slice(0, 100),
        level: String(item.level ?? "").slice(0, 10),
        mode: String(item.mode ?? "").slice(0, 40),
        available: Boolean(item.available),
        expiresAt: item.expiresAt ?? null,
      })),
    })),
  };
}

function safeMinute(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 10_080
    ? number
    : 0;
}

function validAggregateMinute(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;
}

function safeIso(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeList(value, limit = 30) {
  return (Array.isArray(value) ? value : [])
    .slice(0, limit)
    .map((item) => String(item ?? "").slice(0, 100));
}

function weeklyPlan(value) {
  if (value?.available === false && value?.reason === "weekly_plan_unavailable") {
    return {
      available: false,
      reason: "weekly_plan_unavailable",
      items: [],
    };
  }
  const weekly = value;
  const weekStart = safeIso(weekly?.weekStart);
  const weekEnd = safeIso(weekly?.weekEnd);
  const valid = weekly && typeof weekly === "object" && !Array.isArray(weekly) &&
    weekStart && weekEnd && new Date(weekStart) < new Date(weekEnd) &&
    validAggregateMinute(weekly.weeklyTargetMinutes) &&
    validAggregateMinute(weekly.weeklyReturnedMinutes) &&
    validAggregateMinute(weekly.remainingMinutes) &&
    validAggregateMinute(weekly.projectedVerifiedReturnedMinutes) &&
    validAggregateMinute(weekly.remainingAfterVerifiedQueueMinutes) &&
    weekly.remainingMinutes === Math.max(
      0,
      weekly.weeklyTargetMinutes - weekly.weeklyReturnedMinutes,
    ) &&
    weekly.remainingAfterVerifiedQueueMinutes <= weekly.remainingMinutes &&
    weekly.targetMet === (weekly.remainingMinutes === 0) &&
    typeof weekly.executionEnabled === "boolean" &&
    weekly.evidenceBoundary === "confirmed_recipe_outcomes_only" &&
    weekly.recommendationBoundary === "planning_only_no_execution" &&
    Array.isArray(weekly.items) && Array.isArray(weekly.inProgress) &&
    Array.isArray(weekly.blocked);
  if (!valid) {
    return {
      available: false,
      reason: "weekly_plan_unavailable",
      items: [],
    };
  }
  const allowedEvidenceStatuses = new Set(["verified_history", "needs_validation"]);
  const allowedExecutionPaths = new Set([
    "global_execution_disabled",
    "approval_required_after_instantiation",
    "project_policy_after_instantiation",
  ]);
  const items = (Array.isArray(weekly.items) ? weekly.items : []).slice(0, 8).map((item) => ({
    projectId: String(item.projectId ?? "").slice(0, 100),
    projectName: String(item.projectName ?? "").slice(0, 100),
    recipeId: String(item.recipeId ?? "").slice(0, 100),
    recipeName: String(item.recipeName ?? "").slice(0, 100),
    requiredInputs: safeList(item.requiredInputs),
    requiredCapabilities: safeList(item.requiredCapabilities),
    approvalRequired: Boolean(item.approvalRequired),
    executionPath: allowedExecutionPaths.has(item.executionPath)
      ? item.executionPath
      : "unavailable",
    evidenceStatus: allowedEvidenceStatuses.has(item.evidenceStatus)
      ? item.evidenceStatus
      : "unavailable",
    evidenceSamples: safeMinute(item.evidenceSamples),
    conservativeReturnedMinutes: item.conservativeReturnedMinutes == null
      ? null
      : safeMinute(item.conservativeReturnedMinutes),
  }));
  return {
    available: true,
    weekStart,
    weekEnd,
    weeklyTargetMinutes: weekly.weeklyTargetMinutes,
    weeklyReturnedMinutes: weekly.weeklyReturnedMinutes,
    remainingMinutes: weekly.remainingMinutes,
    targetMet: weekly.targetMet,
    executionEnabled: weekly.executionEnabled,
    projectedVerifiedReturnedMinutes: weekly.projectedVerifiedReturnedMinutes,
    remainingAfterVerifiedQueueMinutes: weekly.remainingAfterVerifiedQueueMinutes,
    evidenceBoundary: weekly.evidenceBoundary,
    recommendationBoundary: weekly.recommendationBoundary,
    inProgressCount: Array.isArray(weekly.inProgress) ? weekly.inProgress.length : 0,
    blockedCount: Array.isArray(weekly.blocked) ? weekly.blocked.length : 0,
    items,
  };
}

const toolDefinitions = Object.freeze([
  { name: "get_status", title: "查看 Foursday 状态", description: "读取本机 Foursday 当前健康、暂停状态和待处理数量。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "show_status_panel", title: "显示 Foursday 状态卡片", description: "读取当前状态并以内嵌卡片呈现；宿主不支持组件时仍返回结构化结果。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false }, _meta: { ui: { resourceUri: statusResourceUri }, "openai/outputTemplate": statusResourceUri } },
  { name: "list_pending_drafts", title: "查看待审批回复", description: "仅在用户明确要求审核回复时，读取最多 20 条待审批原消息、建议草稿、风险和原因。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "list_work_plans", title: "查看工作计划", description: "读取最多 30 个近期工作计划和步骤状态，不执行计划。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "list_takeovers", title: "查看人工接管状态", description: "读取需要人工核对、停止或接管的计划状态和当前证据。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "list_capabilities", title: "查看授权能力", description: "读取当前全局开关和项目能力配置；配置不等于执行结果。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "get_weekly_plan", title: "查看本周工作返还计划", description: "按本人确认的历史结果读取本周剩余目标和最多 8 条受控委托建议；只规划，不创建或执行计划。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "open_admin_console", title: "打开 Foursday 管理台", description: "返回本机完整管理台入口，用于人工审批、暂停和深度核对。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
]);

function toolResult(structuredContent, summary) {
  return {
    structuredContent,
    content: [{ type: "text", text: summary }],
  };
}

export function createMcpHandler({ readAdmin = createAdminReader() } = {}) {
  return async function handle(message) {
    if (message.method === "initialize") {
      return {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: "foursday", version: pluginVersion },
        instructions: "只读查看本机 Foursday。审批、发送、执行和权限变更必须进入管理台并遵守原有门禁。",
      };
    }
    if (message.method === "ping") return {};
    if (message.method === "tools/list") return { tools: toolDefinitions };
    if (message.method === "resources/list") {
      return { resources: [{ uri: statusResourceUri, name: "Foursday 状态卡片", mimeType: "text/html;profile=mcp-app" }] };
    }
    if (message.method === "resources/read") {
      if (message.params?.uri !== statusResourceUri) throw Object.assign(stableError("Resource not found"), { code: -32002 });
      return { contents: [{ uri: statusResourceUri, mimeType: "text/html;profile=mcp-app", text: statusPanelHtml, _meta: { ui: { prefersBorder: false } } }] };
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (Object.keys(args).length !== 0) throw Object.assign(stableError("This tool does not accept arguments"), { code: -32602 });
      if (name === "get_status" || name === "show_status_panel") {
        const result = projectStatus(await readAdmin("/api/overview"));
        return toolResult(result, result.ready ? "Foursday 当前就绪。" : "Foursday 当前需要处理，请检查返回状态。");
      }
      if (name === "list_pending_drafts") {
        const items = draftItems(await readAdmin("/api/tasks?status=awaiting_approval"));
        return toolResult({ items, count: items.length }, `当前返回 ${items.length} 条待审批回复。`);
      }
      if (name === "list_work_plans") {
        const items = planItems(await readAdmin("/api/plans"));
        return toolResult({ items, count: items.length }, `当前返回 ${items.length} 个工作计划。`);
      }
      if (name === "list_takeovers") {
        const items = takeoverItems(await readAdmin("/api/takeover"));
        return toolResult({ items, count: items.length }, `当前返回 ${items.length} 个接管状态。`);
      }
      if (name === "list_capabilities") {
        const result = capabilityItems(await readAdmin("/api/capabilities"));
        return toolResult(result, `当前返回 ${result.projects.length} 个项目的能力配置。`);
      }
      if (name === "get_weekly_plan") {
        const result = weeklyPlan(await readAdmin("/api/weekly-plan"));
        if (!result.available) {
          return toolResult(
            result,
            "本机 Foursday 服务尚未提供本周工作返还计划；请先升级服务并重新核验，只规划，不执行。",
          );
        }
        return toolResult(
          result,
          result.targetMet
            ? `本周已返还 ${result.weeklyReturnedMinutes} 分钟，目标已完成；只规划，不执行。`
            : `本周已返还 ${result.weeklyReturnedMinutes} 分钟，还差 ${result.remainingMinutes} 分钟，返回 ${result.items.length} 条建议；只规划，不执行。`,
        );
      }
      if (name === "open_admin_console") {
        return {
          structuredContent: { url: `${adminBaseUrl()}/`, localOnly: true },
          content: [
            { type: "text", text: "完整管理台仅限本机访问；审批和变更仍需管理读写令牌。" },
            { type: "resource_link", uri: `${adminBaseUrl()}/`, name: "打开 Foursday 管理台", mimeType: "text/html" },
          ],
        };
      }
      throw Object.assign(stableError("Tool not found"), { code: -32601 });
    }
    throw Object.assign(stableError("Method not found"), { code: -32601 });
  };
}

export async function runStdioServer({ input = process.stdin, output = process.stdout, handler = createMcpHandler() } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      continue;
    }
    if (message.id == null) continue;
    try {
      const result = await handler(message);
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    } catch (error) {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: Number.isInteger(error.code) ? error.code : -32000, message: error.message || "Foursday request failed" } })}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStdioServer();
}
