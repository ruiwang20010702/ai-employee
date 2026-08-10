import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  validateLoadedLaunchAgent,
  verifyLoadedLaunchAgents,
} from "../src/launch-agent-verification.mjs";

function launchctlOutput({ label, scriptPath, workingDirectory, configPath }) {
  return `gui/501/${label} = {
  arguments = {
    /opt/homebrew/bin/node
    ${scriptPath}
  }
  working directory = ${workingDirectory}/
  environment = {
    AI_EMPLOYEE_CONFIG_FILE => ${configPath}
  }
}`;
}

test("常驻服务必须精确匹配标签、脚本、工作目录和生产配置", () => {
  const expected = {
    label: "com.ai-employee.listener",
    scriptPath: "/releases/new/src/service-launcher.mjs",
    workingDirectory: "/releases/new",
    configPath: "/releases/new/.runtime/production.json",
  };
  assert.deepEqual(
    validateLoadedLaunchAgent(launchctlOutput(expected), expected),
    { verified: true, failures: [] },
  );

  for (const [field, value, failure] of [
    ["label", "com.ai-employee.old-listener", "label_mismatch"],
    ["scriptPath", "/releases/old/src/service-launcher.mjs", "script_path_mismatch"],
    ["workingDirectory", "/releases/old", "working_directory_mismatch"],
    ["configPath", "/releases/old/.runtime/production.json", "config_path_mismatch"],
  ]) {
    const actual = { ...expected, [field]: value };
    const result = validateLoadedLaunchAgent(launchctlOutput(actual), expected);
    assert.equal(result.verified, false);
    assert.ok(result.failures.includes(failure));
  }
});

test("相似但不相等的旧版本路径不能冒充目标版本", () => {
  const expected = {
    label: "com.ai-employee.worker",
    scriptPath: "/releases/new/src/service-launcher.mjs",
    workingDirectory: "/releases/new",
    configPath: "/releases/new/.runtime/production.json",
  };
  const output = launchctlOutput({
    ...expected,
    scriptPath: `/old-prefix${expected.scriptPath}`,
  });
  const result = validateLoadedLaunchAgent(output, expected);
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("script_path_mismatch"));
});

async function releaseFixture() {
  const releaseDirectory = await mkdtemp(join(tmpdir(), "ai-employee-release-"));
  const runtimeDirectory = join(releaseDirectory, ".runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  const configPath = join(runtimeDirectory, "production.json");
  await writeFile(configPath, "{}\n");
  return { releaseDirectory, configPath };
}

test("全部 LaunchAgent 来自目标版本时验证通过", async (t) => {
  const fixture = await releaseFixture();
  t.after(() => rm(fixture.releaseDirectory, { recursive: true, force: true }));
  const definitions = [
    { component: "listener", label: "com.ai-employee.listener" },
    { component: "backup", label: "com.ai-employee.backup" },
  ];
  const resolvedRelease = await realpath(fixture.releaseDirectory);
  const resolvedConfig = await realpath(fixture.configPath);
  const scriptPathFor = (definition, root) =>
    join(root, definition.component === "backup" ? "scripts/备份数据库.mjs" : "src/service-launcher.mjs");
  const result = await verifyLoadedLaunchAgents({
    definitions,
    releaseDirectory: fixture.releaseDirectory,
    configPath: fixture.configPath,
    scriptPathFor,
    uid: 501,
    run: async (_command, args) => {
      const label = args[1].split("/").at(-1);
      const definition = definitions.find((entry) => entry.label === label);
      return {
        stdout: launchctlOutput({
          label,
          scriptPath: scriptPathFor(definition, resolvedRelease),
          workingDirectory: resolvedRelease,
          configPath: resolvedConfig,
        }),
      };
    },
  });
  assert.deepEqual(result, { verified: true, failedLabels: [] });
});

test("旧版本服务和无法读取的服务都会列入失败标签", async (t) => {
  const fixture = await releaseFixture();
  t.after(() => rm(fixture.releaseDirectory, { recursive: true, force: true }));
  const definitions = [
    { component: "listener", label: "com.ai-employee.listener" },
    { component: "worker", label: "com.ai-employee.worker" },
  ];
  const scriptPathFor = (_definition, root) => join(root, "src/service-launcher.mjs");
  const result = await verifyLoadedLaunchAgents({
    definitions,
    releaseDirectory: fixture.releaseDirectory,
    configPath: fixture.configPath,
    scriptPathFor,
    uid: 501,
    run: async (_command, args) => {
      const label = args[1].split("/").at(-1);
      if (label.endsWith("worker")) throw new Error("not loaded");
      return {
        stdout: launchctlOutput({
          label,
          scriptPath: "/releases/old/src/service-launcher.mjs",
          workingDirectory: fixture.releaseDirectory,
          configPath: fixture.configPath,
        }),
      };
    },
  });
  assert.deepEqual(result, {
    verified: false,
    failedLabels: ["com.ai-employee.listener", "com.ai-employee.worker"],
  });
});

test("生产配置不属于目标版本时在读取 LaunchAgent 前失败", async (t) => {
  const fixture = await releaseFixture();
  const otherDirectory = await mkdtemp(join(tmpdir(), "ai-employee-config-"));
  t.after(() => Promise.all([
    rm(fixture.releaseDirectory, { recursive: true, force: true }),
    rm(otherDirectory, { recursive: true, force: true }),
  ]));
  const configPath = join(otherDirectory, "production.json");
  await writeFile(configPath, "{}\n");
  let called = false;
  await assert.rejects(
    verifyLoadedLaunchAgents({
      definitions: [{ component: "listener", label: "com.ai-employee.listener" }],
      releaseDirectory: fixture.releaseDirectory,
      configPath,
      scriptPathFor: (_definition, root) => join(root, "src/service-launcher.mjs"),
      run: async () => {
        called = true;
        return { stdout: "" };
      },
    }),
    /must belong to the expected release/u,
  );
  assert.equal(called, false);
});
