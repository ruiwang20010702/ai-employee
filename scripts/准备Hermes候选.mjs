import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
} from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertHermesRuntimeRoot,
  buildHermesCandidatePlan,
} from "../src/hermes-candidate.mjs";
import { validateHermesUpstreamLock } from "../src/hermes-upstream.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some((argument) => !["--apply"].includes(argument))) {
  throw new Error("Usage: node scripts/准备Hermes候选.mjs [--apply]");
}
const apply = args.includes("--apply");

function hostEnvironment() {
  const allowed = [
    "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
    "https_proxy", "http_proxy", "all_proxy", "no_proxy",
  ];
  return {
    ...Object.fromEntries(allowed.flatMap((name) =>
      typeof process.env[name] === "string" ? [[name, process.env[name]]] : []
    )),
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    CI: "1",
    NO_COLOR: "1",
  };
}

async function resolveExecutable(name, candidates) {
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      return realpath(candidate);
    } catch {
      // Try the next fixed candidate.
    }
  }
  throw new Error(`${name} executable is unavailable`);
}

async function command(executable, commandArgs, options = {}) {
  return execFileAsync(executable, commandArgs, {
    cwd: projectRoot,
    timeout: options.timeout ?? 300_000,
    maxBuffer: 8 * 1024 * 1024,
    env: options.env ?? hostEnvironment(),
  });
}

async function existingDirectory(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error("Hermes candidate path cannot be a symbolic link");
    return metadata.isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function verifyCheckout(plan) {
  const { stdout: head } = await command(
    "/usr/bin/git",
    ["-C", plan.layout.source, "rev-parse", "HEAD"],
    { env: plan.environment },
  );
  if (head.trim() !== plan.lock.commit) {
    throw new Error("Hermes candidate HEAD does not match the locked commit");
  }
  const { stdout: remote } = await command(
    "/usr/bin/git",
    ["-C", plan.layout.source, "remote", "get-url", "origin"],
    { env: plan.environment },
  );
  if (remote.trim() !== plan.lock.repository) {
    throw new Error("Hermes candidate origin does not match the official repository");
  }
  const { stdout: status } = await command(
    "/usr/bin/git",
    ["-C", plan.layout.source, "status", "--porcelain"],
    { env: plan.environment },
  );
  if (status.trim()) throw new Error("Hermes candidate checkout is not clean");
  const license = await readFile(join(plan.layout.source, "LICENSE"));
  const licenseSha256 = createHash("sha256").update(license).digest("hex");
  if (licenseSha256 !== plan.lock.licenseSha256) {
    throw new Error("Hermes candidate LICENSE digest does not match the lock");
  }
}

const lock = validateHermesUpstreamLock(JSON.parse(await readFile(
  join(projectRoot, "hermes", "upstream.lock.json"),
  "utf8",
)));
const uvPath = await resolveExecutable("uv", [
  process.env.UV_PATH,
  "/opt/homebrew/bin/uv",
  "/usr/local/bin/uv",
]);
const { stdout: pythonOutput } = await command(
  uvPath,
  ["python", "find", "3.13"],
  { timeout: 30_000 },
);
const pythonPath = await resolveExecutable("Python 3.13", [pythonOutput.trim()]);
const plan = buildHermesCandidatePlan({
  projectRoot,
  lock,
  uvPath,
  pythonPath,
});
await assertHermesRuntimeRoot(projectRoot, plan.layout.root);

if (!apply) {
  console.log(JSON.stringify({
    valid: true,
    apply: false,
    release: lock.release,
    commit: lock.commit,
    operationCount: plan.commands.length,
    productionWrite: false,
    existingHermesTouched: false,
  }));
  process.exit(0);
}

await mkdir(plan.layout.root, { recursive: true, mode: 0o700 });
await chmod(plan.layout.root, 0o700);
await Promise.all([
  mkdir(plan.layout.state, { recursive: true, mode: 0o700 }),
  mkdir(join(plan.layout.root, "uv-cache"), { recursive: true, mode: 0o700 }),
]);
await Promise.all([
  chmod(plan.layout.state, 0o700),
  chmod(join(plan.layout.root, "uv-cache"), 0o700),
]);

const sourceExists = await existingDirectory(plan.layout.source);
if (!sourceExists) {
  for (const operation of plan.commands.slice(0, 6)) {
    await command(operation.executable, operation.args, {
      env: plan.environment,
      timeout: 300_000,
    });
  }
} else {
  const entries = await readdir(plan.layout.source);
  if (!entries.includes(".git")) {
    throw new Error("Hermes candidate source directory exists without a Git checkout");
  }
  for (const operation of plan.commands.slice(3, 5)) {
    await command(operation.executable, operation.args, {
      env: plan.environment,
      timeout: 300_000,
    });
  }
}
await verifyCheckout(plan);

const venvExists = await existingDirectory(plan.layout.venv);
if (!venvExists) {
  const operation = plan.commands[6];
  await command(operation.executable, operation.args, {
    env: plan.environment,
    timeout: 300_000,
  });
}
const sync = plan.commands[7];
await command(sync.executable, sync.args, {
  env: plan.environment,
  timeout: 1_800_000,
});
await verifyCheckout(plan);

const candidatePython = join(plan.layout.venv, "bin", "python");
await access(candidatePython, constants.X_OK);
const { stdout: installedVersion } = await command(candidatePython, [
  "-c",
  "import importlib.metadata as m; print(m.version('hermes-agent'))",
], {
  env: plan.environment,
  timeout: 30_000,
});
if (installedVersion.trim() !== lock.version) {
  throw new Error("Installed Hermes version does not match the upstream lock");
}

console.log(JSON.stringify({
  valid: true,
  apply: true,
  release: lock.release,
  commit: lock.commit,
  version: installedVersion.trim(),
  isolated: true,
  productionWrite: false,
  existingHermesTouched: false,
}));
