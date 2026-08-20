import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { readGbrainPage } from "./gbrain-page.mjs";
import {
  renderPersonalGbrainCandidate,
  verifyPersonalGbrainCandidateEvidence,
} from "./personal-gbrain-candidate.mjs";

const execFileAsync = promisify(execFile);
const branchPattern = /^[A-Za-z0-9._/-]{1,120}$/u;

function gitEnvironment(home = process.env.HOME) {
  if (typeof home !== "string" || !isAbsolute(home)) {
    throw new Error("personal gbrain writer HOME must be absolute");
  }
  return {
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_AUTHOR_NAME: "Foursday Memory Broker",
    GIT_AUTHOR_EMAIL: "foursday-memory@localhost",
    GIT_COMMITTER_NAME: "Foursday Memory Broker",
    GIT_COMMITTER_EMAIL: "foursday-memory@localhost",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function credentialFreeGitRemote(value, { allowFileRemote = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("personal gbrain Git remote is invalid");
  }
  if (allowFileRemote && url.protocol === "file:") return url.href;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname !== "github.com"
  ) throw new Error("personal gbrain Git remote must be credential-free GitHub HTTPS");
  return url.href.replace(/\/$/u, "");
}

export async function verifyPrivatePersonalGbrainRemote(remoteUrl, {
  ghPath,
  home = process.env.HOME,
  run = execFileAsync,
  allowFileRemote = false,
} = {}) {
  const remote = credentialFreeGitRemote(remoteUrl, { allowFileRemote });
  if (remote.startsWith("file:")) return { private: true, localFixture: true };
  if (typeof ghPath !== "string" || !isAbsolute(ghPath)) {
    throw new Error("Private personal gbrain Git requires an absolute gh executable");
  }
  await access(ghPath, constants.X_OK);
  const parsed = new URL(remote);
  const repository = parsed.pathname.replace(/^\//u, "").replace(/\.git$/u, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("Private personal gbrain repository identity is invalid");
  }
  const { stdout } = await run(ghPath, [
    "repo", "view", repository,
    "--json", "visibility",
    "--jq", ".visibility",
  ], {
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    },
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });
  if (String(stdout).trim().toUpperCase() !== "PRIVATE") {
    throw new Error("Personal gbrain Git remote must be PRIVATE");
  }
  return { private: true, localFixture: false };
}

async function runGit(run, args, { cwd, env, timeout = 120_000 } = {}) {
  return run("/usr/bin/git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    ...args,
  ], { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 });
}

async function canonicalManagedDirectory(path, label) {
  const lexical = resolve(path);
  const metadata = await lstat(lexical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a canonical directory`);
  }
  const canonical = await realpath(lexical);
  if (canonical !== lexical) throw new Error(`${label} must not use a symlink`);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} must be private`);
  return canonical;
}

async function acquireLock(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("personal gbrain promotion is already running");
    throw error;
  }
  return async () => {
    const entries = await import("node:fs/promises");
    await entries.rmdir(path).catch(() => {});
  };
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let current = dirname(path);
  while (true) {
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("personal gbrain writer path contains a symlink");
    }
    if (current === dirname(dirname(dirname(path)))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const existing = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("personal gbrain candidate destination is unsafe");
    }
    const prior = await readFile(path, "utf8");
    if (prior !== content) throw new Error("personal gbrain candidate conflicts with an existing page");
    return false;
  }
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return true;
}

async function atomicReplaceExpected(path, content, expectedSha256) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("personal gbrain authority page is unsafe");
  }
  const current = await readFile(path, "utf8");
  if (createHash("sha256").update(current).digest("hex") !== expectedSha256) {
    throw new Error("personal gbrain authority page changed outside Foursday");
  }
  const temporary = `${path}.retire-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function frontmatterValue(content, key) {
  const match = String(content).match(new RegExp(
    `^${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:\\s*(.+?)\\s*$`,
    "mu",
  ));
  if (!match) return null;
  const raw = match[1].trim();
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw.replace(/^['"]|['"]$/gu, "");
}

async function assertNoManagedFactConflict(checkoutRoot, candidate, document) {
  const roots = [join(checkoutRoot, "brain")];
  let inspected = 0;
  const visit = async (directory) => {
    const metadata = await lstat(directory).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("personal gbrain managed namespace is unsafe");
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("personal gbrain managed namespace contains a symlink");
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      inspected += 1;
      if (inspected > 10_000) throw new Error("personal gbrain authority is too large");
      const content = await readFile(path, "utf8");
      const factKey = frontmatterValue(content, "fact_key");
      const candidateKey = frontmatterValue(content, "candidate_key");
      if (
        factKey === candidate.factKey &&
        candidateKey &&
        candidateKey !== document.candidateKey
      ) {
        const error = new Error("personal gbrain fact conflicts with an existing managed fact");
        error.code = "personal_gbrain_fact_conflict";
        throw error;
      }
    }
  };
  for (const root of roots) await visit(root);
}

export async function ensurePersonalGbrainWriterCheckout({
  writerRoot,
  remoteUrl,
  branch = "main",
  home = process.env.HOME,
  run = execFileAsync,
  allowFileRemote = false,
  ghPath = null,
} = {}) {
  if (typeof writerRoot !== "string" || !isAbsolute(writerRoot)) {
    throw new Error("personal gbrain writer root must be absolute");
  }
  if (!branchPattern.test(branch) || branch.includes("..")) {
    throw new Error("personal gbrain branch is invalid");
  }
  const remote = credentialFreeGitRemote(remoteUrl, { allowFileRemote });
  await verifyPrivatePersonalGbrainRemote(remote, {
    ghPath,
    home,
    run,
    allowFileRemote,
  });
  const parent = dirname(resolve(writerRoot));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const env = gitEnvironment(home);
  const existing = await lstat(writerRoot).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    await runGit(run, ["clone", "--branch", branch, "--single-branch", remote, writerRoot], {
      cwd: parent,
      env,
      timeout: 300_000,
    });
    await chmod(writerRoot, 0o700);
  }
  const root = await canonicalManagedDirectory(writerRoot, "personal gbrain writer checkout");
  await access(join(root, ".git"), constants.R_OK);
  const { stdout: configuredRemote } = await runGit(run, ["remote", "get-url", "origin"], {
    cwd: root,
    env,
  });
  if (credentialFreeGitRemote(String(configuredRemote).trim(), { allowFileRemote }) !== remote) {
    throw new Error("personal gbrain writer remote identity mismatch");
  }
  const { stdout: status } = await runGit(run, ["status", "--porcelain"], { cwd: root, env });
  if (String(status).trim()) throw new Error("personal gbrain writer checkout is dirty");
  await runGit(run, ["fetch", "--prune", "origin", branch], {
    cwd: root,
    env,
    timeout: 300_000,
  });
  await runGit(run, ["checkout", "-B", branch, `origin/${branch}`], { cwd: root, env });
  return { root, remote, branch, env };
}

export async function promotePersonalGbrainCandidate(candidate, {
  projectRoot,
  writerRoot,
  remoteUrl,
  branch = "main",
  gbrainPath,
  home = process.env.HOME,
  run = execFileAsync,
  capture = null,
  readPage = readGbrainPage,
  allowFileRemote = false,
  ghPath = null,
} = {}) {
  const verified = await verifyPersonalGbrainCandidateEvidence(candidate, { projectRoot });
  const document = renderPersonalGbrainCandidate(verified);
  const lockPath = `${resolve(writerRoot)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(lockPath), 0o700);
  const releaseLock = await acquireLock(lockPath);
  try {
    const checkout = await ensurePersonalGbrainWriterCheckout({
      writerRoot,
      remoteUrl,
      branch,
      home,
      run,
      allowFileRemote,
      ghPath,
    });
    const destination = resolve(checkout.root, "brain", `${document.slug}.md`);
    const difference = relative(checkout.root, destination);
    if (difference.startsWith("..") || isAbsolute(difference)) {
      throw new Error("personal gbrain candidate path escapes the writer checkout");
    }
    await assertNoManagedFactConflict(checkout.root, verified, document);
    const created = await atomicWrite(destination, document.content);
    let commit = null;
    if (created) {
      await run("/bin/bash", [join(checkout.root, "scripts", "audit-knowledge-model.sh")], {
        cwd: checkout.root,
        env: checkout.env,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const relativePath = relative(checkout.root, destination);
      await runGit(run, ["add", "--", relativePath], { cwd: checkout.root, env: checkout.env });
      await runGit(run, ["commit", "-m", `memory: foursday ${document.candidateKey.slice(0, 12)}`, "--", relativePath], {
        cwd: checkout.root,
        env: checkout.env,
      });
      const { stdout: head } = await runGit(run, ["rev-parse", "HEAD"], {
        cwd: checkout.root,
        env: checkout.env,
      });
      commit = String(head).trim();
      await runGit(run, ["push", "origin", `HEAD:refs/heads/${branch}`], {
        cwd: checkout.root,
        env: checkout.env,
        timeout: 300_000,
      });
    }
    if (capture) {
      await capture({
        path: destination,
        slug: document.slug,
        sourceId: "default",
        contentSha256: document.contentSha256,
      });
    } else {
      if (typeof gbrainPath !== "string" || !isAbsolute(gbrainPath)) {
        throw new Error("personal gbrain executable must be an absolute path");
      }
      await run(gbrainPath, [
        "capture", "--file", destination,
        "--slug", document.slug,
        "--source", "default",
        "--json",
      ], {
        cwd: checkout.root,
        env: { ...checkout.env, PATH: `${dirname(gbrainPath)}:${checkout.env.PATH}` },
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
    const page = await readPage(gbrainPath, document.slug, { sourceId: "default" });
    if (
      page.slug !== document.slug ||
      !String(page.content ?? "").includes(verified.statement)
    ) throw new Error("personal gbrain promotion read-back mismatch");
    return {
      schema: "foursday-personal-gbrain-promotion/v1",
      status: "promoted",
      sourceId: "default",
      slug: document.slug,
      candidateKey: document.candidateKey,
      contentSha256: document.contentSha256,
      commit,
      created,
      readBack: true,
      mainWorktreeTouched: false,
    };
  } finally {
    await releaseLock();
  }
}

export async function retirePersonalGbrainPromotion(promotion, {
  writerRoot,
  remoteUrl,
  branch = "main",
  gbrainPath,
  home = process.env.HOME,
  run = execFileAsync,
  capture = null,
  readPage = readGbrainPage,
  allowFileRemote = false,
  ghPath = null,
  now = new Date(),
} = {}) {
  if (
    !promotion ||
    typeof promotion.slug !== "string" ||
    !/^(?:atoms|prospective|source)\/agents\/foursday\/[a-z0-9_/-]+$/u.test(promotion.slug) ||
    !/^[a-f0-9]{64}$/u.test(String(promotion.contentSha256 ?? ""))
  ) throw new Error("personal gbrain retirement identity is invalid");
  await mkdir(dirname(resolve(writerRoot)), { recursive: true, mode: 0o700 });
  const releaseLock = await acquireLock(`${resolve(writerRoot)}.lock`);
  try {
    const checkout = await ensurePersonalGbrainWriterCheckout({
      writerRoot, remoteUrl, branch, home, run, allowFileRemote, ghPath,
    });
    const destination = resolve(checkout.root, "brain", `${promotion.slug}.md`);
    const current = await readFile(destination, "utf8");
    if (/^status:\s*superseded\s*$/mu.test(current)) {
      if (!/^source_agent:\s*["']foursday["']\s*$/mu.test(current)) {
        throw new Error("personal gbrain superseded page is not Foursday-managed");
      }
      const contentSha256 = createHash("sha256").update(current).digest("hex");
      if (capture) {
        await capture({
          path: destination,
          slug: promotion.slug,
          sourceId: "default",
          contentSha256,
        });
      } else {
        await run(gbrainPath, [
          "capture", "--file", destination,
          "--slug", promotion.slug,
          "--source", "default",
          "--json",
        ], {
          cwd: checkout.root,
          env: { ...checkout.env, PATH: `${dirname(gbrainPath)}:${checkout.env.PATH}` },
          timeout: 120_000,
          maxBuffer: 8 * 1024 * 1024,
        });
      }
      const page = await readPage(gbrainPath, promotion.slug, { sourceId: "default" });
      if (page.slug !== promotion.slug || !/status:\s*superseded/u.test(String(page.content ?? ""))) {
        throw new Error("personal gbrain retirement read-back mismatch");
      }
      const { stdout: head } = await runGit(run, ["rev-parse", "HEAD"], {
        cwd: checkout.root,
        env: checkout.env,
      });
      return {
        schema: "foursday-personal-gbrain-retirement/v1",
        status: "revoked",
        slug: promotion.slug,
        commit: String(head).trim(),
        contentSha256,
        readBack: true,
        deleted: false,
        gitHistoryPreserved: true,
        alreadyRetired: true,
      };
    }
    if (!/^status:\s*active\s*$/mu.test(current)) {
      throw new Error("personal gbrain authority page is not active");
    }
    const retiredAt = new Date(now).toISOString();
    const next = current
      .replace(/^status:\s*active\s*$/mu, "status: superseded")
      .replace(/^updated_at:\s*.+$/mu, `updated_at: ${JSON.stringify(retiredAt)}`)
      .replace(/^---\n/u, `---\nsuperseded_at: ${JSON.stringify(retiredAt)}\n`);
    await atomicReplaceExpected(destination, next, promotion.contentSha256);
    await run("/bin/bash", [join(checkout.root, "scripts", "audit-knowledge-model.sh")], {
      cwd: checkout.root,
      env: checkout.env,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const relativePath = relative(checkout.root, destination);
    await runGit(run, ["add", "--", relativePath], { cwd: checkout.root, env: checkout.env });
    await runGit(run, [
      "commit", "-m", `memory: retire ${createHash("sha256").update(promotion.slug).digest("hex").slice(0, 12)}`,
      "--", relativePath,
    ], { cwd: checkout.root, env: checkout.env });
    const { stdout: head } = await runGit(run, ["rev-parse", "HEAD"], {
      cwd: checkout.root,
      env: checkout.env,
    });
    await runGit(run, ["push", "origin", `HEAD:refs/heads/${branch}`], {
      cwd: checkout.root,
      env: checkout.env,
      timeout: 300_000,
    });
    const contentSha256 = createHash("sha256").update(next).digest("hex");
    if (capture) {
      await capture({ path: destination, slug: promotion.slug, sourceId: "default", contentSha256 });
    } else {
      await run(gbrainPath, [
        "capture", "--file", destination,
        "--slug", promotion.slug,
        "--source", "default",
        "--json",
      ], {
        cwd: checkout.root,
        env: { ...checkout.env, PATH: `${dirname(gbrainPath)}:${checkout.env.PATH}` },
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
    const page = await readPage(gbrainPath, promotion.slug, { sourceId: "default" });
    if (page.slug !== promotion.slug || !/status:\s*superseded/u.test(String(page.content ?? ""))) {
      throw new Error("personal gbrain retirement read-back mismatch");
    }
    return {
      schema: "foursday-personal-gbrain-retirement/v1",
      status: "revoked",
      slug: promotion.slug,
      commit: String(head).trim(),
      contentSha256,
      readBack: true,
      deleted: false,
      gitHistoryPreserved: true,
    };
  } finally {
    await releaseLock();
  }
}

export function personalGbrainWriterFingerprint({ remoteUrl, branch, writerRoot }) {
  return createHash("sha256")
    .update(`${remoteUrl}\n${branch}\n${resolve(writerRoot)}`)
    .digest("hex");
}
