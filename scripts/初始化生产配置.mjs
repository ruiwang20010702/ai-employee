import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultProductionConfigPath } from "../src/production-config-file.mjs";
import { isMainModule } from "../src/main-module.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const examplePath = join(projectRoot, "deploy", "生产配置.example.json");

function keychainReference(service, account) {
  return `keychain://${encodeURIComponent(service)}/${encodeURIComponent(account)}`;
}

function uniqueKeychainService() {
  return `foursday-${randomBytes(8).toString("hex")}`;
}

export async function initializeProductionConfig({
  outputPath = defaultProductionConfigPath(),
  keychainService = uniqueKeychainService(),
} = {}) {
  const destination = resolve(outputPath);
  const values = JSON.parse(await readFile(examplePath, "utf8"));
  const accounts = {
    AI_EMPLOYEE_DATA_KEY: "data-key",
    AI_EMPLOYEE_BACKUP_KEY: "backup-key",
    AI_EMPLOYEE_ADMIN_READ_TOKEN: "admin-read-token",
    AI_EMPLOYEE_ADMIN_WRITE_TOKEN: "admin-write-token",
  };
  for (const [key, account] of Object.entries(accounts)) {
    values[key] = keychainReference(keychainService, account);
  }
  values.DATABASE_URL = "";
  values.AI_EMPLOYEE_BACKUP_DIRECTORY = join(
    dirname(destination),
    "backups",
  );
  values.AI_EMPLOYEE_PROJECTS_DIRECTORY = join(
    dirname(destination),
    "projects",
  );
  values.DWS_PATH = "dws";
  values.CODEX_PATH = "codex";
  values.CLAUDE_CODE_PATH = "claude";
  values.AI_EMPLOYEE_AGENT_RUNTIME = "codex";
  for (const key of [
    "GBRAIN_PATH",
    "AI_EMPLOYEE_GBRAIN_HOME",
    "AI_EMPLOYEE_GBRAIN_DATABASE_URL",
    "AI_EMPLOYEE_MEMORY_AUTHORITY_ROOT",
    "AI_EMPLOYEE_MEMORY_AUTHORITY_SOURCE_ID",
    "AI_EMPLOYEE_PERSONAL_MEMORY_CLIENT_SECRET",
  ]) delete values[key];
  values.AI_EMPLOYEE_MEMORY_AUTHORITY_MODE = "disabled";
  values.AI_EMPLOYEE_MEMORY_AUTHORITY_WRITE = false;
  values.AI_EMPLOYEE_MEMORY_AUTHORITY_AUTO_CONFIRM = false;
  values.AI_EMPLOYEE_PERSONAL_MEMORY_ENABLED = false;
  values.AI_EMPLOYEE_PERSONAL_MEMORY_MCP_URL = "";
  values.AI_EMPLOYEE_PERSONAL_MEMORY_ISSUER_URL = "";
  values.AI_EMPLOYEE_PERSONAL_MEMORY_CLIENT_ID = "";
  values.GH_PATH = "";
  values.AI_EMPLOYEE_TENANT_ID = "";
  values.AI_EMPLOYEE_APPROVER = "";
  values.DINGTALK_TARGET_USER_IDS = "";
  values.DINGTALK_TARGET_GROUP_IDS = "";
  values.DINGTALK_SELF_USER_ID = "";

  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, `${JSON.stringify(values, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    created: true,
    path: destination,
    mode: "600",
    secretStorage: "keychain",
    keychainService,
    generatedSecrets: [],
    externalSecretReferences: Object.keys(accounts),
    requiredSecretProvisioning: Object.keys(accounts),
    requiredEdits: [
      "DATABASE_URL",
      "AI_EMPLOYEE_PERSONAL_MEMORY_ENABLED",
      "AI_EMPLOYEE_PERSONAL_MEMORY_MCP_URL",
      "AI_EMPLOYEE_PERSONAL_MEMORY_ISSUER_URL",
      "AI_EMPLOYEE_PERSONAL_MEMORY_CLIENT_ID",
      "AI_EMPLOYEE_PERSONAL_MEMORY_CLIENT_SECRET",
      "AI_EMPLOYEE_TENANT_ID",
      "DINGTALK_TARGET_USER_IDS or DINGTALK_TARGET_GROUP_IDS",
      "DINGTALK_SELF_USER_ID",
      "AI_EMPLOYEE_APPROVER",
    ],
    memoryArchitecture: "personal_gbrain_plus_postgresql_runtime",
  };
}

function outputArgument(argv) {
  const index = argv.indexOf("--output");
  if (index === -1) return undefined;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) {
    throw new Error("Usage: 初始化生产配置.mjs [--output /absolute/path.json]");
  }
  return argv[index + 1];
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const result = await initializeProductionConfig({
    outputPath: outputArgument(process.argv.slice(2)),
  });
  console.log(JSON.stringify(result, null, 2));
}
