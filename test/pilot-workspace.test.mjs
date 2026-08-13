import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareFoursdayPilotWorkspace } from "../src/pilot-workspace.mjs";

const sourceSha = "a".repeat(40);

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "foursday-pilot-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  let cloneRoot = null;
  let forkExists = false;
  const ghRun = async (_path, args) => {
    calls.push(["gh", ...args]);
    if (args[0] === "api") return "tester-one";
    if (args[1] === "fork") {
      forkExists = true;
      return "";
    }
    if (args[1] === "view") {
      return JSON.stringify({
        nameWithOwner: "tester-one/foursday",
        isFork: true,
        parent: { nameWithOwner: "ruiwang20010702/foursday" },
      });
    }
    if (args[1] === "clone") {
      cloneRoot = args[3];
      await mkdir(cloneRoot, { recursive: true });
      await writeFile(join(cloneRoot, "package.json"), JSON.stringify({
        name: "foursday-runtime",
        version: "0.5.0",
      }));
      return "";
    }
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  };
  const ghTryRun = async (_path, args) => {
    calls.push(["gh-try", ...args]);
    return forkExists
      ? JSON.stringify({
          nameWithOwner: "tester-one/foursday",
          isFork: true,
          parent: { nameWithOwner: "ruiwang20010702/foursday" },
        })
      : null;
  };
  const gitRun = async (root, args) => {
    calls.push(["git", root, ...args]);
    if (args[0] === "rev-parse") return sourceSha;
    if (args[0] === "branch") return `pilot-v0.5-${sourceSha.slice(0, 12)}`;
    return "";
  };
  const npmRun = async ({ root }) => {
    calls.push(["npm", root]);
    await mkdir(join(root, "node_modules"));
  };
  const repositoryInspector = async (root) => ({
    head: sourceSha,
    repository: "tester-one/foursday",
    upstreamRepository: "ruiwang20010702/foursday",
    root,
  });
  return {
    home,
    calls,
    dependencies: {
      ghPath: "/usr/bin/true",
      nodePath: process.execPath,
      npmCliPath: "/usr/bin/true",
      homeDirectory: home,
      ghRun,
      ghTryRun,
      gitRun,
      npmRun,
      repositoryInspector,
    },
    cloneRoot: () => cloneRoot,
  };
}

test("pilot workspace requires explicit confirmation before any GitHub call", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () => prepareFoursdayPilotWorkspace({ sourceSha, confirmForkAndClone: false }, f.dependencies),
    /Explicit confirmation/u,
  );
  assert.deepEqual(f.calls, []);
});

test("pilot workspace creates and verifies one fixed fork checkout", async (t) => {
  const f = await fixture(t);
  const result = await prepareFoursdayPilotWorkspace({
    sourceSha,
    confirmForkAndClone: true,
  }, f.dependencies);
  assert.equal(result.schema, "foursday-pilot-workspace/v1");
  assert.equal(result.sourceRepository, "tester-one/foursday");
  assert.equal(result.upstreamRepository, "ruiwang20010702/foursday");
  assert.equal(result.startingCommit, sourceSha);
  assert.equal(result.forkCreated, true);
  assert.equal(result.cloneCreated, true);
  assert.deepEqual(result.externalEffects, [
    "github_fork",
    "local_clone",
    "locked_dependency_install",
  ]);
  assert.match(result.rootDirectory, /FoursdayPilot\/a{12}\/foursday$/u);
  assert.notEqual(f.cloneRoot(), result.rootDirectory);
  assert.equal(f.calls.some((call) => call[0] === "npm"), true);
  assert.equal(
    f.calls.some((call) => call[0] === "git" && call.includes("merge-base")),
    true,
  );
  assert.equal(
    f.calls.some((call) => call[0] === "git" && call.includes("fetch") && call.at(-1) === "main"),
    true,
  );
  assert.equal(
    f.calls.some((call) => call[0] === "git" && call.includes(sourceSha)),
    true,
  );
  const cloneCall = f.calls.find((call) => call[0] === "gh" && call[2] === "clone");
  assert.ok(cloneCall);
  assert.equal(cloneCall.includes("--no-upstream"), true);
});

test("pilot workspace reports no fork creation when cloning an existing valid fork", async (t) => {
  const f = await fixture(t);
  f.dependencies.ghTryRun = async (_path, args) => {
    f.calls.push(["gh-try", ...args]);
    return JSON.stringify({
      nameWithOwner: "tester-one/foursday",
      isFork: true,
      parent: { nameWithOwner: "ruiwang20010702/foursday" },
    });
  };
  const result = await prepareFoursdayPilotWorkspace({
    sourceSha,
    confirmForkAndClone: true,
  }, f.dependencies);
  assert.equal(result.forkCreated, false);
  assert.deepEqual(result.externalEffects, ["local_clone", "locked_dependency_install"]);
});

test("pilot workspace reuses only the exact clean fork and commit", async (t) => {
  const f = await fixture(t);
  const target = join(f.home, "FoursdayPilot", sourceSha.slice(0, 12), "foursday");
  await mkdir(join(target, "node_modules"), { recursive: true });
  const result = await prepareFoursdayPilotWorkspace({
    sourceSha,
    confirmForkAndClone: true,
  }, f.dependencies);
  assert.equal(result.forkCreated, false);
  assert.equal(result.cloneCreated, false);
  assert.deepEqual(result.externalEffects, []);
  assert.equal(f.calls.some((call) => call.includes("clone")), false);
});

test("pilot workspace rejects a symlinked fixed root before GitHub access", async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "foursday-pilot-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(f.home, "FoursdayPilot"));
  await assert.rejects(
    () => prepareFoursdayPilotWorkspace({
      sourceSha,
      confirmForkAndClone: true,
    }, f.dependencies),
    /real private directory/u,
  );
  assert.deepEqual(f.calls, []);
});
