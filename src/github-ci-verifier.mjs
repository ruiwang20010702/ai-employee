import { execFileSync } from "node:child_process";

export const requiredWorkflows = Object.freeze([
  Object.freeze({ file: "check.yml", name: "检查", releaseEvents: ["push"] }),
  Object.freeze({ file: "security.yml", name: "安全扫描", releaseEvents: ["push"] }),
]);

function defaultRun(command, args, { cwd }) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

export function validateBranchRef(value) {
  const ref = String(value ?? "").trim();
  if (
    !ref ||
    ref.length > 200 ||
    !/^[A-Za-z0-9._/-]+$/u.test(ref) ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.includes("..") ||
    ref.includes("//")
  ) {
    throw new Error("分支名称不合法");
  }
  return ref;
}

export function validateCommitSha(value) {
  const sha = String(value ?? "");
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error("提交编号必须是完整的 40 位小写 SHA");
  }
  return sha;
}

export function validateCompletedRun(
  run,
  expectedSha,
  expectedName,
  { workflowDatabaseId = null, allowedEvents = null } = {},
) {
  if (!run || run.name !== expectedName) {
    throw new Error(`缺少工作流结果：${expectedName}`);
  }
  if (run.headSha !== expectedSha) {
    throw new Error(`工作流提交不匹配：${expectedName}`);
  }
  if (
    workflowDatabaseId != null &&
    Number(run.workflowDatabaseId) !== Number(workflowDatabaseId)
  ) {
    throw new Error(`工作流身份不匹配：${expectedName}`);
  }
  if (allowedEvents && !allowedEvents.includes(run.event)) {
    throw new Error(`工作流触发来源不允许：${expectedName}`);
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(`工作流未成功：${expectedName}`);
  }
  if (!Number.isSafeInteger(Number(run.databaseId)) || Number(run.databaseId) <= 0) {
    throw new Error(`工作流编号无效：${expectedName}`);
  }
  return {
    name: run.name,
    event: run.event,
    runId: Number(run.databaseId),
    url: run.url,
  };
}

export function chooseCurrentRun(
  runs,
  workflowName,
  expectedSha,
  workflowDatabaseId = null,
) {
  const matching = runs.filter(
    (run) => run.name === workflowName && run.headSha === expectedSha &&
      (workflowDatabaseId == null ||
        Number(run.workflowDatabaseId) === Number(workflowDatabaseId)),
  );
  const active = matching.find(
    (run) => run.status === "queued" || run.status === "in_progress",
  );
  if (active) return active;

  const completed = matching.find((run) => run.status === "completed");
  if (completed?.conclusion && completed.conclusion !== "success") {
    throw new Error(`当前提交已有失败工作流：${workflowName}`);
  }
  return completed ?? null;
}

export function chooseReleaseRun(
  runs,
  workflowName,
  expectedSha,
  workflowDatabaseId = null,
  allowedEvents = null,
) {
  const matching = runs
    .filter((run) => run.name === workflowName && run.headSha === expectedSha &&
      (workflowDatabaseId == null ||
        Number(run.workflowDatabaseId) === Number(workflowDatabaseId)) &&
      (allowedEvents == null || allowedEvents.includes(run.event)))
    .sort((left, right) => {
      const timeDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      if (Number.isFinite(timeDifference) && timeDifference !== 0) {
        return timeDifference;
      }
      return Number(right.databaseId) - Number(left.databaseId);
    });
  if (matching.length === 0) {
    throw new Error(`缺少目标提交的工作流结果：${workflowName}`);
  }
  return matching[0];
}

function loadWorkflowIdentity(workflow, run, cwd) {
  let identity;
  try {
    identity = JSON.parse(run(
      "gh",
      ["api", `repos/{owner}/{repo}/actions/workflows/${workflow.file}`],
      { cwd },
    ));
  } catch {
    throw new Error(`无法验证工作流身份：${workflow.name}`);
  }
  if (
    !Number.isSafeInteger(Number(identity?.id)) ||
    Number(identity.id) <= 0 ||
    identity.name !== workflow.name ||
    identity.path !== `.github/workflows/${workflow.file}` ||
    identity.state !== "active"
  ) {
    throw new Error(`工作流身份无效：${workflow.name}`);
  }
  return { ...workflow, workflowDatabaseId: Number(identity.id) };
}

function parseRunId(output, workflowName) {
  const match = String(output).match(/\/actions\/runs\/(\d+)/u);
  const runId = Number(match?.[1]);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error(`无法取得工作流编号：${workflowName}`);
  }
  return runId;
}

export function verifyGitHubCommit({
  cwd = process.cwd(),
  ref,
  run = defaultRun,
} = {}) {
  const dirty = run("git", ["status", "--porcelain"], { cwd });
  if (dirty) throw new Error("工作区不干净，不能验证未提交内容");

  const branch = validateBranchRef(
    ref ?? run("git", ["branch", "--show-current"], { cwd }),
  );
  const headSha = validateCommitSha(run("git", ["rev-parse", "HEAD"], { cwd }));
  const workflows = requiredWorkflows.map((workflow) =>
    loadWorkflowIdentity(workflow, run, cwd));

  const remoteLine = run(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { cwd },
  );
  const remoteSha = remoteLine.split(/\s+/u)[0] ?? "";
  if (remoteSha !== headSha) {
    throw new Error("远端分支与本地当前提交不一致，请先推送");
  }

  const listOutput = run(
    "gh",
    [
      "run",
      "list",
      "--commit",
      headSha,
      "--limit",
      "100",
      "--json",
      "databaseId,name,status,conclusion,event,url,headSha,createdAt,workflowDatabaseId,workflowName",
    ],
    { cwd },
  );
  const runs = JSON.parse(listOutput || "[]");
  const selected = [];

  for (const workflow of workflows) {
    const existing = chooseCurrentRun(
      runs,
      workflow.name,
      headSha,
      workflow.workflowDatabaseId,
    );
    if (existing) {
      selected.push({ workflow, runId: Number(existing.databaseId), reused: true });
      continue;
    }
    const dispatchOutput = run(
      "gh",
      ["workflow", "run", workflow.file, "--ref", branch],
      { cwd },
    );
    selected.push({
      workflow,
      runId: parseRunId(dispatchOutput, workflow.name),
      reused: false,
    });
  }

  const results = [];
  for (const item of selected) {
    run("gh", ["run", "watch", String(item.runId), "--exit-status"], { cwd });
    const view = JSON.parse(
      run(
        "gh",
        [
          "run",
          "view",
          String(item.runId),
          "--json",
          "databaseId,name,status,conclusion,event,url,headSha,workflowDatabaseId,workflowName",
        ],
        { cwd },
      ),
    );
    results.push({
      ...validateCompletedRun(view, headSha, item.workflow.name, {
        workflowDatabaseId: item.workflow.workflowDatabaseId,
        allowedEvents: ["push", "workflow_dispatch"],
      }),
      reused: item.reused,
    });
  }

  return {
    valid: true,
    ref: branch,
    headSha,
    workflows: results,
  };
}

export function verifyGitHubReleaseCommit({
  cwd = process.cwd(),
  sha,
  run = defaultRun,
} = {}) {
  const headSha = validateCommitSha(sha);
  const workflows = requiredWorkflows.map((workflow) =>
    loadWorkflowIdentity(workflow, run, cwd));
  const listOutput = run(
    "gh",
    [
      "run",
      "list",
      "--commit",
      headSha,
      "--limit",
      "100",
      "--json",
      "databaseId,name,status,conclusion,event,url,headSha,createdAt,workflowDatabaseId,workflowName",
    ],
    { cwd },
  );
  let runs;
  try {
    runs = JSON.parse(listOutput || "[]");
  } catch {
    throw new Error("GitHub 工作流结果不是有效 JSON");
  }
  if (!Array.isArray(runs)) {
    throw new Error("GitHub 工作流结果格式无效");
  }
  return {
    valid: true,
    headSha,
    workflows: workflows.map((workflow) =>
      validateCompletedRun(
        chooseReleaseRun(
          runs,
          workflow.name,
          headSha,
          workflow.workflowDatabaseId,
          workflow.releaseEvents,
        ),
        headSha,
        workflow.name,
        {
          workflowDatabaseId: workflow.workflowDatabaseId,
          allowedEvents: workflow.releaseEvents,
        },
      )),
  };
}
