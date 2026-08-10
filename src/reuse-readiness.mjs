import { access, constants, readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute } from "node:path";
import { productionConfigKeys } from "./production-config-file.mjs";
import {
  isSecretReference,
  secretConfigKeys,
} from "./secret-provider.mjs";

const unsafeCapabilities = new Set([
  "send_message",
  "send_group_message",
  "work_plan_execution",
]);
const requiredSecretConfigKeys = [
  "AI_EMPLOYEE_DATA_KEY",
  "AI_EMPLOYEE_BACKUP_KEY",
  "AI_EMPLOYEE_ADMIN_READ_TOKEN",
  "AI_EMPLOYEE_ADMIN_WRITE_TOKEN",
];

function nodeVersionSupported(version) {
  const match = String(version).match(/^v?(\d+)\.(\d+)\.(\d+)/u);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

function configured(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && !/^(?:replace_with|change_me)(?:_|$)/iu.test(text);
}

function validSecretReference(value) {
  const text = String(value);
  if (/^env:\/\/[A-Z_][A-Z0-9_]*$/u.test(text)) return true;
  const match = text.match(/^keychain:\/\/([^/]+)\/([^/]+)$/u);
  if (!match) return false;
  try {
    return match.slice(1).every((part) => {
      const decoded = decodeURIComponent(part);
      return Boolean(decoded) && !/[\0\r\n]/u.test(decoded);
    });
  } catch {
    return false;
  }
}

function canonicalBase64Key(value) {
  const decoded = Buffer.from(String(value), "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

async function executableInPath(command, environment = process.env) {
  if (!command) return false;
  if (isAbsolute(command) || command.includes("/")) {
    return access(command, constants.X_OK).then(() => true).catch(() => false);
  }
  for (const directory of String(environment.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    if (await access(`${directory}/${command}`, constants.X_OK)
      .then(() => true).catch(() => false)) return true;
  }
  return false;
}

async function inspectConfig(configPath) {
  let metadata;
  try {
    metadata = await stat(configPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        exists: false,
        protected: false,
        valid: false,
        requiredEdits: ["创建生产配置"],
        externalSecretReferences: 0,
        inlineSecretValues: 0,
        unsafeCapabilitiesEnabled: [],
      };
    }
    throw error;
  }
  const result = {
    exists: true,
    protected: metadata.isFile() && (metadata.mode & 0o077) === 0,
    valid: false,
    requiredEdits: [],
    externalSecretReferences: 0,
    inlineSecretValues: 0,
    unsafeCapabilitiesEnabled: [],
  };
  if (!metadata.isFile()) {
    result.requiredEdits.push("生产配置必须是普通文件");
    return result;
  }
  if (!result.protected) result.requiredEdits.push("将生产配置权限改为 600");

  let values;
  try {
    values = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    result.requiredEdits.push("修复生产配置 JSON 格式");
    return result;
  }
  if (!values || Array.isArray(values) || typeof values !== "object") {
    result.requiredEdits.push("生产配置必须是 JSON 对象");
    return result;
  }
  const unknownKeys = Object.keys(values).filter((key) => !productionConfigKeys.has(key));
  const nonScalarKeys = Object.entries(values)
    .filter(([, value]) => !["string", "number", "boolean"].includes(typeof value))
    .map(([key]) => key);
  if (unknownKeys.length > 0) result.requiredEdits.push(`移除 ${unknownKeys.length} 个未知配置项`);
  if (nonScalarKeys.length > 0) result.requiredEdits.push(`修复 ${nonScalarKeys.length} 个非标量配置项`);

  for (const key of secretConfigKeys) {
    const value = values[key];
    if (!configured(value)) continue;
    if (isSecretReference(String(value))) {
      if (validSecretReference(value)) result.externalSecretReferences += 1;
      else result.requiredEdits.push(`修复 ${key} 外部密钥引用`);
    } else result.inlineSecretValues += 1;
  }
  if (
    !configured(values.DATABASE_URL) ||
    /replace|change_me|example/iu.test(String(values.DATABASE_URL))
  ) {
    result.requiredEdits.push("填写数据库连接");
  }
  if (!configured(values.AI_EMPLOYEE_TENANT_ID)) result.requiredEdits.push("填写租户编号");
  if (!configured(values.AI_EMPLOYEE_APPROVER)) result.requiredEdits.push("填写操作人编号");
  if (!configured(values.DINGTALK_SELF_USER_ID)) result.requiredEdits.push("填写当前账号编号");
  if (
    !configured(values.DINGTALK_TARGET_USER_IDS) &&
    !configured(values.DINGTALK_TARGET_GROUP_IDS)
  ) {
    result.requiredEdits.push("至少填写一个监听联系人或群聊");
  }
  for (const key of requiredSecretConfigKeys) {
    if (!configured(values[key])) result.requiredEdits.push(`配置 ${key}`);
  }
  for (const key of ["AI_EMPLOYEE_DATA_KEY", "AI_EMPLOYEE_BACKUP_KEY"]) {
    const value = values[key];
    if (configured(value) && !isSecretReference(String(value)) && !canonicalBase64Key(value)) {
      result.requiredEdits.push(`修复 ${key} 格式`);
    }
  }
  for (const key of ["AI_EMPLOYEE_ADMIN_READ_TOKEN", "AI_EMPLOYEE_ADMIN_WRITE_TOKEN"]) {
    const value = values[key];
    if (
      configured(value) &&
      !isSecretReference(String(value)) &&
      Buffer.byteLength(String(value)) < 32
    ) {
      result.requiredEdits.push(`加长 ${key}`);
    }
  }
  if (
    configured(values.AI_EMPLOYEE_DATA_KEY) &&
    values.AI_EMPLOYEE_DATA_KEY === values.AI_EMPLOYEE_BACKUP_KEY
  ) {
    result.requiredEdits.push("数据密钥和备份密钥必须不同");
  }
  if (
    configured(values.AI_EMPLOYEE_ADMIN_READ_TOKEN) &&
    values.AI_EMPLOYEE_ADMIN_READ_TOKEN === values.AI_EMPLOYEE_ADMIN_WRITE_TOKEN
  ) {
    result.requiredEdits.push("管理只读令牌和写入令牌必须不同");
  }
  const capabilities = String(values.AI_EMPLOYEE_ALLOWED_CAPABILITIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  result.unsafeCapabilitiesEnabled = capabilities
    .filter((capability) => unsafeCapabilities.has(capability));
  if (result.unsafeCapabilitiesEnabled.length > 0) {
    result.requiredEdits.push("首次部署前关闭发送和计划执行能力");
  }
  result.valid = result.protected && result.requiredEdits.length === 0;
  result.runtimePaths = {
    dws: String(values.DWS_PATH ?? "dws"),
    codex: String(values.CODEX_PATH ?? "codex"),
    pgDump: String(values.PG_DUMP_PATH ?? "pg_dump"),
    pgRestore: String(values.PG_RESTORE_PATH ?? "pg_restore"),
  };
  return result;
}

export async function inspectReuseReadiness({
  configPath,
  platform = process.platform,
  nodeVersion = process.version,
  environment = process.env,
  executableChecker = executableInPath,
} = {}) {
  if (!configPath) throw new Error("configPath is required");
  const config = await inspectConfig(configPath);
  const paths = config.runtimePaths ?? {
    dws: "dws",
    codex: "codex",
    pgDump: "pg_dump",
    pgRestore: "pg_restore",
  };
  const commandInputs = [
    ["DWS", paths.dws],
    ["Codex", paths.codex],
    ["pg_dump", paths.pgDump],
    ["pg_restore", paths.pgRestore],
    ["Git", "/usr/bin/git"],
  ];
  const commands = await Promise.all(commandInputs.map(async ([name, path]) => ({
    name,
    available: await executableChecker(path, environment),
    source: isAbsolute(path) ? "absolute" : "PATH",
  })));
  const supportedPlatform = platform === "darwin";
  const supportedNode = nodeVersionSupported(nodeVersion);
  const missingCommands = commands.filter((command) => !command.available)
    .map((command) => command.name);
  const readyForPreflight =
    supportedPlatform &&
    supportedNode &&
    missingCommands.length === 0 &&
    config.valid;
  const nextActions = [];
  if (!supportedPlatform) nextActions.push("使用 macOS 主机运行生产服务");
  if (!supportedNode) nextActions.push("安装 Node.js 22.5 或更高版本");
  if (missingCommands.length > 0) nextActions.push(`安装或配置：${missingCommands.join("、")}`);
  if (!config.exists) nextActions.push("运行 ai-employee init --apply 创建受保护配置");
  else nextActions.push(...config.requiredEdits);
  if (readyForPreflight) nextActions.push("运行 ai-employee preflight 进行联网只读预检");

  return {
    schema: "ai-employee-reuse/v1",
    readOnly: true,
    supportedPlatform,
    supportedNode,
    commands,
    config: {
      exists: config.exists,
      protected: config.protected,
      valid: config.valid,
      requiredEdits: config.requiredEdits,
      externalSecretReferences: config.externalSecretReferences,
      inlineSecretValues: config.inlineSecretValues,
      unsafeCapabilitiesEnabled: config.unsafeCapabilitiesEnabled,
    },
    readyForPreflight,
    nextActions,
  };
}
