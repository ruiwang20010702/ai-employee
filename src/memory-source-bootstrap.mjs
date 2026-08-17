import { execFile } from "node:child_process";
import {
  access,
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveGbrainPath } from "./gbrain-page.mjs";

const execFileAsync = promisify(execFile);
export const memorySourceId = "foursday";

const readmes = Object.freeze({
  "README.md": `# Foursday memory source

This private Git repository stores governed Markdown memory for one Foursday installation.

| Directory | Purpose |
|---|---|
| atoms/ | Source-bound atomic facts and import receipts |
| conversations/ | Reusable conversation, meeting, delivery, and decision episodes |
| people/ | Public roles, responsibilities, and collaboration relationships |
| preferences/ | Stable communication and working preferences |
| projects/ | Project goals, decisions, milestones, risks, and deliverables |
| concepts/ | Principles, methods, terminology, and knowledge |
| prospective/ | Commitments, goals, reminders, and follow-up intents |

Working memory remains in Foursday PostgreSQL. Credentials, PII, sensitive person assessments, and confidential candidates are prohibited.
`,
  ".gitignore": ".DS_Store\n**/.DS_Store\n",
  "atoms/README.md": "# Atomic facts\n\nOnly source-bound, governed facts and import receipts belong here. Automated writes are confined to `atoms/foursday/`.\n",
  "conversations/README.md": "# Episodic memory\n\nStore reusable summaries of conversations, meetings, deliveries, and decisions; never bulk-copy raw transcripts.\n",
  "people/README.md": "# People memory\n\nStore only public roles, responsibilities, collaboration relationships, and stable working style. PII and subjective assessments are prohibited.\n",
  "preferences/README.md": "# Preference memory\n\nStore stable communication and working preferences supported by explicit statements or repeated evidence.\n",
  "projects/README.md": "# Project memory\n\nStore project identity, goals, stages, decisions, milestones, risks, dependencies, roles, deliverables, and ongoing intents.\n",
  "concepts/README.md": "# Principles and knowledge\n\nStore reusable principles, methods, terminology, and scoped domain knowledge with provenance.\n",
  "prospective/README.md": "# Prospective memory\n\nStore readable commitments, goals, reminders, and follow-up intents. PostgreSQL remains authoritative for scheduling and completion state.\n",
});

function within(root, target) {
  const difference = relative(root, target);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

async function writeExact(path, content) {
  const existing = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("Memory source skeleton contains an unsafe file");
    }
    if (await readFile(path, "utf8") !== content) {
      throw new Error("Memory source skeleton file already exists with different content");
    }
    return false;
  }
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

async function safeDirectory(root, relativePath) {
  let current = root;
  for (const part of relativePath.split("/").filter(Boolean)) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Memory source path contains a symbolic link or non-directory");
    }
  }
}

export function memorySourceBootstrapPlan({
  configPath,
  root,
  sourceId = memorySourceId,
} = {}) {
  if (!/^foursday(?:-[a-z0-9]{4,32})?$/u.test(sourceId) || sourceId === "default") {
    throw new Error("Memory source id must use the isolated foursday namespace");
  }
  const configDirectory = dirname(resolve(configPath));
  const target = resolve(root ?? join(configDirectory, "gbrain", "brain"));
  if (!within(configDirectory, target)) {
    throw new Error("Memory source root must remain under the configuration directory");
  }
  return {
    schema: "foursday-memory-source-bootstrap/v1",
    sourceId,
    root: target,
    federated: false,
    directories: ["atoms", "conversations", "people", "preferences", "projects", "concepts", "prospective"],
    markdownFiles: Object.keys(readmes),
    writeEnabled: false,
    autoConfirm: false,
  };
}

async function runGit(args, cwd, run = execFileAsync) {
  return run("/usr/bin/git", args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

export async function initializeMemorySource({
  configPath,
  root,
  sourceId = memorySourceId,
  gbrainPath = "gbrain",
  run = execFileAsync,
} = {}) {
  const plan = memorySourceBootstrapPlan({ configPath, root, sourceId });
  const configDirectory = dirname(resolve(configPath));
  await safeDirectory(configDirectory, relative(configDirectory, plan.root));
  const canonical = await realpath(plan.root);
  const canonicalConfigDirectory = await realpath(configDirectory);
  if (!within(canonicalConfigDirectory, canonical)) {
    throw new Error("Memory source root identity changed");
  }
  plan.root = canonical;
  let createdFiles = 0;
  for (const [relativePath, content] of Object.entries(readmes)) {
    const destination = resolve(plan.root, relativePath);
    if (!within(plan.root, destination)) throw new Error("Memory source file escapes root");
    await safeDirectory(plan.root, dirname(relativePath) === "." ? "" : dirname(relativePath));
    if (await writeExact(destination, content)) createdFiles += 1;
  }
  const gitDirectory = join(plan.root, ".git");
  const hasGit = await lstat(gitDirectory).then(
    (metadata) => metadata.isDirectory() && !metadata.isSymbolicLink(),
  ).catch(() => false);
  if (!hasGit) await runGit(["init", "-b", "main"], plan.root, run);
  await runGit(["add", ".gitignore", ...Object.keys(readmes).filter((path) => path !== ".gitignore")], plan.root, run);
  const staged = await runGit(["diff", "--cached", "--quiet"], plan.root, run)
    .then(() => false)
    .catch((error) => {
      if (error.code === 1) return true;
      throw error;
    });
  if (staged) {
    await runGit([
      "-c", "user.name=Foursday",
      "-c", "user.email=foursday@local.invalid",
      "commit", "-m", "Initialize isolated memory source",
    ], plan.root, run);
  }
  let executable;
  try {
    executable = run === execFileAsync
      ? await resolveGbrainPath(gbrainPath)
      : gbrainPath;
  } catch {
    return {
      ...plan,
      created: true,
      createdFiles,
      gitInitialized: true,
      registered: false,
      registrationPending: "gbrain_unavailable",
    };
  }
  let registered = false;
  try {
    await run(executable, [
      "sources", "add", plan.sourceId,
      "--path", plan.root,
      "--name", "Foursday memory",
      "--no-federated",
    ], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { PATH: dirname(executable) + ":/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    registered = true;
  } catch (error) {
    const message = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    if (!/already exists|already registered/iu.test(message)) throw error;
    registered = true;
  }
  await access(plan.root, constants.R_OK | constants.W_OK);
  return {
    ...plan,
    created: true,
    createdFiles,
    gitInitialized: true,
    registered,
    registrationPending: null,
  };
}

export function memorySourceConfigValues(plan) {
  return {
    AI_EMPLOYEE_MEMORY_AUTHORITY_MODE: "gbrain",
    AI_EMPLOYEE_MEMORY_AUTHORITY_ROOT: plan.root,
    AI_EMPLOYEE_MEMORY_AUTHORITY_SOURCE_ID: plan.sourceId,
    AI_EMPLOYEE_MEMORY_AUTHORITY_WRITE: false,
    AI_EMPLOYEE_MEMORY_AUTHORITY_AUTO_CONFIRM: false,
  };
}
