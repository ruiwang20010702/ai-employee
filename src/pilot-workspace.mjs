import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  constants,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { inspectActivationRepository } from "./activation-execution.mjs";

const execFileAsync = promisify(execFile);
const upstreamRepository = "ruiwang20010702/foursday";
const upstreamUrl = `https://github.com/${upstreamRepository}.git`;
const candidateBranch = "main";

function exactSha(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error("pilotSourceSha must be a complete 40-character lowercase commit SHA");
  }
  return normalized;
}

function githubLogin(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(normalized)) {
    throw new Error("GitHub account identity is invalid");
  }
  return normalized.toLowerCase();
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel && !rel.startsWith("..") && !isAbsolute(rel);
}

function pilotCommandEnvironment(executable) {
  const allowed = ["HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"];
  const environment = Object.fromEntries(
    allowed
      .filter((name) => typeof process.env[name] === "string")
      .map((name) => [name, process.env[name]]),
  );
  return {
    ...environment,
    PATH: [dirname(executable), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    CI: "1",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

async function privateDirectory(path, parent) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o700 });
    stat = await lstat(path);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Pilot workspace directory must be a real private directory");
  }
  const canonical = await realpath(path);
  if (canonical !== path || !inside(parent, canonical)) {
    throw new Error("Pilot workspace directory must stay inside the fixed pilot root");
  }
  await chmod(path, 0o700);
  return path;
}

async function defaultGhRun(ghPath, args) {
  try {
    const { stdout } = await execFileAsync(ghPath, args, {
      cwd: homedir(),
      env: pilotCommandEnvironment(ghPath),
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    throw new Error("GitHub CLI could not prepare the authorized pilot fork");
  }
}

async function defaultGhTryRun(ghPath, args) {
  try {
    const { stdout } = await execFileAsync(ghPath, args, {
      cwd: homedir(),
      env: pilotCommandEnvironment(ghPath),
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function defaultGitRun(root, args) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/git", [
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null",
      "-c", "credential.helper=",
      "-C", root,
      ...args,
    ], {
      env: pilotCommandEnvironment("/usr/bin/git"),
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    throw new Error("Git could not prepare the fixed pilot checkout");
  }
}

async function defaultNpmRun({ nodePath, npmCliPath, root }) {
  try {
    await execFileAsync(
      nodePath,
      [npmCliPath, "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: root,
        env: pilotCommandEnvironment(nodePath),
        timeout: 10 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch {
    throw new Error("Locked pilot dependencies could not be installed");
  }
}

async function verifyExistingWorkspace(target, sourceSha, account, repositoryInspector) {
  const snapshot = await repositoryInspector(target);
  if (
    snapshot.repository !== `${account}/foursday` ||
    snapshot.upstreamRepository !== upstreamRepository ||
    snapshot.head !== sourceSha
  ) {
    throw new Error("Existing pilot workspace does not match the authorized fork and commit");
  }
  await access(join(target, "node_modules"), constants.R_OK);
  return snapshot;
}

async function defaultRepositoryInspector(root) {
  return inspectActivationRepository(root, { gitRun: defaultGitRun });
}

export async function prepareFoursdayPilotWorkspace({
  sourceSha,
  confirmForkAndClone,
}, {
  ghPath,
  nodePath = process.execPath,
  npmCliPath = process.env.npm_execpath,
  homeDirectory = homedir(),
  ghRun = defaultGhRun,
  ghTryRun = defaultGhTryRun,
  gitRun = defaultGitRun,
  npmRun = defaultNpmRun,
  repositoryInspector = defaultRepositoryInspector,
} = {}) {
  const commit = exactSha(sourceSha);
  if (confirmForkAndClone !== true) {
    throw new Error("Explicit confirmation is required before creating a fork or local clone");
  }
  if (!isAbsolute(ghPath ?? "") || !isAbsolute(nodePath ?? "") || !isAbsolute(npmCliPath ?? "")) {
    throw new Error("GitHub CLI, Node, and npm must use trusted absolute paths");
  }
  await Promise.all([
    access(ghPath, constants.X_OK),
    access(nodePath, constants.X_OK),
    access(npmCliPath, constants.R_OK),
  ]);
  const canonicalHome = await realpath(homeDirectory);
  const pilotRoot = await privateDirectory(join(canonicalHome, "FoursdayPilot"), canonicalHome);
  const versionRoot = await privateDirectory(join(pilotRoot, commit.slice(0, 12)), pilotRoot);
  const target = join(versionRoot, "foursday");

  const account = githubLogin(await ghRun(ghPath, ["api", "user", "--jq", ".login"]));
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(target) !== target) {
      throw new Error("Existing pilot workspace must be a real directory");
    }
    const snapshot = await verifyExistingWorkspace(
      target,
      commit,
      account,
      repositoryInspector,
    );
    return {
      schema: "foursday-pilot-workspace/v1",
      rootDirectory: target,
      sourceRepository: snapshot.repository,
      upstreamRepository: snapshot.upstreamRepository,
      startingCommit: snapshot.head,
      branch: (await gitRun(target, ["branch", "--show-current"])).trim(),
      forkCreated: false,
      cloneCreated: false,
      dependenciesInstalled: true,
      externalEffects: [],
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const forkViewArguments = [
    "repo",
    "view",
    `${account}/foursday`,
    "--json",
    "nameWithOwner,isFork,parent",
  ];
  let forkCreated = false;
  let forkRaw = await ghTryRun(ghPath, forkViewArguments);
  if (!forkRaw) {
    await ghRun(ghPath, ["repo", "fork", upstreamRepository, "--fork-name", "foursday"]);
    forkCreated = true;
    forkRaw = await ghRun(ghPath, forkViewArguments);
  }
  const fork = JSON.parse(forkRaw);
  if (
    fork?.isFork !== true ||
    String(fork.nameWithOwner ?? "").toLowerCase() !== `${account}/foursday` ||
    String(fork.parent?.nameWithOwner ?? "").toLowerCase() !== upstreamRepository
  ) {
    throw new Error("GitHub fork read-back does not match the fixed upstream repository");
  }

  const staging = join(versionRoot, `foursday-preparing-${randomUUID()}`);
  const branch = `pilot-v0.5-${commit.slice(0, 12)}`;
  try {
    await ghRun(ghPath, [
      "repo", "clone", `${account}/foursday`, staging,
      "--no-upstream", "--", "--no-tags",
    ]);
    await gitRun(staging, ["remote", "add", "upstream", upstreamUrl]);
    await gitRun(staging, ["fetch", "--no-tags", "upstream", candidateBranch]);
    const fetched = await gitRun(staging, ["rev-parse", "FETCH_HEAD"]);
    await gitRun(staging, ["merge-base", "--is-ancestor", commit, fetched]);
    await gitRun(staging, ["switch", "--create", branch, commit]);
    await npmRun({ nodePath, npmCliPath, root: staging });

    const metadata = JSON.parse(await readFile(join(staging, "package.json"), "utf8"));
    if (metadata.name !== "foursday-runtime" || metadata.version !== "0.5.0") {
      throw new Error("Pilot checkout package identity does not match Foursday v0.5");
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  const snapshot = await repositoryInspector(target);
  if (
    snapshot.repository !== `${account}/foursday` ||
    snapshot.upstreamRepository !== upstreamRepository ||
    snapshot.head !== commit
  ) {
    throw new Error("Prepared pilot workspace failed repository read-back");
  }
  return {
    schema: "foursday-pilot-workspace/v1",
    rootDirectory: target,
    sourceRepository: snapshot.repository,
    upstreamRepository: snapshot.upstreamRepository,
    startingCommit: snapshot.head,
    branch,
    forkCreated,
    cloneCreated: true,
    dependenciesInstalled: true,
    externalEffects: [
      ...(forkCreated ? ["github_fork"] : []),
      "local_clone",
      "locked_dependency_install",
    ],
  };
}

export const foursdayPilotWorkspacePolicy = Object.freeze({
  upstreamRepository,
  candidateBranch,
  destination: "~/FoursdayPilot/<commit-prefix>/foursday",
});
