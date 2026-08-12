import { isAbsolute, relative, resolve } from "node:path";
import { validateProjectProfile } from "./project-profile.mjs";
import { containsCredentialMaterial } from "./memory-candidate.mjs";

const levels = ["L0", "L1", "L2", "L3", "L4"];
const modes = new Set(["automatic", "approval_required", "disabled"]);
const commandCapabilities = new Set(["local_test", "production_deploy"]);
const todoPriorities = new Set(["10", "20", "30", "40"]);
const recurrenceTypes = new Set(["daily", "weekly"]);
const weekdays = new Set([
  "sunday", "monday", "tuesday", "wednesday",
  "thursday", "friday", "saturday",
]);

export const capabilityCatalog = Object.freeze({
  observe_messages: { level: "L0", sideEffect: false, runtime: "dws", probe: ["chat", "message", "list-by-sender"] },
  knowledge_read: { level: "L1", sideEffect: false, interruptible: true, runtime: "gbrain" },
  research: { level: "L1", sideEffect: false, interruptible: true, runtime: "codex" },
  work_plan_proposal: { level: "L1", sideEffect: false, runtime: "codex" },
  reply_draft: { level: "L1", sideEffect: false, runtime: "builtin" },
  document_draft: { level: "L1", sideEffect: false, interruptible: true, runtime: "codex" },
  project_memory_proposal: { level: "L2", sideEffect: true, runtime: "builtin" },
  code_patch: { level: "L1", sideEffect: false, interruptible: true, requiresProjectRoot: true, runtime: "codex" },
  local_test: { level: "L2", sideEffect: true, interruptible: true, requiresProjectRoot: true, runtime: "commands" },
  local_branch: { level: "L2", sideEffect: true, requiresProjectRoot: true, runtime: "git" },
  dingtalk_send: { level: "L3", sideEffect: true, runtime: "dws", probe: ["chat", "message", "send"] },
  shared_document_write: { level: "L3", sideEffect: true, runtime: "dws", probe: ["doc", "create"] },
  dingtalk_todo_create: { level: "L3", sideEffect: true, runtime: "dws", probe: ["todo", "task", "create"] },
  dingtalk_calendar_create: { level: "L3", sideEffect: true, runtime: "dws", probe: ["calendar", "event", "create"] },
  dingtalk_report_submit: { level: "L3", sideEffect: true, runtime: "dws", probe: ["report", "entry", "submit"] },
  git_push: { level: "L3", sideEffect: true, requiresProjectRoot: true, runtime: "git" },
  github_pr_draft: { level: "L3", sideEffect: true, requiresProjectRoot: true, runtime: "gh" },
  production_deploy: { level: "L4", sideEffect: true, requiresProjectRoot: true, runtime: "commands" },
  production_data_change: {
    level: "L4",
    sideEffect: true,
    requiresProjectRoot: true,
    runtime: null,
  },
});

export const prohibitedCapabilities = new Set([
  "payment",
  "contract_signature",
  "personnel_decision",
  "permission_bypass",
  "hide_ai_identity",
  "secret_exfiltration",
  "dingtalk_approval_decision",
]);

function assertString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function withinRoot(root, target) {
  const difference = relative(resolve(root), resolve(target));
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

function normalizedStringSet(value, name, { min = 0, max = 30 } = {}) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const normalized = [...new Set(value.map((item) => assertString(item, name)))];
  if (normalized.length < min || normalized.length > max) {
    throw new Error(`${name} must contain ${min}-${max} unique values`);
  }
  return normalized;
}

function boundedInteger(value, name, fallback, maximum) {
  const normalized = Number(value ?? fallback);
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > maximum) {
    throw new Error(`${name} must be a positive integer <= ${maximum}`);
  }
  return normalized;
}

function normalizedReportFields(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) {
    throw new Error("dingtalk_report_submit.fields must contain 1-30 fields");
  }
  const names = new Set();
  const sorts = new Set();
  return value.map((field, index) => {
    if (!field || Array.isArray(field) || typeof field !== "object") {
      throw new Error(`dingtalk_report_submit.fields[${index}] must be an object`);
    }
    const name = assertString(
      field.name,
      `dingtalk_report_submit.fields[${index}].name`,
    );
    const sort = assertString(
      String(field.sort ?? ""),
      `dingtalk_report_submit.fields[${index}].sort`,
    );
    const type = assertString(
      String(field.type ?? ""),
      `dingtalk_report_submit.fields[${index}].type`,
    );
    if (names.has(name) || sorts.has(sort)) {
      throw new Error("dingtalk_report_submit field names and sorts must be unique");
    }
    if (!["1", "2", "3", "5", "7"].includes(type)) {
      throw new Error(`dingtalk_report_submit field type is unsupported: ${type}`);
    }
    names.add(name);
    sorts.add(sort);
    return { name, sort, type };
  });
}

function onlyInputKeys(inputs, allowed) {
  if (!inputs || Array.isArray(inputs) || typeof inputs !== "object") return false;
  return Object.keys(inputs).every((key) => allowed.has(key));
}

function validateCommands(capability, commands) {
  if (commands == null) return {};
  if (!commandCapabilities.has(capability)) {
    throw new Error(`Commands are not supported for capability: ${capability}`);
  }
  if (!commands || Array.isArray(commands) || typeof commands !== "object") {
    throw new Error(`commands must be an object: ${capability}`);
  }
  const normalized = {};
  for (const [rawId, rawCommand] of Object.entries(commands)) {
    const id = assertString(rawId, `${capability}.commands id`);
    if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(id)) {
      throw new Error(`Invalid command id: ${capability}.${id}`);
    }
    if (!rawCommand || Array.isArray(rawCommand) || typeof rawCommand !== "object") {
      throw new Error(`Command must be an object: ${capability}.${id}`);
    }
    const executable = assertString(
      rawCommand.executable,
      `${capability}.${id}.executable`,
    );
    if (!isAbsolute(executable)) {
      throw new Error(`Command executable must be absolute: ${capability}.${id}`);
    }
    const args = rawCommand.args ?? [];
    if (
      !Array.isArray(args) ||
      args.length > 100 ||
      args.some((value) => typeof value !== "string" || value.length > 4096)
    ) {
      throw new Error(`Command args are invalid: ${capability}.${id}`);
    }
    const timeoutMs = Number(rawCommand.timeoutMs ?? 600_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) {
      throw new Error(`Command timeout is invalid: ${capability}.${id}`);
    }
    const maxOutputBytes = Number(rawCommand.maxOutputBytes ?? 1_048_576);
    if (
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes <= 0 ||
      maxOutputBytes > 16 * 1024 * 1024
    ) {
      throw new Error(`Command output limit is invalid: ${capability}.${id}`);
    }
    normalized[id] = {
      executable,
      args: [...args],
      timeoutMs,
      maxOutputBytes,
    };
  }
  return normalized;
}

export function validateProjectManifest(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error("Project manifest must be an object");
  }
  if (input.version !== 1) throw new Error("Project manifest version must be 1");
  const projectId = assertString(input.projectId, "projectId");
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/u.test(projectId)) {
    throw new Error("projectId must use lowercase letters, numbers, _ or -");
  }
  const name = assertString(input.name, "name");
  const rootDirectory = assertString(input.rootDirectory, "rootDirectory");
  if (!isAbsolute(rootDirectory)) {
    throw new Error("rootDirectory must be an absolute path");
  }
  const requesters = [...new Set(input.requesters ?? [])];
  if (requesters.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error("requesters must contain non-empty strings");
  }
  if (!input.capabilities || Array.isArray(input.capabilities)) {
    throw new Error("capabilities must be an object");
  }
  const capabilities = {};
  for (const [name, rule] of Object.entries(input.capabilities)) {
    if (!capabilityCatalog[name]) throw new Error(`Unknown capability: ${name}`);
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`Capability rule must be an object: ${name}`);
    }
    const mode = rule.mode ?? "disabled";
    if (!modes.has(mode)) throw new Error(`Invalid mode for capability: ${name}`);
    const expiresAt = rule.expiresAt ? new Date(rule.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new Error(`Invalid expiresAt for capability: ${name}`);
    }
    capabilities[name] = {
      mode,
      expiresAt: expiresAt?.toISOString() ?? null,
      maxRuns: rule.maxRuns == null ? null : Number(rule.maxRuns),
      timeoutMs: rule.timeoutMs == null ? null : Number(rule.timeoutMs),
    };
    if (commandCapabilities.has(name) || rule.commands != null) {
      capabilities[name].commands = validateCommands(name, rule.commands);
    }
    if (
      name === "knowledge_read" &&
      (mode !== "disabled" || rule.allowedSlugPrefixes != null)
    ) {
      const prefixes = normalizedStringSet(
        rule.allowedSlugPrefixes,
        "knowledge_read.allowedSlugPrefixes",
        { min: 1, max: 20 },
      );
      if (prefixes.some((prefix) => (
        prefix.length > 200 ||
        !prefix.endsWith("/") ||
        prefix.startsWith("/") ||
        prefix.includes("//") ||
        prefix.split("/").includes("..") ||
        !/^[\p{L}\p{N}._/-]+$/u.test(prefix)
      ))) {
        throw new Error(
          "knowledge_read.allowedSlugPrefixes must be safe directory prefixes ending in /",
        );
      }
      capabilities[name].allowedSlugPrefixes = prefixes;
      capabilities[name].maxPages = boundedInteger(
        rule.maxPages,
        "knowledge_read.maxPages",
        5,
        10,
      );
      capabilities[name].maxContentBytes = boundedInteger(
        rule.maxContentBytes,
        "knowledge_read.maxContentBytes",
        64 * 1024,
        256 * 1024,
      );
    }
    if (
      name === "git_push" &&
      (mode !== "disabled" ||
        rule.remote != null ||
        rule.expectedRemoteUrl != null ||
        rule.branchPrefix != null)
    ) {
      const remote = assertString(rule.remote, "git_push.remote");
      if (!/^[a-zA-Z0-9._-]{1,64}$/u.test(remote)) {
        throw new Error("git_push.remote is invalid");
      }
      const expectedRemoteUrl = assertString(
        rule.expectedRemoteUrl,
        "git_push.expectedRemoteUrl",
      );
      if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(expectedRemoteUrl)) {
        const parsed = new URL(expectedRemoteUrl);
        if (parsed.username || parsed.password) {
          throw new Error("git_push.expectedRemoteUrl must not contain credentials");
        }
      }
      const branchPrefix = assertString(
        rule.branchPrefix ?? "foursday/",
        "git_push.branchPrefix",
      );
      if (
        !["foursday/", "ai-employee/"].some((prefix) =>
          branchPrefix.startsWith(prefix)
        ) ||
        branchPrefix.length > 80
      ) {
        throw new Error(
          "git_push.branchPrefix must remain under foursday/ (legacy ai-employee/ is accepted during 0.x)",
        );
      }
      capabilities[name].remote = remote;
      capabilities[name].expectedRemoteUrl = expectedRemoteUrl;
      capabilities[name].branchPrefix = branchPrefix;
    }
    if (
      name === "github_pr_draft" &&
      (mode !== "disabled" || rule.repository != null || rule.baseBranches != null)
    ) {
      const repository = assertString(rule.repository, "github_pr_draft.repository");
      if (!/^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/iu.test(repository)) {
        throw new Error("github_pr_draft.repository is invalid");
      }
      const headRepository = assertString(
        rule.headRepository ?? repository,
        "github_pr_draft.headRepository",
      );
      if (!/^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/iu.test(headRepository)) {
        throw new Error("github_pr_draft.headRepository is invalid");
      }
      const baseBranches = normalizedStringSet(
        rule.baseBranches,
        "github_pr_draft.baseBranches",
        { min: 1, max: 10 },
      );
      if (baseBranches.some((branch) => (
        branch.length > 200 || branch.startsWith("-") || branch.includes("..") || /[\s~^:?*\[\\]/u.test(branch)
      ))) {
        throw new Error("github_pr_draft.baseBranches is invalid");
      }
      capabilities[name].repository = repository;
      capabilities[name].headRepository = headRepository;
      capabilities[name].baseBranches = baseBranches;
      capabilities[name].maxTitleChars = boundedInteger(
        rule.maxTitleChars,
        "github_pr_draft.maxTitleChars",
        120,
        200,
      );
      capabilities[name].maxBodyBytes = boundedInteger(
        rule.maxBodyBytes,
        "github_pr_draft.maxBodyBytes",
        64 * 1024,
        256 * 1024,
      );
    }
    if (
      name === "project_memory_proposal" &&
      (mode !== "disabled" || rule.allowedFactKeyPrefixes != null)
    ) {
      const prefixes = normalizedStringSet(
        rule.allowedFactKeyPrefixes,
        "project_memory_proposal.allowedFactKeyPrefixes",
        { min: 1, max: 20 },
      );
      if (prefixes.some((prefix) => !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.$/u.test(prefix))) {
        throw new Error("project_memory_proposal.allowedFactKeyPrefixes is invalid");
      }
      capabilities[name].allowedFactKeyPrefixes = prefixes;
      capabilities[name].maxRetentionDays = boundedInteger(
        rule.maxRetentionDays,
        "project_memory_proposal.maxRetentionDays",
        90,
        365,
      );
    }
    if (
      name === "shared_document_write" &&
      (mode !== "disabled" ||
        rule.folderNodeId != null ||
        rule.workspaceId != null)
    ) {
      const folderNodeId = rule.folderNodeId
        ? assertString(rule.folderNodeId, "shared_document_write.folderNodeId")
        : null;
      const workspaceId = rule.workspaceId
        ? assertString(rule.workspaceId, "shared_document_write.workspaceId")
        : null;
      if (Boolean(folderNodeId) === Boolean(workspaceId)) {
        throw new Error(
          "shared_document_write requires exactly one folderNodeId or workspaceId",
        );
      }
      const maxContentBytes = Number(rule.maxContentBytes ?? 200 * 1024);
      if (
        !Number.isSafeInteger(maxContentBytes) ||
        maxContentBytes <= 0 ||
        maxContentBytes > 200 * 1024
      ) {
        throw new Error("shared_document_write.maxContentBytes must be <= 200KB");
      }
      capabilities[name].folderNodeId = folderNodeId;
      capabilities[name].workspaceId = workspaceId;
      capabilities[name].maxContentBytes = maxContentBytes;
    }
    if (
      name === "dingtalk_todo_create" &&
      (mode !== "disabled" || rule.allowedExecutorUserIds != null)
    ) {
      capabilities[name].allowedExecutorUserIds = normalizedStringSet(
        rule.allowedExecutorUserIds,
        "dingtalk_todo_create.allowedExecutorUserIds",
        { min: 1 },
      );
      const priorities = normalizedStringSet(
        rule.allowedPriorities ?? ["20"],
        "dingtalk_todo_create.allowedPriorities",
        { min: 1, max: 4 },
      );
      if (priorities.some((priority) => !todoPriorities.has(priority))) {
        throw new Error("dingtalk_todo_create.allowedPriorities is invalid");
      }
      capabilities[name].allowedPriorities = priorities;
      capabilities[name].maxTitleChars = boundedInteger(
        rule.maxTitleChars,
        "dingtalk_todo_create.maxTitleChars",
        120,
        200,
      );
    }
    if (
      name === "dingtalk_calendar_create" &&
      (mode !== "disabled" || rule.allowedAttendeeUserIds != null)
    ) {
      capabilities[name].allowedAttendeeUserIds = normalizedStringSet(
        rule.allowedAttendeeUserIds ?? [],
        "dingtalk_calendar_create.allowedAttendeeUserIds",
      );
      capabilities[name].maxDurationMinutes = boundedInteger(
        rule.maxDurationMinutes,
        "dingtalk_calendar_create.maxDurationMinutes",
        240,
        1_440,
      );
      capabilities[name].maxTitleChars = boundedInteger(
        rule.maxTitleChars,
        "dingtalk_calendar_create.maxTitleChars",
        120,
        200,
      );
      capabilities[name].allowedRoomNames = normalizedStringSet(
        rule.allowedRoomNames ?? [],
        "dingtalk_calendar_create.allowedRoomNames",
        { max: 20 },
      );
      capabilities[name].allowRecurrence = rule.allowRecurrence === true;
      capabilities[name].allowedRecurrenceTypes = capabilities[name].allowRecurrence
        ? normalizedStringSet(
            rule.allowedRecurrenceTypes ?? ["daily", "weekly"],
            "dingtalk_calendar_create.allowedRecurrenceTypes",
            { min: 1, max: 2 },
          )
        : [];
      if (
        capabilities[name].allowedRecurrenceTypes.some(
          (type) => !recurrenceTypes.has(type),
        )
      ) {
        throw new Error("dingtalk_calendar_create.allowedRecurrenceTypes is invalid");
      }
      capabilities[name].maxRecurrenceCount = capabilities[name].allowRecurrence
        ? boundedInteger(
            rule.maxRecurrenceCount,
            "dingtalk_calendar_create.maxRecurrenceCount",
            20,
            365,
          )
        : null;
    }
    if (
      name === "dingtalk_report_submit" &&
      (mode !== "disabled" || rule.templateId != null || rule.templateName != null)
    ) {
      capabilities[name].templateId = assertString(
        rule.templateId,
        "dingtalk_report_submit.templateId",
      );
      capabilities[name].templateName = assertString(
        rule.templateName,
        "dingtalk_report_submit.templateName",
      );
      capabilities[name].fields = normalizedReportFields(rule.fields);
      capabilities[name].maxContentBytes = boundedInteger(
        rule.maxContentBytes,
        "dingtalk_report_submit.maxContentBytes",
        100 * 1024,
        1024 * 1024,
      );
    }
    if (
      capabilities[name].maxRuns != null &&
      (!Number.isSafeInteger(capabilities[name].maxRuns) ||
        capabilities[name].maxRuns <= 0)
    ) {
      throw new Error(`maxRuns must be a positive integer: ${name}`);
    }
    if (
      capabilities[name].timeoutMs != null &&
      (!Number.isFinite(capabilities[name].timeoutMs) ||
        capabilities[name].timeoutMs <= 0)
    ) {
      throw new Error(`timeoutMs must be positive: ${name}`);
    }
  }
  return {
    version: 1,
    projectId,
    name,
    rootDirectory: resolve(rootDirectory),
    requesters,
    ...(input.profile == null ? {} : { profile: validateProjectProfile(input.profile) }),
    capabilities,
  };
}

export function evaluatePlan({ manifest, requesterId, steps, now = new Date() }) {
  const project = validateProjectManifest(manifest);
  if (!Array.isArray(steps) || steps.length === 0) {
    return { decision: "ASK_FOR_INFORMATION", reason: "任务计划不能为空。" };
  }
  if (!requesterId || !project.requesters.includes(requesterId)) {
    return { decision: "DENY", reason: "请求人不在项目授权范围内。" };
  }
  let maxLevel = "L0";
  let requiresApproval = false;
  const evaluatedSteps = [];
  const capabilityRuns = new Map();
  for (const [index, step] of steps.entries()) {
    const capability = assertString(step?.capability, `steps[${index}].capability`);
    if (prohibitedCapabilities.has(capability)) {
      return { decision: "DENY", reason: `能力属于禁止区：${capability}` };
    }
    const definition = capabilityCatalog[capability];
    if (!definition) {
      return { decision: "DENY", reason: `能力未登记：${capability}` };
    }
    const rule = project.capabilities[capability];
    if (!rule || rule.mode === "disabled") {
      return { decision: "DENY", reason: `项目未授权能力：${capability}` };
    }
    if (rule.expiresAt && new Date(rule.expiresAt) <= now) {
      return { decision: "DENY", reason: `能力授权已过期：${capability}` };
    }
    const runs = (capabilityRuns.get(capability) ?? 0) + 1;
    capabilityRuns.set(capability, runs);
    if (rule.maxRuns != null && runs > rule.maxRuns) {
      return { decision: "DENY", reason: `能力次数超过授权上限：${capability}` };
    }
    const knowledgeStepIds = step.inputs?.knowledgeStepIds;
    if (knowledgeStepIds != null) {
      if (
        !Array.isArray(knowledgeStepIds) ||
        knowledgeStepIds.length === 0 ||
        knowledgeStepIds.length > 10 ||
        new Set(knowledgeStepIds).size !== knowledgeStepIds.length ||
        knowledgeStepIds.some((id) => typeof id !== "string" || !id.trim()) ||
        knowledgeStepIds.some((id) => !steps.slice(0, index).some(
          (candidate) => candidate.id === id && candidate.capability === "knowledge_read",
        ))
      ) {
        return { decision: "DENY", reason: "知识证据必须引用更早的知识页读取步骤。" };
      }
    }
    if (capability === "knowledge_read") {
      const slugs = step.inputs?.slugs;
      if (
        !onlyInputKeys(step.inputs, new Set(["slugs"])) ||
        !Array.isArray(slugs) ||
        slugs.length === 0 ||
        slugs.length > rule.maxPages ||
        new Set(slugs).size !== slugs.length ||
        slugs.some((slug) => (
          typeof slug !== "string" ||
          !slug.trim() ||
          slug !== slug.trim() ||
          slug.length > 300 ||
          slug.startsWith("/") ||
          slug.includes("//") ||
          slug.split("/").includes("..") ||
          !/^[\p{L}\p{N}._/-]+$/u.test(slug)
        )) ||
        slugs.some((slug) => !rule.allowedSlugPrefixes.some(
          (prefix) => slug.startsWith(prefix) && slug.length > prefix.length,
        ))
      ) {
        return { decision: "DENY", reason: "知识页不在项目授权的精确路径范围内。" };
      }
    }
    if (
      definition.requiresProjectRoot &&
      (!step.workingDirectory || !withinRoot(project.rootDirectory, step.workingDirectory))
    ) {
      return { decision: "DENY", reason: `工作目录超出项目范围：${capability}` };
    }
    if (commandCapabilities.has(capability)) {
      const commandId = String(step.inputs?.commandId ?? "").trim();
      if (!commandId || !rule.commands?.[commandId]) {
        return { decision: "DENY", reason: `命令未在项目清单登记：${capability}` };
      }
      if (capability === "production_deploy") {
        for (const inputName of ["verificationCommandId", "rollbackCommandId"]) {
          const referenced = String(step.inputs?.[inputName] ?? "").trim();
          if (!referenced || !rule.commands?.[referenced]) {
            return {
              decision: "DENY",
              reason: `发布验收或回滚命令未登记：${inputName}`,
            };
          }
        }
      }
    }
    if (capability === "dingtalk_todo_create") {
      const title = String(step.inputs?.title ?? "").trim();
      const executors = Array.isArray(step.inputs?.executorUserIds)
        ? [...new Set(step.inputs.executorUserIds)]
        : [];
      const priority = String(step.inputs?.priority ?? "20");
      const due = step.inputs?.due == null ? null : new Date(step.inputs.due);
      if (
        !onlyInputKeys(
          step.inputs,
          new Set(["title", "executorUserIds", "priority", "due"]),
        ) ||
        !title ||
        title.length > rule.maxTitleChars ||
        /[\r\n]/u.test(title)
      ) {
        return { decision: "DENY", reason: "待办标题不符合项目授权范围。" };
      }
      if (
        executors.length === 0 ||
        executors.length > 30 ||
        executors.some((id) => typeof id !== "string" || !id.trim()) ||
        executors.some((id) => !rule.allowedExecutorUserIds.includes(id))
      ) {
        return { decision: "DENY", reason: "待办执行人不在项目授权范围内。" };
      }
      if (!rule.allowedPriorities.includes(priority)) {
        return { decision: "DENY", reason: "待办优先级不在项目授权范围内。" };
      }
      if (due && Number.isNaN(due.getTime())) {
        return { decision: "DENY", reason: "待办截止时间格式无效。" };
      }
    }
    if (capability === "github_pr_draft") {
      const pushStepId = String(step.inputs?.pushStepId ?? "").trim();
      const title = String(step.inputs?.title ?? "").trim();
      const body = String(step.inputs?.body ?? "").trim();
      const baseBranch = String(step.inputs?.baseBranch ?? "").trim();
      const referencedPush = steps.slice(0, index).some(
        (candidate) => candidate.id === pushStepId && candidate.capability === "git_push",
      );
      if (
        !onlyInputKeys(step.inputs, new Set(["pushStepId", "title", "body", "baseBranch"])) ||
        !referencedPush ||
        !title || title.length > rule.maxTitleChars || /[\r\n]/u.test(title) ||
        !body || Buffer.byteLength(body, "utf8") > rule.maxBodyBytes ||
        !rule.baseBranches.includes(baseBranch)
      ) {
        return { decision: "DENY", reason: "GitHub PR 草稿超出项目授权范围。" };
      }
    }
    if (capability === "project_memory_proposal") {
      const statement = String(step.inputs?.statement ?? "").trim();
      const factKey = String(step.inputs?.factKey ?? "").trim();
      const retentionDays = Number(step.inputs?.retentionDays);
      const documentStepId = String(step.inputs?.documentStepId ?? "").trim();
      const referencedDocument = steps.slice(0, index).some(
        (candidate) => candidate.id === documentStepId && candidate.capability === "document_draft",
      );
      if (
        !onlyInputKeys(step.inputs, new Set(["statement", "factKey", "retentionDays", "documentStepId"])) ||
        !referencedDocument || !statement || statement.length > 1_000 ||
        containsCredentialMaterial(statement) ||
        !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,4}$/u.test(factKey) ||
        !rule.allowedFactKeyPrefixes.some((prefix) => factKey.startsWith(prefix)) ||
        !Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > rule.maxRetentionDays ||
        !(project.profile?.memoryScope.allowedTypes ?? []).includes("project")
      ) {
        return { decision: "DENY", reason: "项目记忆候选超出项目记忆范围。" };
      }
    }
    if (capability === "dingtalk_calendar_create") {
      const title = String(step.inputs?.title ?? "").trim();
      const start = new Date(step.inputs?.start);
      const end = new Date(step.inputs?.end);
      const attendees = Array.isArray(step.inputs?.attendeeUserIds)
        ? [...new Set(step.inputs.attendeeUserIds)]
        : [];
      const durationMinutes = (end.getTime() - start.getTime()) / 60_000;
      if (
        !onlyInputKeys(
          step.inputs,
          new Set([
            "title",
            "start",
            "end",
            "description",
            "attendeeUserIds",
            "timezone",
            "location",
            "freeBusy",
            "roomName",
            "recurrence",
          ]),
        ) ||
        !title ||
        title.length > rule.maxTitleChars ||
        /[\r\n]/u.test(title)
      ) {
        return { decision: "DENY", reason: "日程标题不符合项目授权范围。" };
      }
      if (
        Number.isNaN(start.getTime()) ||
        Number.isNaN(end.getTime()) ||
        durationMinutes <= 0 ||
        durationMinutes > rule.maxDurationMinutes
      ) {
        return { decision: "DENY", reason: "日程时间不符合项目授权范围。" };
      }
      if (
        attendees.length > 30 ||
        attendees.some((id) => typeof id !== "string" || !id.trim()) ||
        attendees.some((id) => !rule.allowedAttendeeUserIds.includes(id))
      ) {
        return { decision: "DENY", reason: "日程参与人不在项目授权范围内。" };
      }
      const roomName = step.inputs?.roomName == null
        ? null
        : String(step.inputs.roomName).trim();
      if (roomName && !rule.allowedRoomNames.includes(roomName)) {
        return { decision: "DENY", reason: "会议室不在项目授权范围内。" };
      }
      const recurrence = step.inputs?.recurrence;
      if (roomName && recurrence != null) {
        return { decision: "DENY", reason: "会议室预订不能与按次数循环日程组合。" };
      }
      if (recurrence != null) {
        const type = String(recurrence?.type ?? "");
        const interval = Number(recurrence?.interval);
        const count = Number(recurrence?.count);
        const daysOfWeek = recurrence?.daysOfWeek;
        const allowedKeys = type === "weekly"
          ? new Set(["type", "interval", "count", "daysOfWeek"])
          : new Set(["type", "interval", "count"]);
        if (
          !rule.allowRecurrence ||
          !onlyInputKeys(recurrence, allowedKeys) ||
          !rule.allowedRecurrenceTypes.includes(type) ||
          !Number.isSafeInteger(interval) || interval <= 0 || interval > 30 ||
          !Number.isSafeInteger(count) || count <= 0 || count > rule.maxRecurrenceCount ||
          (type === "weekly" && (
            !Array.isArray(daysOfWeek) ||
            daysOfWeek.length === 0 ||
            daysOfWeek.length > 7 ||
            daysOfWeek.some((day) => !weekdays.has(day))
          ))
        ) {
          return { decision: "DENY", reason: "循环日程规则不在项目授权范围内。" };
        }
      }
    }
    if (capability === "dingtalk_report_submit") {
      const values = step.inputs?.fieldValues;
      const fieldNames = rule.fields.map((field) => field.name).sort();
      const suppliedNames = values && !Array.isArray(values) && typeof values === "object"
        ? Object.keys(values).sort()
        : [];
      if (
        !onlyInputKeys(step.inputs, new Set(["fieldValues"])) ||
        JSON.stringify(suppliedNames) !== JSON.stringify(fieldNames) ||
        Object.values(values ?? {}).some((value) => typeof value !== "string") ||
        Buffer.byteLength(JSON.stringify(values ?? {}), "utf8") > rule.maxContentBytes
      ) {
        return { decision: "DENY", reason: "日志字段不符合固定模板授权。" };
      }
    }
    if (levels.indexOf(definition.level) > levels.indexOf(maxLevel)) {
      maxLevel = definition.level;
    }
    requiresApproval ||=
      rule.mode === "approval_required" ||
      definition.level === "L3" ||
      definition.level === "L4";
    evaluatedSteps.push({ capability, level: definition.level, mode: rule.mode });
  }
  return {
    decision: requiresApproval ? "REQUIRE_APPROVAL" : "ALLOW",
    reason: requiresApproval ? "完整计划包含需要单次审批的能力。" : "完整计划在项目授权范围内。",
    projectId: project.projectId,
    maxLevel,
    steps: evaluatedSteps,
  };
}
