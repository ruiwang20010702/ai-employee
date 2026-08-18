import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const environmentReference = /^env:\/\/([A-Z_][A-Z0-9_]*)$/u;
const keychainReference = /^keychain:\/\/([^/]+)\/([^/]+)$/u;

export const secretConfigKeys = new Set([
  "DATABASE_URL",
  "AI_EMPLOYEE_GBRAIN_DATABASE_URL",
  "AI_EMPLOYEE_PERSONAL_MEMORY_CLIENT_SECRET",
  "AI_EMPLOYEE_DATA_KEY",
  "AI_EMPLOYEE_BACKUP_KEY",
  "AI_EMPLOYEE_HEALTH_AUTH_TOKEN",
  "AI_EMPLOYEE_ADMIN_READ_TOKEN",
  "AI_EMPLOYEE_ADMIN_WRITE_TOKEN",
  "AI_EMPLOYEE_ALERT_WEBHOOK_URL",
  "AI_EMPLOYEE_ALERT_WEBHOOK_SECRET",
]);

export function isSecretReference(value) {
  return typeof value === "string" &&
    (value.startsWith("env://") || value.startsWith("keychain://"));
}

function decodedReferencePart(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("Secret reference contains invalid encoding");
  }
  if (!decoded || /[\0\r\n]/u.test(decoded)) {
    throw new Error("Secret reference contains an invalid name");
  }
  return decoded;
}

async function readMacosKeychain(service, account) {
  if (process.platform !== "darwin") {
    throw new Error("macOS Keychain references are unavailable on this platform");
  }
  const allowedEnvironment = Object.fromEntries(
    ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL"]
      .filter((name) => typeof process.env[name] === "string")
      .map((name) => [name, process.env[name]]),
  );
  const { stdout } = await execFileAsync(
    "/usr/bin/security",
    ["find-generic-password", "-s", service, "-a", account, "-w"],
    {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: { ...allowedEnvironment, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    },
  );
  return stdout.replace(/\r?\n$/u, "");
}

export async function resolveSecretReference(
  value,
  {
    environment = process.env,
    keychainReader = readMacosKeychain,
  } = {},
) {
  if (!isSecretReference(value)) {
    return { value: String(value), source: "inline" };
  }
  const environmentMatch = value.match(environmentReference);
  if (environmentMatch) {
    const resolved = environment[environmentMatch[1]];
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw new Error("Referenced environment secret is unavailable");
    }
    return { value: resolved, source: "environment" };
  }
  const keychainMatch = value.match(keychainReference);
  if (!keychainMatch) throw new Error("Secret reference format is invalid");
  const service = decodedReferencePart(keychainMatch[1]);
  const account = decodedReferencePart(keychainMatch[2]);
  const resolved = await keychainReader(service, account);
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw new Error("Referenced keychain secret is unavailable");
  }
  return { value: resolved, source: "macos-keychain" };
}
