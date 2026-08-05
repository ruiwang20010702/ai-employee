import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../src/main-module.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const npmPath = process.platform === "win32" ? "npm.cmd" : "npm";

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

function canonicalKey(value) {
  if (typeof value !== "string") return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

function packageFileGate(files) {
  const paths = files.map((file) => file.path);
  const required = [
    "package.json",
    "README.md",
    "docs/产品需求文档.md",
    "scripts/初始化生产配置.mjs",
    "scripts/创建项目配置.mjs",
    "scripts/校验项目能力.mjs",
    "scripts/验证复用安装.mjs",
    "db/migrations/016_隐私擦除墓碑.sql",
    "src/capability-policy.mjs",
    "src/privacy-erasure.mjs",
    "src/production-config-file.mjs",
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
  return paths.length;
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

export async function verifyReusableInstallation({
  root = projectRoot,
  keepTemporary = process.env.AI_EMPLOYEE_REUSE_KEEP_TEMP === "true",
} = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "ai-employee-reuse-"));
  try {
    const packDirectory = join(temporary, "pack");
    const installDirectory = join(temporary, "consumer");
    const runtimeDirectory = join(temporary, "runtime");
    const projectDirectory = join(temporary, "example-project");
    await Promise.all(
      [packDirectory, installDirectory, runtimeDirectory, projectDirectory]
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
    const fileCount = packageFileGate(packResult[0].files ?? []);
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
    const sourceCount = await verifyInstalledSources(packageDirectory);

    const configPath = join(runtimeDirectory, "production.json");
    const initializeScript = join(packageDirectory, "scripts", "初始化生产配置.mjs");
    await run(process.execPath, [initializeScript, "--output", configPath]);
    const configMode = (await stat(configPath)).mode & 0o777;
    assert(configMode === 0o600, "Generated production config permissions are not 600");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert(canonicalKey(config.AI_EMPLOYEE_DATA_KEY), "Generated data key is invalid");
    assert(canonicalKey(config.AI_EMPLOYEE_BACKUP_KEY), "Generated backup key is invalid");
    assert(config.AI_EMPLOYEE_DATA_KEY !== config.AI_EMPLOYEE_BACKUP_KEY, "Generated keys are not independent");
    assert(
      typeof config.AI_EMPLOYEE_ADMIN_READ_TOKEN === "string" &&
      config.AI_EMPLOYEE_ADMIN_READ_TOKEN.length >= 64 &&
      config.AI_EMPLOYEE_ADMIN_READ_TOKEN !== config.AI_EMPLOYEE_ADMIN_WRITE_TOKEN,
      "Generated admin tokens are invalid or not independent",
    );
    assert(config.GBRAIN_PATH === "gbrain", "Generated production config is missing gbrain runtime path");
    let refusedOverwrite = false;
    try {
      await run(process.execPath, [initializeScript, "--output", configPath]);
    } catch {
      refusedOverwrite = true;
    }
    assert(refusedOverwrite, "Production config initializer overwrote an existing file");

    await run("/usr/bin/git", ["-C", projectDirectory, "init"]);
    const projectScript = join(packageDirectory, "scripts", "创建项目配置.mjs");
    const projectArgs = [
      projectScript,
      "--project-id", "reuse_example",
      "--name", "复用验收项目",
      "--root", projectDirectory,
      "--requester", "reuse-test-user",
      "--write",
    ];
    const runtimeEnvironment = { AI_EMPLOYEE_CONFIG_FILE: configPath };
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

    return {
      valid: true,
      package: `${packageName}@${installedMetadata.version}`,
      packageFiles: fileCount,
      checkedSourceModules: sourceCount,
      configMode: "600",
      projectMode: "600",
      overwriteProtection: true,
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
