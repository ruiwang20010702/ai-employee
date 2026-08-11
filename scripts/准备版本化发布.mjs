import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readlink,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, parse, relative, resolve, join } from "node:path";
import { isMainModule } from "../src/main-module.mjs";

const deploymentRootNames = new Set(["foursday-production", "ai-employee-production"]);

function cleanScalar(value, name, pattern) {
  const normalized = String(value ?? "");
  if (!pattern.test(normalized) || /[\0\r\n]/u.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function inside(parent, child) {
  const difference = relative(parent, child);
  return Boolean(difference) &&
    !difference.startsWith("..") &&
    !isAbsolute(difference);
}

async function protectedRelease(path) {
  const [packageMetadata, configMetadata] = await Promise.all([
    stat(join(path, "package.json")),
    stat(join(path, ".runtime", "production.json")),
  ]);
  if (!packageMetadata.isFile() || !configMetadata.isFile()) {
    throw new Error("Release package or production config is unavailable");
  }
  if ((configMetadata.mode & 0o077) !== 0) {
    throw new Error("Release production config permissions are too broad");
  }
}

async function deploymentRoot(rootInput, { create = false } = {}) {
  if (
    typeof rootInput !== "string" ||
    !isAbsolute(rootInput) ||
    /[\0\r\n]/u.test(rootInput)
  ) {
    throw new Error("Deployment root must be a safe absolute path");
  }
  const normalized = resolve(rootInput);
  if (
    normalized === parse(normalized).root ||
    normalized === resolve(homedir()) ||
    !deploymentRootNames.has(basename(normalized))
  ) {
    throw new Error("Deployment root is too broad");
  }
  if (create) await mkdir(normalized, { recursive: true, mode: 0o700 });
  const root = await realpath(normalized);
  if (
    root === parse(root).root ||
    root === resolve(homedir()) ||
    !deploymentRootNames.has(basename(root))
  ) {
    throw new Error("Resolved deployment root is too broad");
  }
  await chmod(root, 0o700);
  return root;
}

async function previousRelease(root, releases) {
  const current = join(root, "current");
  let metadata;
  try {
    metadata = await lstat(current);
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
  if (!metadata.isSymbolicLink()) {
    throw new Error("Current release marker must remain a symbolic link");
  }
  const target = await realpath(current).catch(() => {
    throw new Error("Current release marker is broken");
  });
  if (!inside(releases, target)) {
    throw new Error("Current release escaped the approved releases directory");
  }
  await protectedRelease(target);
  return target;
}

export async function prepareVersionedRelease({
  root: rootInput,
  sha,
  runId,
  attempt,
  environmentFile,
} = {}) {
  const releaseSha = cleanScalar(sha, "Deployment SHA", /^[0-9a-f]{40}$/u);
  const releaseRunId = cleanScalar(runId, "Run ID", /^[0-9]{1,30}$/u);
  const releaseAttempt = cleanScalar(attempt, "Run attempt", /^[0-9]{1,10}$/u);
  if (!environmentFile || !isAbsolute(environmentFile)) {
    throw new Error("GitHub environment file must be an absolute path");
  }
  const root = await deploymentRoot(rootInput, { create: true });
  const releases = join(root, "releases");
  await mkdir(releases, { recursive: true, mode: 0o700 });
  await chmod(releases, 0o700);
  const previous = await previousRelease(root, await realpath(releases));
  const releaseDirectory = join(
    releases,
    `${releaseSha}-${releaseRunId}-${releaseAttempt}`,
  );
  await mkdir(releaseDirectory, { mode: 0o700 });
  await appendFile(
    environmentFile,
    `AI_EMPLOYEE_RELEASE_DIRECTORY=${releaseDirectory}\n` +
      `AI_EMPLOYEE_PREVIOUS_RELEASE=${previous}\n`,
    "utf8",
  );
  return {
    prepared: true,
    releaseDirectory,
    hasPreviousRelease: Boolean(previous),
  };
}

export async function activateVersionedRelease({
  root: rootInput,
  releaseDirectory: releaseInput,
  runId,
  attempt,
  verifyActivation = async ({ current, release }) => {
    const activated = await realpath(current);
    if (activated !== release || (await readlink(current)) !== release) {
      throw new Error("Current release verification failed");
    }
  },
} = {}) {
  const releaseRunId = cleanScalar(runId, "Run ID", /^[0-9]{1,30}$/u);
  const releaseAttempt = cleanScalar(attempt, "Run attempt", /^[0-9]{1,10}$/u);
  const root = await deploymentRoot(rootInput);
  const releases = await realpath(join(root, "releases"));
  const release = await realpath(releaseInput);
  if (!inside(releases, release)) {
    throw new Error("Release directory escaped the approved root");
  }
  await protectedRelease(release);
  const current = join(root, "current");
  let previous = null;
  try {
    const metadata = await lstat(current);
    if (!metadata.isSymbolicLink()) {
      throw new Error("Current release marker must remain a symbolic link");
    }
    previous = await realpath(current).catch(() => {
      throw new Error("Current release marker is broken");
    });
    if (!inside(releases, previous)) {
      throw new Error("Current release escaped the approved releases directory");
    }
    await protectedRelease(previous);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = join(root, `.current-${releaseRunId}-${releaseAttempt}`);
  try {
    await symlink(release, temporary);
    await rename(temporary, current);
    await verifyActivation({ current, release });
  } catch (error) {
    try {
      if (previous) {
        const rollback = `${temporary}-rollback`;
        await unlink(rollback).catch((cleanupError) => {
          if (cleanupError.code !== "ENOENT") throw cleanupError;
        });
        await symlink(previous, rollback);
        await rename(rollback, current);
      } else {
        await unlink(current).catch((cleanupError) => {
          if (cleanupError.code !== "ENOENT") throw cleanupError;
        });
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Current release verification and rollback both failed",
      );
    }
    throw error;
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return { activated: true, releaseDirectory: release };
}

function argument(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return args[index + 1];
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const command = args.shift();
  const common = {
    root: argument(args, "--root"),
    runId: argument(args, "--run-id"),
    attempt: argument(args, "--attempt"),
  };
  let result;
  if (command === "prepare") {
    result = await prepareVersionedRelease({
      ...common,
      sha: argument(args, "--sha"),
      environmentFile: argument(args, "--github-env"),
    });
  } else if (command === "activate") {
    result = await activateVersionedRelease({
      ...common,
      releaseDirectory: argument(args, "--release"),
    });
  } else {
    throw new Error("Usage: 准备版本化发布.mjs <prepare|activate> [options]");
  }
  console.log(JSON.stringify(result));
}
