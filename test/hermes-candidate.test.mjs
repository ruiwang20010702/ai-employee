import assert from "node:assert/strict";
import { access, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertHermesRuntimeRoot,
  buildHermesCandidatePlan,
} from "../src/hermes-candidate.mjs";

const lock = {
  schemaVersion: 1,
  repository: "https://github.com/NousResearch/hermes-agent.git",
  release: "v2026.8.18",
  version: "0.20.4",
  commit: "e624e9fde561e1add9388384012b295fde669ade",
  license: "MIT",
  licenseSha256: "821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6",
  pythonRequires: ">=3.11,<3.14",
};

test("Hermes 候选计划只写 Foursday 隔离目录并固定提交", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "foursday-hermes-plan-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const plan = buildHermesCandidatePlan({
    projectRoot,
    lock,
    uvPath: "/opt/homebrew/bin/uv",
    pythonPath: "/opt/hermes-python/bin/python3.13",
  });
  assert.equal(plan.layout.root, join(projectRoot, ".runtime", "hermes-poc"));
  assert.equal(plan.layout.root.includes("/.hermes"), false);
  assert.equal(plan.commands.some((command) => command.args.includes("main")), false);
  assert.equal(plan.commands.some((command) => command.args.includes(lock.commit)), true);
  assert.equal(plan.commands.some((command) =>
    command.args.includes("sparse-checkout") &&
    command.args.includes("!/contributors/emails/")
  ), true);
  assert.equal(plan.environment.HOME, plan.layout.state);
  assert.equal(plan.environment.UV_PROJECT_ENVIRONMENT, plan.layout.venv);
  assert.equal(JSON.stringify(plan).includes("~/.hermes"), false);
  await assert.rejects(access(plan.layout.root), { code: "ENOENT" });
});

test("Hermes 运行根目录拒绝符号链接和项目外路径", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "foursday-hermes-root-"));
  const outside = await mkdtemp(join(tmpdir(), "foursday-hermes-outside-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await assert.rejects(
    assertHermesRuntimeRoot(projectRoot, outside),
    /must stay inside the project runtime/u,
  );
  const runtimeDirectory = join(projectRoot, ".runtime");
  await symlink(outside, runtimeDirectory);
  await assert.rejects(
    assertHermesRuntimeRoot(
      projectRoot,
      join(runtimeDirectory, "hermes-poc"),
    ),
    /symbolic links/u,
  );
});
