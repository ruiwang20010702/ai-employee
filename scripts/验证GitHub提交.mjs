import { execFileSync } from "node:child_process";
import { isMainModule } from "../src/main-module.mjs";

export const requiredWorkflows = Object.freeze([
  Object.freeze({ file: "check.yml", name: "检查" }),
  Object.freeze({ file: "security.yml", name: "安全扫描" }),
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

export function validateCompletedRun(run, expectedSha, expectedName) {
  if (!run || run.name !== expectedName) {
    throw new Error(`缺少工作流结果：${expectedName}`);
  }
  if (run.headSha !== expectedSha) {
    throw new Error(`工作流提交不匹配：${expectedName}`);
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

export function chooseCurrentRun(runs, workflowName, expectedSha) {
  const matching = runs.filter(
    (run) => run.name === workflowName && run.headSha === expectedSha,
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
  const headSha = run("git", ["rev-parse", "HEAD"], { cwd });
  if (!/^[0-9a-f]{40}$/u.test(headSha)) throw new Error("本地提交编号无效");

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
      "databaseId,name,status,conclusion,event,url,headSha,createdAt",
    ],
    { cwd },
  );
  const runs = JSON.parse(listOutput || "[]");
  const selected = [];

  for (const workflow of requiredWorkflows) {
    const existing = chooseCurrentRun(runs, workflow.name, headSha);
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
          "databaseId,name,status,conclusion,event,url,headSha",
        ],
        { cwd },
      ),
    );
    results.push({
      ...validateCompletedRun(view, headSha, item.workflow.name),
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

if (isMainModule(import.meta.url)) {
  try {
    const refIndex = process.argv.indexOf("--ref");
    const ref = refIndex >= 0 ? process.argv[refIndex + 1] : undefined;
    console.log(JSON.stringify(verifyGitHubCommit({ ref }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ valid: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
