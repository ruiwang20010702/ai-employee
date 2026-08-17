import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { safeCommandEnvironment } from "./controlled-command-runner.mjs";
import { DataCipher } from "./crypto.mjs";
import { buildHistoricalProjectImportPreview } from "./historical-project-import.mjs";
import { safeErrorCode } from "./logging.mjs";
import { loadWorkRecipes } from "./recipe-library.mjs";
import { Store } from "./store.mjs";
import { createReadOnlyWorkAdapters } from "./work-adapters.mjs";
import { executeWorkPlan } from "./work-executor.mjs";
import { assessWorkPlan } from "./work-plan.mjs";
import { instantiateWorkRecipe } from "./work-recipe.mjs";

const shadowCapabilities = new Set([
  "repository_activity_read",
  "project_work_history_read",
  "research",
  "document_draft",
]);
const maximumReviewPreviewCharacters = 8_000;
const maximumShadowEvidenceBytes = 4 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function requiredText(value, name, maximum = 4_000) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function authorityBoundary() {
  return Object.freeze({
    productionDatabaseConnected: false,
    externalBusinessSystemsTouched: false,
    messageSendingEnabled: false,
    planSideEffectsEnabled: false,
    repositoryWriteEnabled: false,
    memoryWrittenOrConfirmed: false,
    timeReturnWrittenOrConfirmed: false,
  });
}

function publicPlan(assessment) {
  return {
    planHash: assessment.planHash,
    projectId: assessment.plan.projectId,
    requesterId: assessment.plan.requesterId,
    objective: assessment.plan.objective,
    steps: assessment.plan.steps.map((step) => ({
      id: step.id,
      capability: step.capability,
      description: step.description,
      workingDirectory: step.workingDirectory,
      expectedEvidence: step.expectedEvidence,
    })),
  };
}

function ensureShadowPlan(plan) {
  const unsafe = plan.steps.filter((step) => !shadowCapabilities.has(step.capability));
  if (unsafe.length > 0) {
    throw new Error(
      `Project recipe shadow only permits repository activity, project work history, research, and document_draft; rejected: ${unsafe.map((step) => step.capability).join(", ")}`,
    );
  }
}

async function git(rootDirectory, args) {
  const { stdout } = await execFileAsync(
    "/usr/bin/git",
    [
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null",
      "-c", "credential.helper=",
      "-C", rootDirectory,
      ...args,
    ],
    {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      env: safeCommandEnvironment("/usr/bin/git"),
    },
  );
  return stdout.trim();
}

export async function inspectProjectRecipeShadowRepository(rootDirectory, {
  gitRun = git,
} = {}) {
  const [repositoryRoot, commit, status] = await Promise.all([
    gitRun(rootDirectory, ["rev-parse", "--show-toplevel"]),
    gitRun(rootDirectory, ["rev-parse", "HEAD"]),
    gitRun(rootDirectory, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if ((await realpath(repositoryRoot)) !== rootDirectory) {
    throw new Error("Project recipe shadow requires the project Git repository root");
  }
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error("Project recipe shadow requires a valid Git commit");
  }
  if (status !== "") {
    throw new Error("Project recipe shadow requires a clean Git worktree");
  }
  return { commit, clean: true };
}

export async function previewProjectRecipeShadow({
  bundle,
  recipeId,
  values = {},
  recipesDirectory,
  now = new Date(),
  importPreviewBuilder = buildHistoricalProjectImportPreview,
  recipeLoader = loadWorkRecipes,
  repositoryInspector = inspectProjectRecipeShadowRepository,
} = {}) {
  const selectedRecipeId = requiredText(recipeId, "recipeId", 100);
  const historicalPreview = await importPreviewBuilder(bundle, { now });
  if (!historicalPreview.manifest.profile.selectedRecipeIds.includes(selectedRecipeId)) {
    throw new Error("Project recipe was not selected by the imported project profile");
  }
  const recipes = await recipeLoader(recipesDirectory);
  const recipe = recipes.get(selectedRecipeId);
  if (!recipe) throw new Error(`Project recipe not found: ${selectedRecipeId}`);
  const instantiated = instantiateWorkRecipe(recipe, {
    projectId: historicalPreview.manifest.projectId,
    requesterId: historicalPreview.manifest.requesters[0],
    projectRoot: historicalPreview.manifest.rootDirectory,
    values,
  });
  ensureShadowPlan(instantiated.plan);
  const assessment = assessWorkPlan({
    plan: instantiated.plan,
    manifest: historicalPreview.manifest,
    now,
  });
  if (assessment.decision !== "ALLOW") {
    throw new Error(`Project recipe shadow must be automatically read-only: ${assessment.reason}`);
  }
  const repository = await repositoryInspector(historicalPreview.manifest.rootDirectory);
  return {
    schema: "foursday-project-recipe-shadow-preview/v1",
    project: {
      id: historicalPreview.manifest.projectId,
      name: historicalPreview.manifest.name,
      sourceDigest: historicalPreview.digest,
      sourceCount: historicalPreview.counts.sources,
    },
    recipe: {
      id: recipe.id,
      name: recipe.name,
      baselineMinutes: recipe.baselineMinutes,
      baselineMethod: recipe.baselineMethod,
    },
    repository,
    plan: publicPlan(assessment),
    authorityBoundary: authorityBoundary(),
    databaseWrite: false,
    modelInvoked: false,
    assessment,
    manifest: historicalPreview.manifest,
    recipeDefinition: recipe,
    sourcePaths: historicalPreview.sources.map((source) => source.path),
  };
}

async function createOutputDirectory(outputDirectory) {
  const requested = requiredText(outputDirectory, "outputDirectory", 4_096);
  if (!isAbsolute(requested) || resolve(requested) !== requested) {
    throw new Error("outputDirectory must be a normalized absolute path");
  }
  const parent = dirname(requested);
  const canonicalParent = await realpath(parent);
  const canonicalOutput = join(canonicalParent, basename(requested));
  if (canonicalOutput !== requested) {
    throw new Error("outputDirectory parent must not traverse a symbolic link");
  }
  const existing = await lstat(requested).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error("outputDirectory must not already exist");
  await mkdir(requested, { mode: 0o700 });
  await chmod(requested, 0o700);
  return requested;
}

function evidenceForOutput(steps) {
  return steps.map((step) => ({
    stepId: step.step_id,
    capability: step.capability,
    status: step.status,
    error: step.error,
    evidence: step.evidence,
  }));
}

function reviewMarkdown(result, {
  evidenceDirectory,
  evidenceSha256,
  confirmation,
}) {
  const sections = result.steps.map((step) => {
    const content = String(step.evidence?.content ?? "");
    const preview = content.length > maximumReviewPreviewCharacters
      ? `${content.slice(0, maximumReviewPreviewCharacters)}\n\n> 预览已截断；完整内容见证据 JSON。`
      : content;
    return [
      `## ${step.stepId} · ${step.capability}`,
      "",
      `- 状态：${step.status}`,
      `- 证据类型：${step.evidence?.kind ?? "无"}`,
      `- SHA-256：${step.evidence?.sha256 ?? "无"}`,
      "",
      preview || "（没有可审阅正文）",
    ].join("\n");
  });
  return [
    "# 项目配方影子验证审阅说明",
    "",
    `- 项目：${result.project.id}`,
    `- 配方：${result.recipe.id}`,
    `- 计划哈希：${result.plan.planHash}`,
    `- 人工基线：${result.timeReturn.baselineMinutes} 分钟`,
    "- 生产数据库：未连接",
    "- 模型运行时：已调用；外部业务系统与消息发送：未触达",
    "- 记忆与时间返还：未写入、未确认",
    `- 证据 SHA-256：${evidenceSha256}`,
    `- 本地审阅确认口令：${confirmation}`,
    "",
    "请先阅读并核对下面的实际交付物，再填写：AI 完成后，你实际花了多少分钟阅读、核对、补充或修改？不要填写假设中的手工耗时。",
    "",
    "确认命令（把 `<实际分钟>` 替换为真实整数）：",
    "",
    "```bash",
    `npm run projects:shadow -- --review ${JSON.stringify(evidenceDirectory)} --evidence-sha256 ${evidenceSha256} --human-minutes <实际分钟> --confirm ${confirmation}`,
    "```",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}

async function writeProtectedJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

async function readProtectedShadowFile(path, maximumBytes = maximumShadowEvidenceBytes) {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o077) !== 0 ||
    before.size < 1 ||
    before.size > maximumBytes ||
    (await realpath(path)) !== path
  ) {
    throw new Error("Project recipe shadow evidence must be a protected regular file");
  }
  const content = await readFile(path);
  const after = await lstat(path);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    throw new Error("Project recipe shadow evidence changed while it was being read");
  }
  return content;
}

async function inspectShadowEvidenceDirectory(evidenceDirectory) {
  const requested = requiredText(evidenceDirectory, "evidenceDirectory", 4_096);
  if (!isAbsolute(requested) || resolve(requested) !== requested) {
    throw new Error("evidenceDirectory must be a normalized absolute path");
  }
  const metadata = await lstat(requested);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (await realpath(requested)) !== requested
  ) {
    throw new Error("evidenceDirectory must be a canonical regular directory");
  }
  const evidencePath = join(requested, "证据.json");
  const databasePath = join(requested, "影子证据.sqlite");
  const evidenceContent = await readProtectedShadowFile(evidencePath);
  await readProtectedShadowFile(databasePath, 64 * 1024 * 1024);
  let evidence;
  try {
    evidence = JSON.parse(evidenceContent.toString("utf8"));
  } catch {
    throw new Error("Project recipe shadow evidence is not valid JSON");
  }
  return {
    directory: requested,
    evidencePath,
    databasePath,
    confirmationPath: join(requested, "本人确认.json"),
    evidenceContent,
    evidence,
    evidenceSha256: createHash("sha256").update(evidenceContent).digest("hex"),
  };
}

async function openReadOnlyShadowLedger(databasePath) {
  const encodedKey = (await readProtectedShadowFile(`${databasePath}.key`, 1_024))
    .toString("utf8")
    .trim();
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new Error("Project recipe shadow ledger key is invalid");
  }
  const cipher = new DataCipher(key);
  const immutableDatabaseUrl = pathToFileURL(databasePath);
  immutableDatabaseUrl.searchParams.set("immutable", "1");
  const database = new DatabaseSync(immutableDatabaseUrl, { readOnly: true });
  database.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return {
    listWorkPlans({ status, limit = 100 } = {}) {
      const rows = status
        ? database.prepare(
            "SELECT * FROM work_plans WHERE privacy_erased_at IS NULL AND status = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
          ).all(status, limit)
        : database.prepare(
            "SELECT * FROM work_plans WHERE privacy_erased_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?",
          ).all(limit);
      return rows.map((row) => ({
        ...row,
        requester_id: cipher.decrypt(row.requester_ciphertext),
        objective: cipher.decrypt(row.objective_ciphertext),
        plan: JSON.parse(cipher.decrypt(row.plan_ciphertext)),
      }));
    },
    listWorkPlanSteps(id) {
      return database.prepare(
        "SELECT * FROM work_plan_steps WHERE work_plan_id = ? ORDER BY position",
      ).all(id).map((row) => ({
        ...row,
        evidence: row.evidence_ciphertext
          ? JSON.parse(cipher.decrypt(row.evidence_ciphertext))
          : null,
        error: row.error_ciphertext ? cipher.decrypt(row.error_ciphertext) : null,
      }));
    },
    getTimeReturn(id) {
      const row = database.prepare(
        "SELECT * FROM time_return_entries WHERE id = ?",
      ).get(id);
      if (!row) return null;
      return {
        id: row.id,
        projectId: row.project_id,
        recipeId: row.recipe_id,
        baselineMinutes: row.baseline_minutes,
        humanActiveMinutes: row.human_active_minutes,
        returnedMinutes: row.returned_minutes,
        baselineMethod: row.baseline_method,
        status: row.status,
        updatedAt: row.updated_at,
      };
    },
    close() {
      database.close();
    },
  };
}

function assertEligibleShadowEvidence(evidence) {
  if (
    evidence?.schema !== "foursday-project-recipe-shadow-evidence/v1" ||
    evidence.status !== "completed" ||
    evidence.modelInvoked !== true ||
    evidence.timeReturn?.status !== "awaiting_user_review_time" ||
    evidence.timeReturn?.humanActiveMinutes !== null ||
    evidence.timeReturn?.returnedMinutes !== null ||
    evidence.timeReturn?.writtenToDatabase !== false ||
    evidence.authorityBoundary?.productionDatabaseConnected !== false ||
    evidence.authorityBoundary?.externalBusinessSystemsTouched !== false ||
    !Array.isArray(evidence.steps) ||
    evidence.steps.length < 1 ||
    evidence.steps.some((step) => step.status !== "completed" || !step.evidence)
  ) {
    throw new Error("Project recipe shadow evidence is not eligible for review confirmation");
  }
}

export function projectRecipeShadowReviewConfirmation(evidenceSha256) {
  const normalized = String(evidenceSha256 ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error("Project recipe shadow evidence SHA-256 is invalid");
  }
  return `REVIEW-${normalized.slice(0, 12).toUpperCase()}`;
}

export async function confirmProjectRecipeShadowReview({
  evidenceDirectory,
  evidenceSha256,
  humanActiveMinutes,
  confirmation,
  now = new Date(),
  storeFactory = (path) => new Store(path),
} = {}) {
  const expectedSha256 = String(evidenceSha256 ?? "").trim().toLowerCase();
  const expectedConfirmation = projectRecipeShadowReviewConfirmation(expectedSha256);
  if (String(confirmation ?? "").trim() !== expectedConfirmation) {
    throw new Error(`Project recipe shadow review requires confirmation ${expectedConfirmation}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Project recipe shadow review time must be valid");
  }
  const inspected = await inspectShadowEvidenceDirectory(evidenceDirectory);
  if (inspected.evidenceSha256 !== expectedSha256) {
    throw new Error("Project recipe shadow evidence SHA-256 does not match");
  }
  const { evidence } = inspected;
  assertEligibleShadowEvidence(evidence);
  let existingConfirmation = null;
  const confirmationMetadata = await lstat(inspected.confirmationPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (confirmationMetadata) {
    try {
      existingConfirmation = JSON.parse((await readProtectedShadowFile(
        inspected.confirmationPath,
        256 * 1024,
      )).toString("utf8"));
    } catch {
      throw new Error("Existing project recipe shadow review confirmation is invalid");
    }
    if (
      existingConfirmation?.schema !== "foursday-project-recipe-shadow-review/v1" ||
      existingConfirmation.status !== "confirmed" ||
      existingConfirmation.evidenceSha256 !== expectedSha256 ||
      existingConfirmation.humanActiveMinutes !== Number(humanActiveMinutes) ||
      existingConfirmation.productionDatabaseConnected !== false ||
      existingConfirmation.productionTimeReturnWrittenOrConfirmed !== false
    ) {
      throw new Error("Existing project recipe shadow review confirmation does not match");
    }
  }
  const store = await storeFactory(inspected.databasePath).open();
  try {
    const plans = await store.listWorkPlans({ status: "completed", limit: 10 });
    const matchingPlans = plans.filter((plan) => plan.plan_hash === evidence.plan?.planHash);
    if (matchingPlans.length !== 1) {
      throw new Error("Project recipe shadow ledger does not contain the exact completed plan");
    }
    const plan = matchingPlans[0];
    const ledgerSteps = evidenceForOutput(await store.listWorkPlanSteps(plan.id));
    if (
      plan.project_id !== evidence.project?.id ||
      plan.plan?.recipe?.id !== evidence.recipe?.id ||
      !isDeepStrictEqual(ledgerSteps, evidence.steps)
    ) {
      throw new Error("Project recipe shadow evidence does not match its isolated ledger");
    }
    const timeReturnId = `time_${plan.id}`;
    let entry = await store.getTimeReturn(timeReturnId);
    if (existingConfirmation && (!entry || entry.status !== "confirmed")) {
      throw new Error("Existing project recipe shadow review confirmation has no confirmed ledger entry");
    }
    if (!entry) {
      entry = await store.proposeTimeReturn(
        plan.id,
        humanActiveMinutes,
        "shadow-local-owner",
        now,
      );
    }
    if (
      entry.humanActiveMinutes !== Number(humanActiveMinutes) ||
      entry.baselineMinutes !== evidence.timeReturn.baselineMinutes ||
      entry.recipeId !== evidence.recipe.id
    ) {
      throw new Error("Project recipe shadow review does not match the existing local time return");
    }
    if (entry.status === "proposed") {
      entry = await store.decideTimeReturn(
        entry.id,
        "confirmed",
        "shadow-local-owner",
        now,
      );
    }
    if (entry.status !== "confirmed") {
      throw new Error("Project recipe shadow local time return is not confirmed");
    }
    const currentEvidence = await readProtectedShadowFile(inspected.evidencePath);
    if (createHash("sha256").update(currentEvidence).digest("hex") !== expectedSha256) {
      throw new Error("Project recipe shadow evidence changed before confirmation was recorded");
    }
    const record = {
      schema: "foursday-project-recipe-shadow-review/v1",
      status: "confirmed",
      confirmedAt: entry.updatedAt,
      projectId: entry.projectId,
      recipeId: entry.recipeId,
      planHash: evidence.plan.planHash,
      evidenceSha256: expectedSha256,
      baselineMinutes: entry.baselineMinutes,
      humanActiveMinutes: entry.humanActiveMinutes,
      returnedMinutes: entry.returnedMinutes,
      baselineMethod: entry.baselineMethod,
      localEvidenceLedgerUpdated: true,
      productionDatabaseConnected: false,
      productionTimeReturnWrittenOrConfirmed: false,
    };
    try {
      await writeProtectedJson(inspected.confirmationPath, record);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existing = existingConfirmation;
      if (!existing) {
        try {
          existing = JSON.parse((await readProtectedShadowFile(
            inspected.confirmationPath,
            256 * 1024,
          )).toString("utf8"));
        } catch {
          throw new Error("Existing project recipe shadow review confirmation is invalid");
        }
      }
      if (!isDeepStrictEqual(existing, record)) {
        throw new Error("Existing project recipe shadow review confirmation does not match");
      }
    }
    return {
      schema: record.schema,
      status: record.status,
      projectId: record.projectId,
      recipeId: record.recipeId,
      evidenceSha256: record.evidenceSha256,
      baselineMinutes: record.baselineMinutes,
      humanActiveMinutes: record.humanActiveMinutes,
      returnedMinutes: record.returnedMinutes,
      confirmationPath: inspected.confirmationPath,
      productionDatabaseConnected: false,
      productionTimeReturnWrittenOrConfirmed: false,
    };
  } finally {
    await store.close();
  }
}

export async function inspectConfirmedProjectRecipeShadowReview({
  evidenceDirectory,
  evidenceSha256,
  storeFactory = openReadOnlyShadowLedger,
} = {}) {
  const expectedSha256 = String(evidenceSha256 ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error("Project recipe shadow evidence SHA-256 is invalid");
  }
  const inspected = await inspectShadowEvidenceDirectory(evidenceDirectory);
  if (inspected.evidenceSha256 !== expectedSha256) {
    throw new Error("Project recipe shadow evidence SHA-256 does not match");
  }
  assertEligibleShadowEvidence(inspected.evidence);
  let confirmation;
  try {
    confirmation = JSON.parse((await readProtectedShadowFile(
      inspected.confirmationPath,
      256 * 1024,
    )).toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Project recipe shadow evidence has not been confirmed by its owner");
    }
    if (error instanceof SyntaxError) {
      throw new Error("Project recipe shadow review confirmation is invalid");
    }
    throw error;
  }
  const { evidence } = inspected;
  if (
    confirmation?.schema !== "foursday-project-recipe-shadow-review/v1" ||
    confirmation.status !== "confirmed" ||
    confirmation.evidenceSha256 !== expectedSha256 ||
    confirmation.projectId !== evidence.project?.id ||
    confirmation.recipeId !== evidence.recipe?.id ||
    confirmation.planHash !== evidence.plan?.planHash ||
    confirmation.baselineMinutes !== evidence.timeReturn?.baselineMinutes ||
    confirmation.returnedMinutes !==
      confirmation.baselineMinutes - confirmation.humanActiveMinutes ||
    confirmation.baselineMethod !== evidence.timeReturn?.baselineMethod ||
    confirmation.localEvidenceLedgerUpdated !== true ||
    confirmation.productionDatabaseConnected !== false ||
    confirmation.productionTimeReturnWrittenOrConfirmed !== false
  ) {
    throw new Error("Project recipe shadow review confirmation does not match its evidence");
  }
  const store = await storeFactory(inspected.databasePath);
  try {
    const plans = await store.listWorkPlans({ status: "completed", limit: 10 });
    const matchingPlans = plans.filter((plan) => plan.plan_hash === evidence.plan.planHash);
    if (matchingPlans.length !== 1) {
      throw new Error("Project recipe shadow ledger does not contain the exact completed plan");
    }
    const plan = matchingPlans[0];
    const steps = evidenceForOutput(await store.listWorkPlanSteps(plan.id));
    const entry = await store.getTimeReturn(`time_${plan.id}`);
    if (
      plan.project_id !== evidence.project.id ||
      plan.plan?.recipe?.id !== evidence.recipe.id ||
      !isDeepStrictEqual(steps, evidence.steps) ||
      !entry ||
      entry.status !== "confirmed" ||
      entry.projectId !== confirmation.projectId ||
      entry.recipeId !== confirmation.recipeId ||
      entry.baselineMinutes !== confirmation.baselineMinutes ||
      entry.humanActiveMinutes !== confirmation.humanActiveMinutes ||
      entry.returnedMinutes !== confirmation.returnedMinutes ||
      entry.baselineMethod !== confirmation.baselineMethod ||
      entry.updatedAt !== confirmation.confirmedAt
    ) {
      throw new Error("Project recipe shadow confirmation does not match its isolated ledger");
    }
    const currentEvidence = await readProtectedShadowFile(inspected.evidencePath);
    if (createHash("sha256").update(currentEvidence).digest("hex") !== expectedSha256) {
      throw new Error("Project recipe shadow evidence changed during admission inspection");
    }
    return {
      projectId: confirmation.projectId,
      recipeId: confirmation.recipeId,
      evidenceSha256: expectedSha256,
      planHash: confirmation.planHash,
      repositoryCommit: evidence.repository?.commit,
      baselineMinutes: confirmation.baselineMinutes,
      humanActiveMinutes: confirmation.humanActiveMinutes,
      returnedMinutes: confirmation.returnedMinutes,
      baselineMethod: confirmation.baselineMethod,
      confirmedAt: confirmation.confirmedAt,
      outcomeEvidence: {
        kind: "confirmed_shadow_recipe_evidence",
        evidenceSha256: expectedSha256,
        planHash: confirmation.planHash,
        repositoryCommit: evidence.repository?.commit,
        projectSourceDigest: evidence.project?.sourceDigest,
        steps: evidence.steps.map((step) => ({
          stepId: step.stepId,
          capability: step.capability,
          kind: step.evidence?.kind ?? null,
          sha256: step.evidence?.sha256 ?? null,
          verification: step.evidence?.verification ?? null,
        })),
      },
    };
  } finally {
    await store.close();
  }
}

export async function runProjectRecipeShadow({
  bundle,
  recipeId,
  values = {},
  recipesDirectory,
  outputDirectory,
  artifactRuntime,
  now = () => new Date(),
  previewer = previewProjectRecipeShadow,
  storeFactory = (path) => new Store(path),
  adapterFactory = createReadOnlyWorkAdapters,
  executor = executeWorkPlan,
} = {}) {
  if (!artifactRuntime?.generateArtifact) {
    throw new Error("Project recipe shadow requires an artifact runtime");
  }
  const preparedAt = now();
  const preview = await previewer({
    bundle,
    recipeId,
    values,
    recipesDirectory,
    now: preparedAt,
  });
  const output = await createOutputDirectory(outputDirectory);
  const databasePath = join(output, "影子证据.sqlite");
  const evidencePath = join(output, "证据.json");
  const reviewPath = join(output, "审阅说明.md");
  const failurePath = join(output, "失败证据.json");
  const store = await storeFactory(databasePath).open();
  let planId = null;
  try {
    const registered = await store.registerWorkPlan(preview.assessment, preparedAt);
    planId = registered.id;
    const execution = await executor({
      store,
      planId,
      manifest: preview.manifest,
      adapters: adapterFactory({
        artifactRuntime,
        evidencePaths: preview.sourcePaths,
        store,
      }),
      now,
    });
    const steps = evidenceForOutput(await store.listWorkPlanSteps(planId));
    if (
      execution.status !== "completed" ||
      steps.length !== preview.plan.steps.length ||
      steps.some((step) => step.status !== "completed" || !step.evidence)
    ) {
      throw new Error("Project recipe shadow did not complete with verified evidence");
    }
    const finalPreview = await previewer({
      bundle,
      recipeId,
      values,
      recipesDirectory,
      now: now(),
    });
    if (
      finalPreview.project.sourceDigest !== preview.project.sourceDigest ||
      finalPreview.plan.planHash !== preview.plan.planHash ||
      finalPreview.repository.commit !== preview.repository.commit ||
      finalPreview.repository.clean !== true
    ) {
      throw new Error("Project recipe shadow source snapshot changed during execution");
    }
    const result = {
      schema: "foursday-project-recipe-shadow-evidence/v1",
      status: "completed",
      createdAt: now().toISOString(),
      project: preview.project,
      recipe: preview.recipe,
      repository: preview.repository,
      plan: preview.plan,
      steps,
      authorityBoundary: authorityBoundary(),
      modelInvoked: true,
      timeReturn: {
        status: "awaiting_user_review_time",
        baselineMinutes: preview.recipe.baselineMinutes,
        baselineMethod: preview.recipe.baselineMethod,
        humanActiveMinutes: null,
        returnedMinutes: null,
        writtenToDatabase: false,
      },
    };
    await writeProtectedJson(evidencePath, result);
    const evidenceSha256 = createHash("sha256")
      .update(await readFile(evidencePath))
      .digest("hex");
    const reviewConfirmation = projectRecipeShadowReviewConfirmation(evidenceSha256);
    await writeFile(reviewPath, reviewMarkdown(result, {
      evidenceDirectory: output,
      evidenceSha256,
      confirmation: reviewConfirmation,
    }), { flag: "wx", mode: 0o600 });
    await chmod(reviewPath, 0o600);
    return {
      schema: "foursday-project-recipe-shadow-result/v1",
      status: "completed",
      projectId: result.project.id,
      recipeId: result.recipe.id,
      planHash: result.plan.planHash,
      evidenceSha256,
      reviewConfirmation,
      outputDirectory: output,
      evidencePath,
      reviewPath,
      timeReturnStatus: result.timeReturn.status,
      authorityBoundary: result.authorityBoundary,
      modelInvoked: true,
    };
  } catch (error) {
    let plan = null;
    let steps = [];
    if (planId) {
      try {
        plan = await store.getWorkPlan(planId);
        steps = evidenceForOutput(await store.listWorkPlanSteps(planId));
      } catch {
        plan = null;
        steps = [];
      }
    }
    await writeProtectedJson(failurePath, {
      schema: "foursday-project-recipe-shadow-failure/v1",
      status: "failed",
      errorCode: safeErrorCode(error),
      projectId: preview.project.id,
      recipeId: preview.recipe.id,
      planHash: preview.plan.planHash,
      planStatus: plan?.status ?? null,
      steps,
      authorityBoundary: authorityBoundary(),
      modelInvocationMayHaveStarted: planId !== null,
    }).catch(() => {});
    throw error;
  } finally {
    await store.close();
  }
}
