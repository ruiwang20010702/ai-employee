import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultProductionConfigPath } from "../src/production-config-file.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return { present: false, value: null };
  if (process.argv[index + 1] == null || process.argv[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a comma-separated value or an empty string`);
  }
  return { present: true, value: process.argv[index + 1] };
}

function normalizedList(value) {
  return [...new Set(String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
}

const userArgument = argument("--users");
const groupArgument = argument("--groups");
const users = normalizedList(userArgument.value);
const groups = normalizedList(groupArgument.value);
const dryRun = process.argv.includes("--dry-run");
if (!userArgument.present && !groupArgument.present) {
  throw new Error("Usage: npm run targets:update -- --users <ids> --groups <ids>");
}

const configPath = resolve(
  process.env.AI_EMPLOYEE_CONFIG_FILE ?? defaultProductionConfigPath(),
);
const config = JSON.parse(await readFile(configPath, "utf8"));
if (userArgument.present) config.DINGTALK_TARGET_USER_IDS = users.join(",");
if (groupArgument.present) config.DINGTALK_TARGET_GROUP_IDS = groups.join(",");

if (dryRun) {
  console.log(
    JSON.stringify({
      updated: false,
      dryRun: true,
      users: userArgument.present ? users.length : undefined,
      groups: groupArgument.present ? groups.length : undefined,
    }),
  );
  process.exit(0);
}

const temporaryPath = resolve(dirname(configPath), `.targets-${randomUUID()}.json`);
await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
  flag: "wx",
});
await chmod(temporaryPath, 0o600);
await rename(temporaryPath, configPath);
console.log(
  JSON.stringify({
    updated: true,
    users: userArgument.present ? users.length : undefined,
    groups: groupArgument.present ? groups.length : undefined,
  }),
);
