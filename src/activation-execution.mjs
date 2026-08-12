import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { validateProjectManifest } from "./capability-policy.mjs";
import { buildActivationPreview } from "./activation.mjs";
import { Store } from "./store.mjs";
import { createControlledWorkAdapters } from "./work-adapters.mjs";
import { executeWorkPlan } from "./work-executor.mjs";
import { assessWorkPlan } from "./work-plan.mjs";
import { safeCommandEnvironment } from "./controlled-command-runner.mjs";
import { createStructuredArtifactRuntime } from "./artifact-runtime.mjs";
import { sealValidationEvidence } from "./validation-evidence.mjs";

const execFileAsync = promisify(execFile);

function text(value, name, maximum = 4_000) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function githubRepositoryFromRemote(value) {
  const remote = text(value, "gitRemote", 2_000);
  const scp = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/iu);
  if (scp) return scp[1].toLowerCase();
  let parsed;
  try {
    parsed = new URL(remote);
  } catch {
    throw new Error("Git remote must point to GitHub");
  }
  if (
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Git remote must point to GitHub without embedded credentials");
  }
  return parsed.pathname.replace(/^\//u, "").replace(/\.git$/iu, "").toLowerCase();
}

async function git(root, args) {
  const { stdout } = await execFileAsync("/usr/bin/git", ["-C", root, ...args], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: safeCommandEnvironment("/usr/bin/git"),
  });
  return stdout.trim();
}

export async function inspectActivationRepository(rootDirectory, {
  gitRun = git,
} = {}) {
  const [head, remoteUrl, status] = await Promise.all([
    gitRun(rootDirectory, ["rev-parse", "HEAD"]),
    gitRun(rootDirectory, ["remote", "get-url", "origin"]),
    gitRun(rootDirectory, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error("Project must have a valid Git HEAD");
  if (status !== "") {
    throw new Error("Project worktree must be clean before a governed delivery starts");
  }
  return {
    head,
    remoteUrl,
    repository: githubRepositoryFromRemote(remoteUrl),
  };
}

async function registeredNpmCommand({ rootDirectory, commandId, npmCliPath, nodePath }) {
  if (!isAbsolute(nodePath) || !isAbsolute(npmCliPath)) {
    throw new Error("Node and npm executables must use absolute paths");
  }
  await Promise.all([
    access(nodePath, constants.X_OK),
    access(npmCliPath, constants.R_OK),
  ]);
  const metadata = JSON.parse(await readFile(join(rootDirectory, "package.json"), "utf8"));
  if (typeof metadata.scripts?.[commandId] !== "string" || !metadata.scripts[commandId].trim()) {
    throw new Error(`package.json does not register the requested script: ${commandId}`);
  }
  return {
    executable: nodePath,
    args: [npmCliPath, "run", commandId, "--silent"],
    timeoutMs: 600_000,
    maxOutputBytes: 4 * 1024 * 1024,
  };
}

export async function prepareActivationExecution(input, {
  previewBuilder = buildActivationPreview,
  repositoryInspector = inspectActivationRepository,
  npmCliPath = process.env.npm_execpath,
  nodePath = process.execPath,
  commandBuilder = registeredNpmCommand,
} = {}) {
  const preview = await previewBuilder(input);
  if (!["codex", "claude-code", "openai-compatible"].includes(preview.runtime)) {
    throw new Error("Choose a real agent runtime before creating an execution session");
  }
  const snapshot = await repositoryInspector(preview.project.rootDirectory);
  if (snapshot.repository !== preview.issue.repositorySlug.toLowerCase()) {
    throw new Error("GitHub Issue repository does not match the local origin remote");
  }
  const testCommandId = text(input?.testCommandId ?? "check", "testCommandId", 64);
  const testCommand = await commandBuilder({
    rootDirectory: preview.project.rootDirectory,
    commandId: testCommandId,
    npmCliPath,
    nodePath,
  });
  const manifest = validateProjectManifest({
    ...preview.manifest,
    capabilities: {
      ...preview.manifest.capabilities,
      code_patch: { mode: "approval_required", maxRuns: 1, timeoutMs: 600_000 },
      local_branch: { mode: "approval_required", maxRuns: 1 },
      local_test: {
        mode: "approval_required",
        maxRuns: 1,
        commands: { [testCommandId]: testCommand },
      },
      git_push: {
        mode: "approval_required",
        maxRuns: 1,
        timeoutMs: 120_000,
        remote: "origin",
        expectedRemoteUrl: snapshot.remoteUrl,
        branchPrefix: "foursday/",
      },
      github_pr_draft: {
        mode: "approval_required",
        maxRuns: 1,
        timeoutMs: 120_000,
        repository: preview.issue.repositorySlug,
        baseBranches: [text(input?.baseBranch ?? "main", "baseBranch", 200)],
        maxTitleChars: 120,
        maxBodyBytes: 64 * 1024,
      },
    },
  });
  const assessment = assessWorkPlan({ plan: preview.plan, manifest });
  if (assessment.decision !== "REQUIRE_APPROVAL") {
    throw new Error("Activation execution must require approval for the complete plan");
  }
  return {
    preview,
    manifest,
    assessment,
    snapshot: {
      ...snapshot,
      rootDirectory: preview.project.rootDirectory,
    },
  };
}

function publicPlan(plan) {
  return {
    id: plan.id,
    planHash: plan.plan_hash,
    status: plan.status,
    projectId: plan.project_id,
    objective: plan.plan.objective,
    steps: plan.plan.steps.map((step) => ({
      id: step.id,
      capability: step.capability,
      description: step.description,
      expectedEvidence: step.expectedEvidence,
      rollback: step.rollback,
    })),
  };
}

function publicEvidence(steps) {
  return steps.map((step) => ({
    stepId: step.step_id,
    capability: step.capability,
    status: step.status,
    kind: step.evidence?.kind ?? null,
    verification: step.evidence?.verification ?? null,
    sha256: step.evidence?.sha256 ?? null,
    commit: step.evidence?.commit ?? null,
    url: step.evidence?.url ?? null,
    number: step.evidence?.number ?? null,
    error: step.error ?? null,
  }));
}

export class ActivationExecutionCoordinator {
  constructor({
    sessionRoot,
    prepare = prepareActivationExecution,
    storeFactory = (path) => new Store(path),
    adapterFactory = createControlledWorkAdapters,
    artifactRuntimeFactory,
    ghPath = null,
    ghPathProvider = null,
    repositoryInspector = inspectActivationRepository,
  }) {
    if (!isAbsolute(sessionRoot)) throw new Error("Activation session root must be absolute");
    if (typeof artifactRuntimeFactory !== "function") {
      throw new Error("Activation artifact runtime factory is required");
    }
    this.sessionRoot = sessionRoot;
    this.prepare = prepare;
    this.storeFactory = storeFactory;
    this.adapterFactory = adapterFactory;
    this.artifactRuntimeFactory = artifactRuntimeFactory;
    this.ghPath = ghPath;
    this.ghPathProvider = ghPathProvider;
    this.repositoryInspector = repositoryInspector;
    this.sessions = new Map();
  }

  async create(input) {
    const candidate = await this.prepare(input);
    const [artifactRuntime, ghPath] = await Promise.all([
      this.artifactRuntimeFactory(candidate.preview.runtime),
      this.ghPathProvider ? this.ghPathProvider() : this.ghPath,
    ]);
    const id = `activation_${randomUUID()}`;
    await mkdir(this.sessionRoot, { recursive: true, mode: 0o700 });
    const store = await this.storeFactory(join(this.sessionRoot, `${id}.sqlite`)).open();
    try {
      const plan = await store.registerWorkPlan(candidate.assessment);
      const session = {
        id,
        candidate,
        store,
        artifactRuntime,
        ghPath,
        running: false,
        memoryId: null,
        timeReturnId: null,
      };
      this.sessions.set(id, session);
      return { sessionId: id, plan: publicPlan(plan), externalSystemsTouched: false };
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  async get(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    const plan = await session.store.getWorkPlan(`plan_${session.candidate.assessment.planHash.slice(0, 24)}`);
    return { sessionId: id, plan: publicPlan(plan), running: session.running };
  }

  async approveAndExecute(id, { planHash, approved, reason, humanActiveMinutes }) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Activation session not found");
    if (session.running) throw new Error("Activation session is already running");
    if (approved !== true) throw new Error("Explicit approval is required");
    const planId = `plan_${session.candidate.assessment.planHash.slice(0, 24)}`;
    const plan = await session.store.getWorkPlan(planId);
    if (!plan || plan.status !== "awaiting_approval" || plan.plan_hash !== planHash) {
      throw new Error("Activation plan changed; review the current plan again");
    }
    const currentSnapshot = await this.repositoryInspector(
      session.candidate.snapshot.rootDirectory,
    );
    for (const field of ["head", "remoteUrl", "repository"]) {
      if (currentSnapshot[field] !== session.candidate.snapshot[field]) {
        throw new Error("Repository identity changed after plan review");
      }
    }
    session.running = true;
    try {
      await session.store.decideWorkPlan(planId, {
        decision: "approved",
        actor: session.candidate.preview.project.requesterId,
        reason: text(reason, "approvalReason", 1_000),
        maxConsumptions: 1,
      });
      const adapters = this.adapterFactory({
        artifactRuntime: session.artifactRuntime,
        ghPath: session.ghPath,
        store: session.store,
      });
      const execution = await executeWorkPlan({
        store: session.store,
        planId,
        manifest: session.candidate.manifest,
        adapters,
        executionOwner: `${id}:${process.pid}`,
      });
      const steps = await session.store.listWorkPlanSteps(planId);
      let memory = null;
      let timeReturn = null;
      if (execution.status === "completed") {
        const pr = steps.find((step) => step.evidence?.kind === "verified_github_pr_draft")?.evidence;
        if (!pr) throw new Error("Completed activation is missing Draft PR read-back evidence");
        memory = await session.store.proposeWorkPlanMemory({
          type: "project",
          subject: session.candidate.preview.project.projectId,
          projectId: session.candidate.preview.project.projectId,
          statement: `Draft PR #${pr.number} (${pr.url}) completed the approved GitHub Issue delivery at commit ${pr.commit}.`,
          sourceId: plan.plan_hash,
          sourceVersion: `${plan.plan.recipe.id}@${plan.plan.recipe.version}`,
          scope: { factKey: "delivery.latest_draft_pr" },
          confidence: 1,
          sensitivity: "internal",
          expiresAt: new Date(Date.now() + 90 * 86_400_000),
          createdBy: session.candidate.preview.project.requesterId,
        });
        timeReturn = await session.store.proposeTimeReturn(
          planId,
          humanActiveMinutes,
          session.candidate.preview.project.requesterId,
        );
        session.memoryId = memory.id;
        session.timeReturnId = timeReturn.id;
      }
      return {
        sessionId: id,
        status: execution.status,
        plan: publicPlan(await session.store.getWorkPlan(planId)),
        evidence: publicEvidence(steps),
        memoryCandidate: memory ? { id: memory.id, status: memory.status } : null,
        timeReturn: timeReturn ? {
          id: timeReturn.id,
          status: timeReturn.status,
          returnedMinutes: timeReturn.returnedMinutes,
        } : null,
      };
    } finally {
      session.running = false;
    }
  }

  async confirmOutcomes(id, { memoryId, timeReturnId }) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Activation session not found");
    if (memoryId && memoryId !== session.memoryId) {
      throw new Error("Memory candidate does not belong to this activation session");
    }
    if (timeReturnId && timeReturnId !== session.timeReturnId) {
      throw new Error("Time-return proposal does not belong to this activation session");
    }
    const actor = session.candidate.preview.project.requesterId;
    const memoryStatus = memoryId
      ? await session.store.confirmMemory(memoryId, actor)
      : null;
    const timeReturn = timeReturnId
      ? await session.store.decideTimeReturn(timeReturnId, "confirmed", actor)
      : null;
    return {
      memory: memoryStatus ? { id: memoryId, status: memoryStatus } : null,
      timeReturn: timeReturn ? {
        id: timeReturn.id,
        status: timeReturn.status,
        returnedMinutes: timeReturn.returnedMinutes,
      } : null,
    };
  }

  async exportEvidence(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Activation session not found");
    const planId = `plan_${session.candidate.assessment.planHash.slice(0, 24)}`;
    const [plan, steps] = await Promise.all([
      session.store.getWorkPlan(planId),
      session.store.listWorkPlanSteps(planId),
    ]);
    if (
      plan?.status !== "completed" ||
      steps.length !== plan.plan.steps.length ||
      steps.some((step) => step.status !== "completed" || !step.evidence)
    ) {
      throw new Error("Evidence export requires a completed, fully verified activation plan");
    }
    const memory = session.memoryId ? session.store.getMemory(session.memoryId) : null;
    const timeReturn = session.timeReturnId
      ? session.store.getTimeReturn(session.timeReturnId)
      : null;
    const outcomesConfirmed = memory?.status === "confirmed" && timeReturn?.status === "confirmed";
    const core = {
      schema: "foursday-validation-evidence/v1",
      validationStatus: outcomesConfirmed
        ? "verified_closed_loop"
        : "awaiting_outcome_confirmation",
      generatedAt: new Date().toISOString(),
      project: {
        id: session.candidate.preview.project.projectId,
        repository: session.candidate.snapshot.repository,
        startingCommit: session.candidate.snapshot.head,
      },
      issue: {
        url: session.candidate.preview.issue.canonicalUrl,
        number: session.candidate.preview.issue.number,
      },
      runtime: session.candidate.preview.runtime,
      plan: publicPlan(plan),
      evidence: publicEvidence(steps),
      outcomes: {
        memory: memory ? { id: memory.id, status: memory.status } : null,
        timeReturn: timeReturn ? {
          id: timeReturn.id,
          status: timeReturn.status,
          returnedMinutes: timeReturn.returnedMinutes,
          baselineMinutes: timeReturn.baselineMinutes,
          humanActiveMinutes: timeReturn.humanActiveMinutes,
        } : null,
      },
      safeguards: {
        exactPlanApproval: true,
        targetReadBack: true,
        mergePerformed: false,
        deploymentPerformed: false,
        productionSendingEnabled: false,
        proactiveWorkEnabled: false,
      },
    };
    return sealValidationEvidence(core);
  }

  async cancel(id, { planHash }) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Activation session not found");
    const planId = `plan_${session.candidate.assessment.planHash.slice(0, 24)}`;
    const plan = await session.store.getWorkPlan(planId);
    if (!plan || plan.plan_hash !== planHash) {
      throw new Error("Activation plan changed; review the current plan again");
    }
    const status = await session.store.requestWorkPlanCancellation(
      planId,
      session.candidate.preview.project.requesterId,
    );
    return { sessionId: id, status };
  }

  async close() {
    await Promise.all([...this.sessions.values()].map((session) => session.store.close()));
    this.sessions.clear();
  }
}

async function resolveExecutable(configured, candidates, label) {
  const values = configured ? [configured] : candidates;
  for (const value of values) {
    if (!isAbsolute(value)) {
      if (configured) throw new Error(`${label} path must be absolute`);
      continue;
    }
    try {
      const resolved = await realpath(value);
      await access(resolved, constants.X_OK);
      return resolved;
    } catch {
      // Try the next fixed candidate without using PATH lookup.
    }
  }
  throw new Error(`${label} executable is unavailable; configure its absolute path`);
}

export function createDefaultActivationExecutionCoordinator({
  workingDirectory = process.cwd(),
  modelProvider = null,
  environment = process.env,
} = {}) {
  const home = homedir();
  return new ActivationExecutionCoordinator({
    sessionRoot: join(workingDirectory, ".runtime", "activation-sessions"),
    artifactRuntimeFactory: async (runtime) => {
      if (runtime === "codex") {
        const codexPath = await resolveExecutable(environment.CODEX_PATH, [
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          join(home, ".local", "bin", "codex"),
        ], "Codex");
        return createStructuredArtifactRuntime({ runtime, codexPath, environment });
      }
      if (runtime === "claude-code") {
        const claudeCodePath = await resolveExecutable(environment.CLAUDE_CODE_PATH, [
          join(home, ".local", "bin", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
        ], "Claude Code");
        return createStructuredArtifactRuntime({ runtime, claudeCodePath, environment });
      }
      return createStructuredArtifactRuntime({ runtime, modelProvider, environment });
    },
    ghPathProvider: () => resolveExecutable(environment.GH_PATH, [
      "/opt/homebrew/bin/gh",
      "/usr/local/bin/gh",
      join(home, ".local", "bin", "gh"),
    ], "GitHub CLI"),
  });
}
