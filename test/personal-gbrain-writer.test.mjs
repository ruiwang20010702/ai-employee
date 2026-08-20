import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  promotePersonalGbrainCandidate,
  retirePersonalGbrainPromotion,
} from "../src/personal-gbrain-writer.mjs";

const execFileAsync = promisify(execFile);
const git = (args, options = {}) => execFileAsync("/usr/bin/git", args, {
  ...options,
  maxBuffer: 8 * 1024 * 1024,
});

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-gbrain-writer-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = join(root, "seed");
  const remote = join(root, "remote.git");
  const project = join(root, "project");
  await Promise.all([mkdir(seed), mkdir(project)]);
  await git(["init", "--bare", remote]);
  await git(["init", "-b", "main"], { cwd: seed });
  await mkdir(join(seed, "brain", "atoms"), { recursive: true });
  await mkdir(join(seed, "scripts"));
  await writeFile(join(seed, "brain", "atoms", "seed.md"), "---\ntype: atom\ntitle: seed\n---\n");
  await writeFile(join(seed, "scripts", "audit-knowledge-model.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await git(["add", "."], { cwd: seed });
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed"], { cwd: seed });
  await git(["remote", "add", "origin", `file://${remote}`], { cwd: seed });
  await git(["push", "-u", "origin", "main"], { cwd: seed });
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remote });
  const evidence = "formal count: 68786\n";
  await writeFile(join(project, "summary.txt"), evidence);
  return { root, remote: `file://${remote}`, project, evidence };
}

function candidate(evidence) {
  return {
    schema: "foursday-personal-gbrain-candidate/v1",
    type: "atom",
    projectId: "vocab_2_2",
    factKey: "production.formal_question_count",
    title: "单词 2.2 正式试题口径",
    statement: "正式试题口径必须来自当前项目汇总，不得把释义级源记录当作题目数。",
    sensitivity: "internal",
    confidence: 0.99,
    observedAt: "2026-08-20T00:00:00Z",
    sourceSessionHash: "b".repeat(64),
    evidence: [{
      relativePath: "summary.txt",
      contentSha256: sha(evidence),
      description: "当前项目汇总",
    }],
  };
}

test("personal gbrain promotion uses a dedicated checkout, fast-forward Git and exact read-back", async (t) => {
  const value = await fixture(t);
  const captures = [];
  const result = await promotePersonalGbrainCandidate(candidate(value.evidence), {
    projectRoot: value.project,
    writerRoot: join(value.root, "managed", "checkout"),
    remoteUrl: value.remote,
    allowFileRemote: true,
    home: value.root,
    capture: async (item) => captures.push(item),
    readPage: async (_gbrainPath, slug) => ({
      slug,
      content: "正式试题口径必须来自当前项目汇总，不得把释义级源记录当作题目数。",
    }),
  });
  assert.equal(result.status, "promoted");
  assert.equal(result.mainWorktreeTouched, false);
  assert.equal(result.readBack, true);
  assert.equal(captures.length, 1);
  const { stdout } = await git(["--git-dir", value.remote.slice("file://".length), "show", `main:brain/${result.slug}.md`]);
  assert.match(stdout, /source_agent: "foursday"/u);
});

test("writer fails closed on conflicting existing pages and does not overwrite them", async (t) => {
  const value = await fixture(t);
  const writerRoot = join(value.root, "managed", "checkout");
  const first = candidate(value.evidence);
  await promotePersonalGbrainCandidate(first, {
    projectRoot: value.project,
    writerRoot,
    remoteUrl: value.remote,
    allowFileRemote: true,
    home: value.root,
    capture: async () => {},
    readPage: async (_path, slug) => ({ slug, content: first.statement }),
  });
  const changed = { ...first, statement: `${first.statement} conflicting` };
  changed.evidence = first.evidence;
  await assert.rejects(
    promotePersonalGbrainCandidate(changed, {
      projectRoot: value.project,
      writerRoot,
      remoteUrl: value.remote,
      allowFileRemote: true,
      home: value.root,
      capture: async () => {},
      readPage: async () => ({}),
    }),
    /conflicts|read-back/u,
  );
});

test("writer rejects symlinked managed checkouts", async (t) => {
  const value = await fixture(t);
  const outside = join(value.root, "outside");
  await mkdir(outside);
  const writerRoot = join(value.root, "managed", "checkout");
  await mkdir(join(value.root, "managed"));
  await symlink(outside, writerRoot);
  await assert.rejects(
    promotePersonalGbrainCandidate(candidate(value.evidence), {
      projectRoot: value.project,
      writerRoot,
      remoteUrl: value.remote,
      allowFileRemote: true,
      home: value.root,
      capture: async () => {},
      readPage: async () => ({}),
    }),
    /canonical directory/u,
  );
});

test("source drift retires the managed page without deleting Git history", async (t) => {
  const value = await fixture(t);
  const writerRoot = join(value.root, "managed", "checkout");
  const input = candidate(value.evidence);
  const promoted = await promotePersonalGbrainCandidate(input, {
    projectRoot: value.project,
    writerRoot,
    remoteUrl: value.remote,
    allowFileRemote: true,
    home: value.root,
    capture: async () => {},
    readPage: async (_path, slug) => ({ slug, content: input.statement }),
  });
  const retirement = await retirePersonalGbrainPromotion(promoted, {
    writerRoot,
    remoteUrl: value.remote,
    allowFileRemote: true,
    home: value.root,
    capture: async () => {},
    readPage: async (_path, slug) => ({ slug, content: "status: superseded" }),
    now: "2026-08-20T03:00:00Z",
  });
  assert.equal(retirement.status, "revoked");
  assert.equal(retirement.deleted, false);
  assert.equal(retirement.gitHistoryPreserved, true);
  const { stdout } = await git([
    "--git-dir", value.remote.slice("file://".length),
    "show", `main:brain/${promoted.slug}.md`,
  ]);
  assert.match(stdout, /status: superseded/u);
  const { stdout: history } = await git([
    "--git-dir", value.remote.slice("file://".length),
    "log", "--oneline", "--", `brain/${promoted.slug}.md`,
  ]);
  assert.equal(history.trim().split("\n").length, 2);
  const repeated = await retirePersonalGbrainPromotion(promoted, {
    writerRoot,
    remoteUrl: value.remote,
    allowFileRemote: true,
    home: value.root,
    capture: async () => {},
    readPage: async (_path, slug) => ({ slug, content: "status: superseded" }),
    now: "2026-08-20T03:01:00Z",
  });
  assert.equal(repeated.alreadyRetired, true);
  const { stdout: repeatedHistory } = await git([
    "--git-dir", value.remote.slice("file://".length),
    "log", "--oneline", "--", `brain/${promoted.slug}.md`,
  ]);
  assert.equal(repeatedHistory.trim().split("\n").length, 2);
});
