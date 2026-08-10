import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultProductionConfigPath } from "../src/production-config-file.mjs";
import { isMainModule } from "../src/main-module.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const examplePath = join(projectRoot, "deploy", "生产配置.example.json");

function secretKey() {
  return randomBytes(32).toString("base64");
}

function accessToken() {
  return randomBytes(32).toString("hex");
}

export async function initializeProductionConfig({
  outputPath = defaultProductionConfigPath(),
} = {}) {
  const destination = resolve(outputPath);
  const values = JSON.parse(await readFile(examplePath, "utf8"));
  values.AI_EMPLOYEE_DATA_KEY = secretKey();
  values.AI_EMPLOYEE_BACKUP_KEY = secretKey();
  values.AI_EMPLOYEE_ADMIN_READ_TOKEN = accessToken();
  values.AI_EMPLOYEE_ADMIN_WRITE_TOKEN = accessToken();
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
  values.GBRAIN_PATH = "gbrain";
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
    generatedSecrets: [
      "AI_EMPLOYEE_DATA_KEY",
      "AI_EMPLOYEE_BACKUP_KEY",
      "AI_EMPLOYEE_ADMIN_READ_TOKEN",
      "AI_EMPLOYEE_ADMIN_WRITE_TOKEN",
    ],
    requiredEdits: [
      "DATABASE_URL",
      "AI_EMPLOYEE_TENANT_ID",
      "DINGTALK_TARGET_USER_IDS or DINGTALK_TARGET_GROUP_IDS",
      "DINGTALK_SELF_USER_ID",
      "AI_EMPLOYEE_APPROVER",
    ],
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
