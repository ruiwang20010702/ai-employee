import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateCodexPluginPackage } from "../src/codex-plugin-package.mjs";
import { isMainModule } from "../src/main-module.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const npmPath = process.platform === "win32" ? "npm.cmd" : "npm";
const noGbrainEnvironment = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
};

function isolatedEnvironment(extra = {}) {
  const allowed = [
    "HOME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "npm_config_registry",
  ];
  return {
    ...Object.fromEntries(
      allowed
        .filter((name) => typeof process.env[name] === "string")
        .map((name) => [name, process.env[name]]),
    ),
    CI: "1",
    NO_COLOR: "1",
    ...extra,
  };
}

async function run(executable, args, options = {}) {
  const { env, ...executionOptions } = options;
  return execFileAsync(executable, args, {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: isolatedEnvironment(env),
    ...executionOptions,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function packageFileGate(files, root) {
  const paths = files.map((file) => file.path);
  const migrationFiles = (await readdir(join(root, "db", "migrations"), {
    withFileTypes: true,
  }))
    .filter((entry) =>
      entry.isFile() &&
      (entry.name.endsWith(".sql") || entry.name.endsWith(".json")),
    )
    .map((entry) => `db/migrations/${entry.name}`);
  const required = [
    ".agents/plugins/marketplace.json",
    "package.json",
    "README.md",
    "docs/产品需求文档.md",
    "docs/完成度矩阵.md",
    "docs/统一审查报告.md",
    "scripts/初始化生产配置.mjs",
    "scripts/初始化钥匙串密钥.mjs",
    "scripts/新环境向导.mjs",
    "scripts/交互式演示.mjs",
    "scripts/验证公开演示.mjs",
    "assets/foursday-v0.5-demo.manifest.json",
    "assets/foursday-v0.5-demo.mp4",
    "assets/foursday-v0.5-demo-poster.png",
    "scripts/启动体验.mjs",
    "scripts/运行代码检查.mjs",
    "scripts/创建项目配置.mjs",
    "scripts/导入历史项目.mjs",
    "scripts/运行项目配方影子验证.mjs",
    "scripts/同步项目记忆.mjs",
    "scripts/自动同步项目记忆.mjs",
    "scripts/导入项目身份记忆.mjs",
    "scripts/设置管理台登录.mjs",
    "scripts/校验项目能力.mjs",
    "scripts/运行完整测试.mjs",
    "scripts/验证复用安装.mjs",
    "scripts/验证公开安装.mjs",
    ...migrationFiles,
    "src/capability-policy.mjs",
    "src/adapter-contracts.mjs",
    "src/agent-runtime.mjs",
    "src/admin-session-auth.mjs",
    "src/admin-login-config.mjs",
    "src/project-identity-registry.mjs",
    "src/project-memory-routing.mjs",
    "deploy/project-identities.json",
    "src/demo.mjs",
    "src/activation.mjs",
    "src/activation-execution.mjs",
    "src/activation-server.mjs",
    "src/activation-ui.mjs",
    "src/historical-memory.mjs",
    "src/historical-project-import.mjs",
    "src/historical-project-import-service.mjs",
    "src/project-recipe-shadow.mjs",
    "src/project-memory-sync.mjs",
    "src/project-memory-sync-worker.mjs",
    "src/weekly-delegation-queue.mjs",
    "src/artifact-runtime.mjs",
    "src/openai-compatible-provider.mjs",
    "src/store.mjs",
    "src/feishu.mjs",
    "src/control-access.mjs",
    "src/privacy-erasure.mjs",
    "src/reuse-readiness.mjs",
    "src/production-config-file.mjs",
    "schemas/historical-project-import.schema.json",
    "examples/historical-project-import.json",
    "plugins/foursday/.codex-plugin/plugin.json",
    "plugins/foursday/.mcp.json",
    "plugins/foursday/scripts/mcp-server.mjs",
    "plugins/foursday/skills/foursday/SKILL.md",
    "plugins/foursday/说明.md",
  ];
  for (const path of required) {
    assert(paths.includes(path), `Release package is missing required file: ${path}`);
  }
  const forbidden = paths.filter((path) => (
    path === ".runtime" ||
    path.startsWith(".runtime/") ||
    path === "test" ||
    path.startsWith("test/") ||
    path === ".env" ||
    path.startsWith(".env.") ||
    /(?:^|\/)(?:state|production)\.(?:json|db|sqlite|sqlite3)$/iu.test(path) ||
    /(?:^|\/)node_modules(?:\/|$)/u.test(path)
  ));
  assert(forbidden.length === 0, "Release package contains runtime or test data");
  return paths;
}

async function verifyPortableContent(packageDirectory, paths) {
  const textExtensions = new Set([
    ".js", ".json", ".md", ".mjs", ".sql", ".yaml", ".yml",
  ]);
  const candidates = paths.filter((path) =>
    textExtensions.has(path.slice(path.lastIndexOf("."))),
  );
  for (const path of candidates) {
    const content = await readFile(join(packageDirectory, path), "utf8");
    assert(
      !/\/Users\/[^/\s"']+\//u.test(content) &&
      !/[A-Za-z]:\\Users\\[^\\\s"']+\\/u.test(content),
      `Release package contains a user-specific home path: ${path}`,
    );
  }
  return candidates.length;
}

async function verifyInstalledSources(packageDirectory) {
  const sourceDirectory = join(packageDirectory, "src");
  const sources = (await readdir(sourceDirectory))
    .filter((name) => name.endsWith(".mjs"));
  assert(sources.length > 0, "Installed package contains no source modules");
  for (const source of sources) {
    await run(process.execPath, ["--check", join(sourceDirectory, source)]);
  }
  return sources.length;
}

async function verifyInstalledPlugin(packageDirectory) {
  const packageValidation = await validateCodexPluginPackage({ root: packageDirectory });
  assert(
    packageValidation.checkedDistributionFiles === 6 && packageValidation.personalConfigurationWrite === false,
    "Installed Codex plugin distribution validation is incomplete",
  );
  const pluginDirectory = join(packageDirectory, "plugins", "foursday");
  const [manifest, mcp] = await Promise.all([
    readFile(join(pluginDirectory, ".codex-plugin", "plugin.json"), "utf8")
      .then(JSON.parse),
    readFile(join(pluginDirectory, ".mcp.json"), "utf8").then(JSON.parse),
  ]);
  assert(manifest.name === "foursday", "Installed Codex plugin identity changed");
  assert(manifest.mcpServers === "./.mcp.json", "Installed Codex plugin lost MCP mapping");
  const server = mcp.mcpServers?.foursday;
  assert(
    server?.type === "stdio" &&
    server.command === "node" &&
    server.cwd === "." &&
    JSON.stringify(server.args) === JSON.stringify(["scripts/mcp-server.mjs"]),
    "Installed Codex plugin MCP command is invalid",
  );
  const script = join(pluginDirectory, "scripts", "mcp-server.mjs");
  await run(process.execPath, ["--check", script]);
  const skill = await readFile(
    join(pluginDirectory, "skills", "foursday", "SKILL.md"),
    "utf8",
  );
  assert(
    skill.includes("本插件只读") && skill.includes("不批准、拒绝、发送、执行"),
    "Installed Codex plugin lost its read-only boundary",
  );
  return {
    checkedFiles: packageValidation.checkedDistributionFiles,
    version: manifest.version,
  };
}

async function verifyInstalledActivation(installedGuide, projectDirectory) {
  const child = spawn(installedGuide, ["start", "--port", "0"], {
    cwd: projectDirectory,
    env: isolatedEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_096); });
  child.stdout.setEncoding("utf8");
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Installed activation server did not start")), 10_000);
      const fail = (code) => {
        clearTimeout(timeout);
        reject(new Error(`Installed activation server exited early (${code}): ${stderr}`));
      };
      child.once("exit", fail);
      child.stdout.on("data", (chunk) => {
        const match = chunk.match(/http:\/\/127\.0\.0\.1:[0-9]+\//u);
        if (!match) return;
        clearTimeout(timeout);
        child.off("exit", fail);
        resolve(match[0]);
      });
    });
    const [page, environment] = await Promise.all([
      fetch(url),
      fetch(new URL("/api/environment", url)),
    ]);
    assert(page.ok && environment.ok, "Installed activation server endpoints are unavailable");
    assert(
      (await page.text()).includes("Give your coding agent one real job."),
      "Installed activation page lost its public first-run experience",
    );
    const environmentResult = await environment.json();
    assert(
      environmentResult.externalSystemsTouched === false,
      "Installed activation environment touched an external system",
    );
    const previewResponse = await fetch(new URL("/api/preview", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "reuse-example",
        projectName: "Reusable example",
        rootDirectory: projectDirectory,
        requesterId: "local-owner",
        runtime: "demo",
        issueUrl: "https://github.com/example/project/issues/1",
        changeRequest: "Add one documented example without changing public APIs.",
        testCommandId: "check",
        baseBranch: "main",
        prTitle: "docs: add one verified example",
      }),
    });
    const preview = await previewResponse.json();
    assert(
      previewResponse.ok &&
      preview.schema === "foursday-activation/v1" &&
      preview.externalSystemsTouched === false &&
      preview.decision === "DENY" &&
      preview.presentation?.steps?.length === 5,
      "Installed activation preview did not preserve the safe five-step plan",
    );
    return true;
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) {
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

export async function verifyReusableInstallation({
  root = projectRoot,
  keepTemporary = process.env.AI_EMPLOYEE_REUSE_KEEP_TEMP === "true",
} = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "ai-employee-reuse-"));
  try {
    const packDirectory = join(temporary, "pack");
    const installDirectory = join(temporary, "consumer");
    const runtimeDirectory = join(temporary, "runtime");
    const workspaceA = join(temporary, "workspace-a");
    const workspaceB = join(temporary, "workspace-b");
    const projectDirectory = join(temporary, "example-project");
    await Promise.all(
      [
        packDirectory,
        installDirectory,
        runtimeDirectory,
        workspaceA,
        workspaceB,
        projectDirectory,
      ]
        .map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
    );

    const packed = await run(
      npmPath,
      ["pack", "--json", "--pack-destination", packDirectory],
      { cwd: root },
    );
    const packResult = JSON.parse(packed.stdout);
    assert(Array.isArray(packResult) && packResult.length === 1, "npm pack returned an unexpected result");
    assert(
      typeof packResult[0].name === "string" &&
      typeof packResult[0].version === "string" &&
      typeof packResult[0].filename === "string" &&
      basename(packResult[0].filename) === packResult[0].filename,
      "npm pack returned invalid package metadata",
    );
    const packageFiles = await packageFileGate(packResult[0].files ?? [], root);
    const fileCount = packageFiles.length;
    const tarball = join(packDirectory, packResult[0].filename);
    await access(tarball);

    await run(
      npmPath,
      [
        "install",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        installDirectory,
        tarball,
      ],
      { cwd: installDirectory },
    );
    const packageName = packResult[0].name;
    const packageDirectory = join(installDirectory, "node_modules", packageName);
    const installedMetadata = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    );
    assert(installedMetadata.name === packageName, "Installed package identity changed");
    assert(installedMetadata.version === packResult[0].version, "Installed package version changed");
    assert(
      installedMetadata.bin?.foursday === "scripts/新环境向导.mjs",
      "Installed package is missing the Foursday environment guide",
    );
    assert(
      installedMetadata.bin?.["ai-employee"] === "scripts/新环境向导.mjs",
      "Installed package is missing the legacy environment guide alias",
    );
    const [sourceCount, pluginValidation, portableContentFiles] = await Promise.all([
      verifyInstalledSources(packageDirectory),
      verifyInstalledPlugin(packageDirectory),
      verifyPortableContent(packageDirectory, packageFiles),
    ]);
    assert(
      installedMetadata.version === pluginValidation.version,
      "Installed package and Codex plugin versions are inconsistent",
    );
    const installedCheck = JSON.parse((await run(
      npmPath,
      ["run", "check", "--silent"],
      { cwd: packageDirectory },
    )).stdout);
    assert(
      installedCheck.valid === true &&
      installedCheck.mode === "installed_package" &&
      installedCheck.tests === 0 &&
      installedCheck.sourceModules === sourceCount,
      "Installed package code check is unavailable or misleading",
    );
    const installedDemo = JSON.parse((await run(
      npmPath,
      [
        "run",
        "demo",
        "--silent",
        "--",
        "--message",
        "Prepare a launch checklist",
        "--approve",
        "--json",
      ],
      { cwd: packageDirectory },
    )).stdout);
    assert(
      installedDemo.mode === "local-simulation" &&
      installedDemo.outcome === "completed" &&
      installedDemo.externalSystemsTouched === false &&
      installedDemo.sideEffects.length === 2 &&
      installedDemo.evidence.every((item) => item.verified !== false),
      "Installed package demo did not complete with local read-back evidence",
    );
    const installedGuide = join(
      installDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "foursday.cmd" : "foursday",
    );
    await access(installedGuide, constants.X_OK);
    await run("/usr/bin/git", ["-C", projectDirectory, "init"]);
    const installedActivation = await verifyInstalledActivation(
      installedGuide,
      projectDirectory,
    );

    const configPath = join(runtimeDirectory, "production.json");
    const guideScript = join(packageDirectory, "scripts", "新环境向导.mjs");
    assert(
      ((await stat(guideScript)).mode & 0o111) !== 0,
      "Installed reusable environment guide is not executable",
    );
    const legacyInstalledGuide = join(
      installDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "ai-employee.cmd" : "ai-employee",
    );
    await access(legacyInstalledGuide, constants.X_OK);
    const guideHelp = JSON.parse((await run(
      installedGuide,
      ["help"],
      { cwd: runtimeDirectory },
    )).stdout);
    assert(
      Array.isArray(guideHelp.usage) &&
      guideHelp.boundary.includes("不连接钉钉、AgentRuntime 或数据库"),
      "Installed reusable environment guide lost its read-only boundary",
    );
    const workspaceConfigA = join(workspaceA, ".runtime", "production.json");
    const workspaceConfigB = join(workspaceB, ".runtime", "production.json");
    const [previewA, previewB] = await Promise.all([
      run(installedGuide, ["init"], { cwd: workspaceA }).then(({ stdout }) => JSON.parse(stdout)),
      run(installedGuide, ["init"], { cwd: workspaceB }).then(({ stdout }) => JSON.parse(stdout)),
    ]);
    assert(
      previewA.dryRun === true &&
      previewB.dryRun === true &&
      previewA.executed === false &&
      previewB.executed === false,
      "Reusable initialization wrote without explicit --apply",
    );
    const previewCreatedConfig = await Promise.all([
      access(workspaceConfigA).then(() => true).catch(() => false),
      access(workspaceConfigB).then(() => true).catch(() => false),
    ]);
    assert(
      previewCreatedConfig.every((created) => created === false),
      "Reusable initialization preview created a configuration file",
    );
    const [initializedA, initializedB] = await Promise.all([
      run(installedGuide, ["init", "--apply"], { cwd: workspaceA, env: noGbrainEnvironment })
        .then(({ stdout }) => JSON.parse(stdout)),
      run(installedGuide, ["init", "--apply"], { cwd: workspaceB, env: noGbrainEnvironment })
        .then(({ stdout }) => JSON.parse(stdout)),
    ]);
    const canonicalWorkspaceA = await realpath(workspaceA);
    const canonicalWorkspaceB = await realpath(workspaceB);
    const canonicalWorkspaceConfigA = join(
      canonicalWorkspaceA,
      ".runtime",
      "production.json",
    );
    const canonicalWorkspaceConfigB = join(
      canonicalWorkspaceB,
      ".runtime",
      "production.json",
    );
    assert(
      initializedA.path === canonicalWorkspaceConfigA &&
      initializedB.path === canonicalWorkspaceConfigB,
      "Reusable guide wrote configuration outside the consumer workspace",
    );
    const [workspaceValuesA, workspaceValuesB] = await Promise.all([
      readFile(workspaceConfigA, "utf8").then(JSON.parse),
      readFile(workspaceConfigB, "utf8").then(JSON.parse),
    ]);
    for (const key of [
      "AI_EMPLOYEE_DATA_KEY",
      "AI_EMPLOYEE_BACKUP_KEY",
      "AI_EMPLOYEE_ADMIN_READ_TOKEN",
      "AI_EMPLOYEE_ADMIN_WRITE_TOKEN",
    ]) {
      assert(
        /^keychain:\/\/foursday-[a-f0-9]{16}\//u.test(workspaceValuesA[key]) &&
        /^keychain:\/\/foursday-[a-f0-9]{16}\//u.test(workspaceValuesB[key]) &&
        workspaceValuesA[key] !== workspaceValuesB[key],
        `Independent workspaces reused or exposed secret storage: ${key}`,
      );
    }
    assert(
      initializedA.generatedSecrets.length === 0 &&
      initializedB.generatedSecrets.length === 0 &&
      initializedA.requiredSecretProvisioning.length === 4 &&
      initializedB.requiredSecretProvisioning.length === 4,
      "Reusable initialization wrote secret values or lost provisioning guidance",
    );
    assert(
      workspaceValuesA.AI_EMPLOYEE_PROJECTS_DIRECTORY === join(canonicalWorkspaceA, ".runtime", "projects") &&
      workspaceValuesB.AI_EMPLOYEE_PROJECTS_DIRECTORY === join(canonicalWorkspaceB, ".runtime", "projects") &&
      ((await stat(workspaceConfigA)).mode & 0o777) === 0o600 &&
      ((await stat(workspaceConfigB)).mode & 0o777) === 0o600,
      "Independent workspace paths or permissions are not isolated",
    );
    assert(
      /^foursday-[a-f0-9]{16}$/u.test(workspaceValuesA.AI_EMPLOYEE_MEMORY_AUTHORITY_SOURCE_ID) &&
      /^foursday-[a-f0-9]{16}$/u.test(workspaceValuesB.AI_EMPLOYEE_MEMORY_AUTHORITY_SOURCE_ID) &&
      workspaceValuesA.AI_EMPLOYEE_MEMORY_AUTHORITY_SOURCE_ID !==
        workspaceValuesB.AI_EMPLOYEE_MEMORY_AUTHORITY_SOURCE_ID &&
      initializedA.memorySource.registered === false &&
      initializedB.memorySource.registered === false &&
      initializedA.memorySource.registrationPending === "gbrain_unavailable" &&
      initializedB.memorySource.registrationPending === "gbrain_unavailable",
      "Independent workspaces reused a gbrain source or hid pending registration",
    );
    await Promise.all([
      access(join(initializedA.memorySource.root, "projects", "README.md")),
      access(join(initializedB.memorySource.root, "prospective", "README.md")),
    ]);
    let workspaceOverwriteRefused = false;
    try {
      await run(installedGuide, ["init", "--apply"], { cwd: workspaceA, env: noGbrainEnvironment });
    } catch {
      workspaceOverwriteRefused = true;
    }
    assert(workspaceOverwriteRefused, "Reusable guide overwrote a consumer workspace");
    const guideCheck = JSON.parse((await run(
      installedGuide,
      ["check", "--config", configPath],
      { cwd: runtimeDirectory, env: noGbrainEnvironment },
    )).stdout);
    assert(
      guideCheck.schema === "ai-employee-reuse/v1" &&
      guideCheck.readOnly === true &&
      guideCheck.config.exists === false &&
      guideCheck.readyForPreflight === false,
      "Installed reusable environment guide did not safely detect missing configuration",
    );
    const configPreview = JSON.parse((await run(
      installedGuide,
      ["init", "--config", configPath],
      { cwd: runtimeDirectory },
    )).stdout);
    assert(
      configPreview.dryRun === true &&
      configPreview.executed === false &&
      configPreview.configExists === false,
      "Installed configuration initialization did not require --apply",
    );
    await run(
      installedGuide,
      ["init", "--apply", "--config", configPath],
      { cwd: runtimeDirectory, env: noGbrainEnvironment },
    );
    const configMode = (await stat(configPath)).mode & 0o777;
    assert(configMode === 0o600, "Generated production config permissions are not 600");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert(
      [
        config.AI_EMPLOYEE_DATA_KEY,
        config.AI_EMPLOYEE_BACKUP_KEY,
        config.AI_EMPLOYEE_ADMIN_READ_TOKEN,
        config.AI_EMPLOYEE_ADMIN_WRITE_TOKEN,
      ].every((value) => /^keychain:\/\/foursday-[a-f0-9]{16}\//u.test(value)),
      "Generated configuration contains inline secrets or invalid Keychain references",
    );
    const secretPreview = JSON.parse((await run(
      installedGuide,
      ["secrets", "--config", configPath],
      { cwd: runtimeDirectory },
    )).stdout);
    assert(
      secretPreview.dryRun === true &&
      secretPreview.plannedKeys.length === 4 &&
      secretPreview.secretsPrinted === false,
      "Installed Keychain provisioning command is not safely previewable",
    );
    assert(config.GBRAIN_PATH === "gbrain", "Generated production config is missing gbrain runtime path");
    for (const key of [
      "AI_EMPLOYEE_TENANT_ID",
      "AI_EMPLOYEE_APPROVER",
      "DINGTALK_TARGET_USER_IDS",
      "DINGTALK_TARGET_GROUP_IDS",
      "DINGTALK_SELF_USER_ID",
    ]) {
      assert(config[key] === "", `Generated production config is unsafe by default: ${key}`);
    }
    let refusedOverwrite = false;
    try {
      await run(
        installedGuide,
        ["init", "--apply", "--config", configPath],
        { cwd: runtimeDirectory, env: noGbrainEnvironment },
      );
    } catch {
      refusedOverwrite = true;
    }
    assert(refusedOverwrite, "Production config initializer overwrote an existing file");

    Object.assign(config, {
      DATABASE_URL: "env://AI_EMPLOYEE_REUSE_DATABASE_URL",
      AI_EMPLOYEE_DATA_KEY: "env://AI_EMPLOYEE_REUSE_DATA_KEY",
      AI_EMPLOYEE_BACKUP_KEY: "env://AI_EMPLOYEE_REUSE_BACKUP_KEY",
      AI_EMPLOYEE_ADMIN_READ_TOKEN: "env://AI_EMPLOYEE_REUSE_ADMIN_READ_TOKEN",
      AI_EMPLOYEE_ADMIN_WRITE_TOKEN: "env://AI_EMPLOYEE_REUSE_ADMIN_WRITE_TOKEN",
      AI_EMPLOYEE_TENANT_ID: "reuse-tenant",
      AI_EMPLOYEE_APPROVER: "reuse-operator",
      DINGTALK_TARGET_USER_IDS: "reuse-target-user",
      DINGTALK_TARGET_GROUP_IDS: "",
      DINGTALK_SELF_USER_ID: "reuse-self-user",
    });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    const configuredGuideCheck = JSON.parse((await run(
      installedGuide,
      ["check", "--config", configPath],
      { cwd: runtimeDirectory },
    )).stdout);
    assert(
      configuredGuideCheck.config.exists === true &&
      configuredGuideCheck.config.protected === true &&
      configuredGuideCheck.config.externalSecretReferences === 5 &&
      configuredGuideCheck.config.inlineSecretValues === 0 &&
      configuredGuideCheck.config.unsafeCapabilitiesEnabled.length === 0 &&
      !JSON.stringify(configuredGuideCheck).includes("reuse-target-user") &&
      !JSON.stringify(configuredGuideCheck).includes("reuse-self-user"),
      "Installed reusable environment guide exposed values or misread safe defaults",
    );

    const lifecycleDryRuns = [
      ["preflight", "--dry-run"],
      ["doctor", "--dry-run"],
      ["backup"],
      ["migrate"],
      ["probe"],
      ["service", "generate"],
      ["service", "install"],
      ["service", "uninstall"],
      ["service", "verify", "--dry-run"],
      ["verify", "--dry-run"],
      ["shadow", "--dry-run"],
    ];
    const packageRuntime = join(packageDirectory, ".runtime");
    assert(
      await access(packageRuntime).then(() => false).catch(() => true),
      "Installed package unexpectedly contained runtime state before lifecycle previews",
    );
    const lifecyclePlans = [];
    for (const lifecycleArgs of lifecycleDryRuns) {
      const plan = JSON.parse((await run(
        installedGuide,
        [...lifecycleArgs, "--config", configPath],
        { cwd: runtimeDirectory },
      )).stdout);
      assert(
        plan.schema === "ai-employee-command-plan/v1" &&
        plan.dryRun === true &&
        plan.executed === false,
        `Installed lifecycle command executed during preview: ${lifecycleArgs.join(" ")}`,
      );
      const resolvedScript = await realpath(plan.packageScript);
      const resolvedPackage = await realpath(packageDirectory);
      assert(
        resolvedScript.startsWith(`${resolvedPackage}/`),
        `Installed lifecycle command escaped package scripts: ${lifecycleArgs.join(" ")}`,
      );
      lifecyclePlans.push(plan);
    }
    assert(
      await access(packageRuntime).then(() => false).catch(() => true),
      "Installed lifecycle preview wrote package runtime state",
    );
    assert(
      lifecyclePlans.filter((plan) => plan.applyRequired).length === 6 &&
      lifecyclePlans.filter((plan) => !plan.applyRequired).length === 5,
      "Installed lifecycle apply boundaries changed",
    );

    const projectScript = join(packageDirectory, "scripts", "创建项目配置.mjs");
    const projectArgs = [
      projectScript,
      "--project-id", "reuse_example",
      "--name", "复用验收项目",
      "--root", projectDirectory,
      "--requester", "reuse-test-user",
      "--write",
    ];
    const runtimeEnvironment = {
      AI_EMPLOYEE_CONFIG_FILE: configPath,
      AI_EMPLOYEE_REUSE_DATABASE_URL: "postgresql://reuse:reuse@127.0.0.1:5432/reuse",
      AI_EMPLOYEE_REUSE_DATA_KEY: Buffer.alloc(32, 1).toString("base64"),
      AI_EMPLOYEE_REUSE_BACKUP_KEY: Buffer.alloc(32, 2).toString("base64"),
      AI_EMPLOYEE_REUSE_ADMIN_READ_TOKEN: "r".repeat(64),
      AI_EMPLOYEE_REUSE_ADMIN_WRITE_TOKEN: "w".repeat(64),
    };
    await run(process.execPath, projectArgs, { env: runtimeEnvironment });
    const manifestPath = join(runtimeDirectory, "projects", "reuse_example.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert(
      ((await stat(manifestPath)).mode & 0o777) === 0o600,
      "Generated project manifest permissions are not 600",
    );
    for (const capability of [
      "knowledge_read",
      "local_test",
      "shared_document_write",
      "dingtalk_todo_create",
      "dingtalk_calendar_create",
      "dingtalk_report_submit",
      "git_push",
      "production_deploy",
    ]) {
      assert(manifest.capabilities[capability]?.mode === "disabled", `Unsafe default capability: ${capability}`);
    }
    const validateScript = join(packageDirectory, "scripts", "校验项目能力.mjs");
    const validation = await run(process.execPath, [validateScript], {
      env: runtimeEnvironment,
    });
    const validationResult = JSON.parse(validation.stdout);
    assert(validationResult.valid === true && validationResult.projects === 1, "Installed project validation failed");

    const historySourcePath = join(projectDirectory, "project-history.md");
    await writeFile(
      historySourcePath,
      "Every imported historical fact must remain traceable to its source.\n",
    );
    const historyBundlePath = join(temporary, "history-import.json");
    await writeFile(historyBundlePath, JSON.stringify({
      schema: "foursday-historical-project-import/v1",
      project: {
        projectId: manifest.projectId,
        name: manifest.name,
        rootDirectory: manifest.rootDirectory,
        requesterIds: manifest.requesters,
        profile: manifest.profile,
      },
      sources: [{ id: "project_history", path: "project-history.md" }],
      memories: [{
        type: "project",
        statement: "Every imported historical fact must remain traceable to its source.",
        factKey: "history.source_rule",
        sourceId: "project_history",
        sourceQuote: "Every imported historical fact must remain traceable to its source.",
      }],
    }));
    const historyPreview = JSON.parse((await run(
      process.execPath,
      [join(packageDirectory, "scripts", "导入历史项目.mjs"), "--bundle", historyBundlePath],
      {
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          AI_EMPLOYEE_PROJECTS_DIRECTORY: join(runtimeDirectory, "projects"),
        },
      },
    )).stdout);
    assert(
      historyPreview.projectAction === "reuse" &&
      historyPreview.counts.candidates === 1 &&
      historyPreview.databaseWrite === false &&
      historyPreview.memoriesConfirmed === 0,
      "Installed historical project import preview is unsafe or unavailable",
    );

    return {
      valid: true,
      package: `${packageName}@${installedMetadata.version}`,
      packageFiles: fileCount,
      checkedSourceModules: sourceCount,
      checkedPluginFiles: pluginValidation.checkedFiles,
      checkedPortableContentFiles: portableContentFiles,
      versionAligned: true,
      reusableGuide: true,
      installedCodeCheck: true,
      installedDemo: true,
      installedActivation,
      isolatedWorkspaces: 2,
      configMode: "600",
      projectMode: "600",
      historicalProjectImportPreview: true,
      overwriteProtection: true,
      inlineSecretsWritten: 0,
      keychainProvisioningPreview: true,
      lifecycleDryRuns: lifecyclePlans.length,
      lifecycleWritesApplied: 0,
      defaultExternalCapabilities: "disabled",
      productionWrite: false,
    };
  } finally {
    if (!keepTemporary) await rm(temporary, { recursive: true, force: true });
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  console.log(JSON.stringify(await verifyReusableInstallation(), null, 2));
}
