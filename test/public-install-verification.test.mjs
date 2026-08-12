import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  publicInstallCommand,
  publicInstallEnvironment,
  publicInstallHelp,
  publicInstallSha,
  runPublicInstallVerification,
  validatePublicActivationHtml,
  verifyPublicInstall,
} from "../scripts/验证公开安装.mjs";

const sha = "a".repeat(40);

test("公开安装命令固定提交、禁用生命周期脚本且不依赖 SSH", () => {
  const npmCliPath = process.platform === "win32" ? "C:\\npm-cli.js" : "/trusted/npm-cli.js";
  const command = publicInstallCommand({ npmCliPath, sourceSha: sha });
  assert.equal(command.executable, process.execPath);
  assert.deepEqual(command.args, [
    npmCliPath,
    "exec",
    "--yes",
    "--ignore-scripts",
    "--package",
    `github:ruiwang20010702/foursday#${sha}`,
    "--",
    "foursday",
    "start",
    "--pilot-sha",
    sha,
    "--port",
    "0",
  ]);
});

test("公开安装隔离环境不转发令牌、Git 配置或 SSH 凭据", () => {
  const workspace = process.platform === "win32" ? "C:\\isolated" : "/isolated";
  const environment = publicInstallEnvironment({
    workspace,
    source: {
      LANG: "en_US.UTF-8",
      GH_TOKEN: "must-not-leak",
      GITHUB_TOKEN: "must-not-leak",
      NPM_TOKEN: "must-not-leak",
      NODE_AUTH_TOKEN: "must-not-leak",
      SSH_AUTH_SOCK: "/private/socket",
      HTTPS_PROXY: "https://user:secret@proxy.example/",
      NODE_EXTRA_CA_CERTS: "/private/company-ca.pem",
      GIT_CONFIG_GLOBAL: "/private/gitconfig",
      npm_config_userconfig: "/private/npmrc",
    },
  });
  assert.equal(environment.LANG, "en_US.UTF-8");
  for (const forbidden of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "SSH_AUTH_SOCK",
    "HTTPS_PROXY",
    "NODE_EXTRA_CA_CERTS",
  ]) assert.equal(environment[forbidden], undefined);
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
  assert.equal(environment.npm_config_ignore_scripts, "true");
  assert.notEqual(environment.npm_config_userconfig, "/private/npmrc");
});

test("公开安装页面必须保留唯一任务与真实计时边界", () => {
  assert.equal(validatePublicActivationHtml(`
    Create your unique pilot task
    Copy privacy-safe readiness report
    Measured server-start-to-confirmed journey
    Package download time is not included
  `), true);
  assert.throws(
    () => validatePublicActivationHtml("Create your unique pilot task"),
    /missing a required candidate boundary/u,
  );
});

test("公开安装验收只返回脱敏的零写结果并清理临时目录", async () => {
  const npmCliPath = process.execPath;
  const observed = [];
  const result = await verifyPublicInstall({
    sourceSha: sha,
    npmCliPath,
    launch: async ({ command, environment, workspace }) => {
      observed.push({ command, environment, workspace });
      return {
        loopback: true,
        readinessSupportAvailable: true,
        externalSystemsTouched: false,
      };
    },
  });
  assert.equal(observed.length, 1);
  assert.equal(result.sourceSha, sha);
  assert.equal(result.credentialTokensForwarded, 0);
  assert.equal(result.lifecycleScriptsEnabled, false);
  assert.equal(result.readinessSupportAvailable, true);
  assert.equal(result.productionWrite, false);
  assert.equal(result.externalSystemsTouched, false);
  assert.match(observed[0].workspace, /foursday-public-install-/u);
  assert.equal(observed[0].environment.HOME, join(observed[0].workspace, "home"));
  await assert.rejects(() => access(observed[0].workspace));
});

test("公开安装 CLI 只接受完整提交并在帮助时不运行验收", async () => {
  assert.equal(publicInstallSha(["--sha", sha]), sha);
  assert.equal(publicInstallSha(["--help"]), null);
  assert.throws(() => publicInstallSha(["--sha", "main"]), /40-character/u);
  const output = [];
  const result = await runPublicInstallVerification({
    args: ["--help"],
    output: { write: (chunk) => output.push(chunk) },
  });
  assert.equal(result, null);
  assert.equal(output.join(""), publicInstallHelp);
});
