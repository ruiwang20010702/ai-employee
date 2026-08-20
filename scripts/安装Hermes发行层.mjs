import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hermesRuntimeLayout } from "../src/hermes-upstream.mjs";
import { assertHermesRuntimeRoot } from "../src/hermes-candidate.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--apply")) {
  throw new Error("Usage: node scripts/安装Hermes发行层.mjs [--apply]");
}
const apply = args.includes("--apply");
const layout = hermesRuntimeLayout(projectRoot);
const hermesHome = join(layout.state, ".hermes");
await assertHermesRuntimeRoot(projectRoot, layout.root);

const components = [
  {
    id: "dws-personal",
    source: join(projectRoot, "hermes/plugins/dws_personal"),
    target: join(hermesHome, "plugins/dws-personal"),
    plugin: "dws-personal-platform",
  },
  {
    id: "project-router",
    source: join(projectRoot, "hermes/plugins/project_router"),
    target: join(hermesHome, "plugins/project_router"),
    plugin: "foursday-project-router",
  },
  {
    id: "high-risk-boundary",
    source: join(projectRoot, "hermes/plugins/foursday_boundary"),
    target: join(hermesHome, "plugins/foursday-high-risk-boundary"),
    plugin: "foursday-high-risk-boundary",
  },
  {
    id: "personal-gbrain-memory",
    source: join(projectRoot, "hermes/plugins/gbrain_memory"),
    target: join(hermesHome, "plugins/foursday-gbrain-memory"),
    plugin: "foursday-gbrain-memory",
  },
  {
    id: "profile",
    source: join(projectRoot, "hermes/profile/SOUL.md"),
    target: join(hermesHome, "SOUL.md"),
  },
  {
    id: "project-work-skill",
    source: join(projectRoot, "hermes/skills/project-work"),
    target: join(hermesHome, "skills/foursday-project-work"),
  },
];

function safeEnvironment() {
  const allowed = Object.fromEntries(
    ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"]
      .filter((name) => typeof process.env[name] === "string")
      .map((name) => [name, process.env[name]]),
  );
  return {
    ...allowed,
    HERMES_HOME: hermesHome,
    PYTHONPATH: layout.patched,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    NO_COLOR: "1",
  };
}

async function pathMetadata(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function validateSource(path, root = path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error("Hermes distribution source cannot contain symbolic links");
  }
  if (metadata.isFile()) {
    if (metadata.size > 1024 * 1024) {
      throw new Error("Hermes distribution source file is too large");
    }
    const name = basename(path);
    if (name.endsWith(".pyc") || relative(root, path).includes("__pycache__")) {
      throw new Error("Hermes distribution source contains a Python cache");
    }
    return 1;
  }
  if (!metadata.isDirectory()) {
    throw new Error("Hermes distribution source must be a regular file or directory");
  }
  let files = 0;
  for (const entry of await readdir(path)) {
    if (entry === "__pycache__") continue;
    files += await validateSource(join(path, entry), root);
  }
  return files;
}

async function treeDigest(path) {
  const metadata = await lstat(path);
  if (metadata.isFile()) {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  }
  const hash = createHash("sha256");
  for (const entry of (await readdir(path)).sort()) {
    if (entry === "__pycache__" || entry.endsWith(".pyc")) continue;
    hash.update(entry);
    hash.update(await treeDigest(join(path, entry)));
  }
  return hash.digest("hex");
}

async function protectTree(path) {
  const metadata = await lstat(path);
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await protectTree(join(path, entry));
  } else {
    await chmod(path, 0o600);
  }
}

const fileCounts = {};
for (const component of components) {
  fileCounts[component.id] = await validateSource(component.source);
}

if (!apply) {
  console.log(JSON.stringify({
    valid: true,
    apply: false,
    hermesHome,
    components: components.map(({ id, plugin }) => ({ id, plugin: plugin ?? null })),
    fileCounts,
    productionWrite: false,
  }));
  process.exit(0);
}

const candidatePython = join(layout.venv, "bin/python");
await Promise.all([
  access(candidatePython, constants.X_OK),
  access(join(layout.patched, "hermes_cli/main.py"), constants.R_OK),
]);
await mkdir(hermesHome, { recursive: true, mode: 0o700 });
await chmod(hermesHome, 0o700);
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const backupRoot = join(
  hermesHome,
  "plugin-data/foursday-install-backups",
  stamp,
);
await mkdir(backupRoot, { recursive: true, mode: 0o700 });
await chmod(backupRoot, 0o700);
const installed = [];
const retired = [];

try {
  for (const component of components) {
    await mkdir(dirname(component.target), { recursive: true, mode: 0o700 });
    const staging = join(dirname(component.target), `.${basename(component.target)}.staging-${process.pid}`);
    if (await pathMetadata(staging)) {
      throw new Error("Hermes distribution staging path already exists");
    }
    await cp(component.source, staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (source) => !source.includes("/__pycache__") && !source.endsWith(".pyc"),
    });
    await protectTree(staging);
    const prior = await pathMetadata(component.target);
    const backup = join(backupRoot, component.id);
    if (prior) await rename(component.target, backup);
    await rename(staging, component.target);
    installed.push({ ...component, backup: prior ? backup : null });
    if (await treeDigest(component.source) !== await treeDigest(component.target)) {
      throw new Error("Hermes distribution component digest changed during installation");
    }
  }

  const obsoleteProjectRouter = join(
    hermesHome,
    "plugins/foursday-project-router",
  );
  if (await pathMetadata(obsoleteProjectRouter)) {
    const backup = join(backupRoot, "obsolete-project-router");
    await rename(obsoleteProjectRouter, backup);
    retired.push({ target: obsoleteProjectRouter, backup });
  }

  for (const plugin of components.flatMap((component) => component.plugin ? [component.plugin] : [])) {
    await execFileAsync(candidatePython, [
      "-m", "hermes_cli.main", "plugins", "enable",
      "--no-allow-tool-override", plugin,
    ], {
      cwd: layout.patched,
      env: safeEnvironment(),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  }
} catch (error) {
  const failedRoot = join(backupRoot, "failed-install");
  await mkdir(failedRoot, { recursive: true, mode: 0o700 });
  for (const component of retired.reverse()) {
    if (await pathMetadata(component.backup)) {
      await rename(component.backup, component.target);
    }
  }
  for (const component of installed.reverse()) {
    if (await pathMetadata(component.target)) {
      await rename(component.target, join(failedRoot, component.id));
    }
    if (component.backup && await pathMetadata(component.backup)) {
      await rename(component.backup, component.target);
    }
  }
  throw error;
}

console.log(JSON.stringify({
  valid: true,
  apply: true,
  hermesHome,
  installed: installed.map(({ id, plugin }) => ({ id, plugin: plugin ?? null })),
  backupCreated: installed.some((component) => component.backup),
  productionWrite: false,
}));
