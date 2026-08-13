import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ActivationExecutionCoordinator,
  prepareActivationExecution,
} from "../src/activation-execution.mjs";
import { createControlledWorkAdapters } from "../src/work-adapters.mjs";
import { validateValidationEvidence } from "../src/validation-evidence.mjs";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  return execFileAsync("/usr/bin/git", ["-C", root, ...args]);
}

test("public activation runs the real governed patch-to-Draft-PR loop", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "foursday-activation-e2e-"));
  const root = join(sandbox, "project");
  const remote = join(sandbox, "remote.git");
  const sessionRoot = join(sandbox, "sessions");
  await Promise.all([mkdir(root), mkdir(remote)]);
  await execFileAsync("/usr/bin/git", ["-C", remote, "init", "--bare"]);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Foursday E2E");
  await git(root, "config", "user.email", "foursday@example.invalid");
  await writeFile(join(root, "message.txt"), "before\n");
  await writeFile(join(root, "verify.mjs"), [
    "import assert from 'node:assert/strict';",
    "import { readFile } from 'node:fs/promises';",
    "assert.equal(await readFile(new URL('./message.txt', import.meta.url), 'utf8'), 'after\\n');",
    "",
  ].join("\n"));
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "activation-e2e-fixture",
    private: true,
    type: "module",
    scripts: { check: "node verify.mjs" },
  }, null, 2)}\n`);
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial fixture");
  await git(root, "remote", "add", "origin", remote);

  const ghState = join(sandbox, "gh-state.json");
  const fakeGh = join(sandbox, "fake-gh");
  await writeFile(fakeGh, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const cp = require('node:child_process');",
    "const args = process.argv.slice(2);",
    `const statePath = ${JSON.stringify(ghState)};`,
    `const remote = ${JSON.stringify(remote)};`,
    "if (args[0] === 'pr' && args[1] === 'create') {",
    "  const branch = args[args.indexOf('--head') + 1];",
    "  const title = args[args.indexOf('--title') + 1];",
    "  const base = args[args.indexOf('--base') + 1];",
    "  const bodyPath = args[args.indexOf('--body-file') + 1];",
    "  const body = fs.readFileSync(bodyPath, 'utf8');",
    "  fs.writeFileSync(statePath, JSON.stringify({ branch, title, base, body }));",
    "  console.log('https://github.com/example/project/pull/42');",
    "} else if (args[0] === 'pr' && args[1] === 'view') {",
    "  const state = JSON.parse(fs.readFileSync(statePath));",
    "  const commit = cp.execFileSync('/usr/bin/git', ['--git-dir', remote, 'rev-parse', 'refs/heads/' + state.branch], { encoding: 'utf8' }).trim();",
    "  console.log(JSON.stringify({ number: 42, url: 'https://github.com/example/project/pull/42', state: 'OPEN', isDraft: true, headRefName: state.branch, headRefOid: commit, headRepository: { nameWithOwner: 'example/project' }, baseRefName: state.base, title: state.title, body: state.body }));",
    "} else process.exit(2);",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(fakeGh, 0o700);

  const patch = [
    "diff --git a/message.txt b/message.txt",
    "--- a/message.txt",
    "+++ b/message.txt",
    "@@ -1 +1 @@",
    "-before",
    "+after",
    "",
  ].join("\n");
  const repositoryInspector = async (directory) => {
    const [{ stdout: head }, { stdout: remoteUrl }, { stdout: status }] = await Promise.all([
      git(directory, "rev-parse", "HEAD"),
      git(directory, "remote", "get-url", "origin"),
      git(directory, "status", "--porcelain=v1", "--untracked-files=all"),
    ]);
    assert.equal(status.trim(), "");
    return {
      head: head.trim(),
      remoteUrl: remoteUrl.trim(),
      repository: "example/project",
    };
  };
  const coordinator = new ActivationExecutionCoordinator({
    sessionRoot,
    ghPath: fakeGh,
    artifactRuntimeFactory: async () => ({
      id: "fixture-runtime",
      async generateArtifact() {
        return {
          output: patch,
          bytes: Buffer.byteLength(patch),
          sha256: createHash("sha256").update(patch).digest("hex"),
          runtimeId: "fixture-runtime",
        };
      },
    }),
    repositoryInspector,
    adapterFactory: (options) => {
      const adapters = createControlledWorkAdapters(options);
      const githubPreflight = adapters.github_pr_draft.preflight;
      adapters.github_pr_draft = {
        ...adapters.github_pr_draft,
        preflight: (context) => githubPreflight({
          ...context,
          manifest: {
            ...context.manifest,
            capabilities: {
              ...context.manifest.capabilities,
              git_push: {
                ...context.manifest.capabilities.git_push,
                expectedRemoteUrl: "https://github.com/example/project.git",
              },
            },
          },
        }),
      };
      return adapters;
    },
    prepare: (input) => prepareActivationExecution(input, {
      repositoryInspector,
      commandBuilder: async ({ rootDirectory, commandId }) => {
        const metadata = JSON.parse(await readFile(join(rootDirectory, "package.json"), "utf8"));
        assert.equal(metadata.scripts[commandId], "node verify.mjs");
        return {
          executable: process.execPath,
          args: ["verify.mjs"],
          timeoutMs: 30_000,
          maxOutputBytes: 100_000,
        };
      },
    }),
  });
  t.after(async () => {
    await coordinator.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  const created = await coordinator.create({
    projectId: "activation_e2e",
    projectName: "Activation E2E",
    rootDirectory: root,
    requesterId: "local-owner",
    runtime: "codex",
    issueUrl: "https://github.com/example/project/issues/7",
    changeRequest: "Change the fixture message from before to after.",
    baseBranch: "main",
    testCommandId: "check",
    prTitle: "test: complete the activation loop",
  });
  assert.equal(created.externalSystemsTouched, false);
  assert.equal(created.plan.status, "awaiting_approval");

  const completed = await coordinator.approveAndExecute(created.sessionId, {
    approved: true,
    planHash: created.plan.planHash,
    reason: "I reviewed the fixture repository, exact five-step plan, and evidence boundaries.",
    humanActiveMinutes: 10,
  });
  assert.equal(completed.status, "completed", JSON.stringify(completed, null, 2));
  assert.deepEqual(completed.evidence.map((item) => item.kind), [
    "unified_diff",
    "isolated_git_worktree",
    "controlled_command",
    "verified_git_push",
    "verified_github_pr_draft",
  ]);
  assert.equal(completed.evidence.at(-1).url, "https://github.com/example/project/pull/42");
  assert.equal(await readFile(join(root, "message.txt"), "utf8"), "before\n");
  assert.equal(completed.memoryCandidate.status, "proposed");
  assert.equal(completed.timeReturn.status, "proposed");

  const confirmed = await coordinator.confirmOutcomes(created.sessionId, {
    memoryId: completed.memoryCandidate.id,
    timeReturnId: completed.timeReturn.id,
  });
  assert.equal(confirmed.memory.status, "confirmed");
  assert.equal(confirmed.timeReturn.status, "confirmed");
  assert.ok(confirmed.timeReturn.returnedMinutes > 0);
  const bundle = await coordinator.exportEvidence(created.sessionId);
  const summary = validateValidationEvidence(bundle);
  assert.equal(summary.confirmed, true);
  assert.equal(summary.issueNumber, 7);
  assert.equal(summary.draftPrNumber, 42);
  assert.match(summary.draftPrHead, /^foursday\//u);
  assert.equal(summary.draftPrBase, "main");
  assert.equal(summary.draftPrState, "OPEN");
  assert.equal(summary.draftPrIsDraft, true);
});
