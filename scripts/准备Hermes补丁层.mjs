import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  readFile,
  realpath,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertHermesRuntimeRoot } from "../src/hermes-candidate.mjs";
import { validateHermesPatchLock } from "../src/hermes-patches.mjs";
import {
  hermesRuntimeLayout,
  validateHermesUpstreamLock,
} from "../src/hermes-upstream.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--apply")) {
  throw new Error("Usage: node scripts/准备Hermes补丁层.mjs [--apply]");
}
const apply = args.includes("--apply");

function environment(state) {
  return {
    HOME: state,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CI: "1",
    NO_COLOR: "1",
  };
}

async function command(commandArgs, options = {}) {
  return execFileAsync("/usr/bin/git", commandArgs, {
    cwd: projectRoot,
    env: options.env,
    timeout: options.timeout ?? 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function isDirectory(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error("Hermes patched checkout cannot be a symbolic link");
    }
    return metadata.isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const upstreamLock = validateHermesUpstreamLock(JSON.parse(await readFile(
  join(projectRoot, "hermes", "upstream.lock.json"),
  "utf8",
)));
const patchLock = validateHermesPatchLock(JSON.parse(await readFile(
  join(projectRoot, "hermes", "patches.lock.json"),
  "utf8",
)));
if (patchLock.baseCommit !== upstreamLock.commit) {
  throw new Error("Hermes patch lock does not target the upstream lock commit");
}
for (const patch of patchLock.patches) {
  const patchPath = resolve(projectRoot, patch.path);
  const difference = relative(projectRoot, patchPath);
  if (difference.startsWith("..") || await sha256(patchPath) !== patch.sha256) {
    throw new Error("Hermes patch file identity does not match the lock");
  }
}
const layout = hermesRuntimeLayout(projectRoot);
await assertHermesRuntimeRoot(projectRoot, layout.patched);
const gitEnv = environment(layout.state);

if (!apply) {
  console.log(JSON.stringify({
    valid: true,
    apply: false,
    baseCommit: patchLock.baseCommit,
    patchCount: patchLock.patches.length,
    upstreamWrite: false,
    productionWrite: false,
  }));
  process.exit(0);
}

await access(join(layout.source, ".git"), constants.R_OK);
const { stdout: upstreamHead } = await command(
  ["-C", layout.source, "rev-parse", "HEAD"],
  { env: gitEnv },
);
const { stdout: upstreamStatus } = await command(
  ["-C", layout.source, "status", "--porcelain"],
  { env: gitEnv },
);
if (upstreamHead.trim() !== upstreamLock.commit || upstreamStatus.trim()) {
  throw new Error("Hermes upstream checkout is not the clean locked base");
}

if (!(await isDirectory(layout.patched))) {
  await command(
    ["clone", "--shared", "--no-checkout", layout.source, layout.patched],
    { env: gitEnv },
  );
  await command(
    ["-C", layout.patched, "remote", "set-url", "origin", upstreamLock.repository],
    { env: gitEnv },
  );
  await command(
    ["-C", layout.patched, "sparse-checkout", "init", "--no-cone"],
    { env: gitEnv },
  );
  await command(
    [
      "-C", layout.patched, "sparse-checkout", "set",
      "/*", "!/contributors/emails/",
    ],
    { env: gitEnv },
  );
  await command(
    ["-C", layout.patched, "checkout", "--detach", upstreamLock.commit],
    { env: gitEnv },
  );
}

const { stdout: patchedHead } = await command(
  ["-C", layout.patched, "rev-parse", "HEAD"],
  { env: gitEnv },
);
if (patchedHead.trim() !== upstreamLock.commit) {
  throw new Error("Hermes patched checkout base commit is incorrect");
}
const { stdout: beforeDiff } = await command(
  ["-C", layout.patched, "diff", "--binary"],
  { env: gitEnv },
);
if (!beforeDiff.trim()) {
  for (const patch of patchLock.patches) {
    await command(
      ["-C", layout.patched, "apply", resolve(projectRoot, patch.path)],
      { env: gitEnv },
    );
  }
}
await command(["-C", layout.patched, "diff", "--check"], { env: gitEnv });
const { stdout: diff } = await command(
  ["-C", layout.patched, "diff", "--binary"],
  { env: gitEnv },
);
const expectedPatch = patchLock.patches.map((patch) =>
  readFile(resolve(projectRoot, patch.path), "utf8")
);
const expectedDiff = (await Promise.all(expectedPatch)).join("");
if (diff !== expectedDiff) {
  throw new Error("Hermes patched checkout differs from the locked patch set");
}
const { stdout: status } = await command(
  ["-C", layout.patched, "status", "--porcelain"],
  { env: gitEnv },
);
const changedFiles = status.split("\n").filter(Boolean).map((line) => line.slice(3));
const expectedFiles = [
  "gateway/platforms/base.py",
  "gateway/run.py",
  "gateway/session.py",
];
if (JSON.stringify(changedFiles.sort()) !== JSON.stringify(expectedFiles.sort())) {
  throw new Error("Hermes patched checkout changed unexpected files");
}

console.log(JSON.stringify({
  valid: true,
  apply: true,
  baseCommit: patchLock.baseCommit,
  patchCount: patchLock.patches.length,
  changedFileCount: changedFiles.length,
  upstreamWrite: false,
  productionWrite: false,
}));
