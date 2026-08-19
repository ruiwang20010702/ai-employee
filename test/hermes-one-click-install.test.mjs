import assert from "node:assert/strict";
import test from "node:test";
import {
  hermesInstallSteps,
  inspectHermesInstallPrerequisites,
  runHermesOneClickInstall,
} from "../scripts/一键安装Hermes.mjs";

const readyPrerequisites = Object.freeze({
  ready: true,
  requirements: Object.freeze({ macOS: true, node: true, git: true, uv: true }),
  uvPath: "/opt/homebrew/bin/uv",
  missing: [],
});

test("一键安装默认只返回完整计划且不执行任何步骤", async () => {
  let calls = 0;
  const result = await runHermesOneClickInstall({
    projectRoot: "/workspace/foursday",
    prerequisiteInspector: async () => readyPrerequisites,
    stepRunner: async () => { calls += 1; },
  });
  assert.equal(result.schema, "foursday-hermes-install/v1");
  assert.equal(result.installed, false);
  assert.equal(result.productionWrite, false);
  assert.equal(result.gatewayStarted, false);
  assert.equal(result.messagesSent, 0);
  assert.deepEqual(result.steps.map(({ id }) => id), hermesInstallSteps.map(({ id }) => id));
  assert.equal(calls, 0);
});

test("显式应用会按固定顺序安装完整 Hermes 发行层", async () => {
  const calls = [];
  const result = await runHermesOneClickInstall({
    apply: true,
    projectRoot: "/workspace/foursday",
    prerequisiteInspector: async () => readyPrerequisites,
    stepRunner: async ({ step }) => {
      calls.push(step.id);
      return {
        valid: true,
        productionWrite: false,
        release: step.id === "prepare-upstream" ? "v2026.8.18" : undefined,
        patchCount: step.id === "apply-patches" ? 1 : undefined,
        installed: step.id === "install-distribution" ? ["profile", "plugins"] : undefined,
      };
    },
  });
  assert.equal(result.installed, true);
  assert.deepEqual(calls, hermesInstallSteps.map(({ id }) => id));
  assert.equal(result.completed.length, 3);
  assert.equal(result.productionWrite, false);
  assert.equal(result.gatewayStarted, false);
});

test("缺少依赖时应用失败且不会执行部分安装", async () => {
  let calls = 0;
  await assert.rejects(
    runHermesOneClickInstall({
      apply: true,
      projectRoot: "/workspace/foursday",
      prerequisiteInspector: async () => ({
        ...readyPrerequisites,
        ready: false,
        requirements: { ...readyPrerequisites.requirements, uv: false },
        missing: ["uv"],
      }),
      stepRunner: async () => { calls += 1; },
    }),
    /prerequisites are missing: uv/u,
  );
  assert.equal(calls, 0);
});

test("安装步骤失败时停止后续步骤", async () => {
  const calls = [];
  await assert.rejects(
    runHermesOneClickInstall({
      apply: true,
      projectRoot: "/workspace/foursday",
      prerequisiteInspector: async () => readyPrerequisites,
      stepRunner: async ({ step }) => {
        calls.push(step.id);
        if (step.id === "apply-patches") throw new Error("patch rejected");
        return { valid: true, productionWrite: false };
      },
    }),
    /patch rejected/u,
  );
  assert.deepEqual(calls, ["prepare-upstream", "apply-patches"]);
});

test("前置检查要求 macOS、Node 22.5、系统 Git 和 uv", async () => {
  const result = await inspectHermesInstallPrerequisites({
    platform: "linux",
    nodeVersion: "v22.4.0",
    accessImpl: async (path) => {
      if (path === "/usr/bin/git") return;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ["macOS", "node", "uv"]);
});
