import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeProductionConfig } from "../scripts/初始化生产配置.mjs";

test("production config initializer writes protected isolated references and refuses overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-config-"));
  const destination = join(directory, "nested", "production.json");
  const result = await initializeProductionConfig({ outputPath: destination });
  const metadata = await stat(destination);
  const config = JSON.parse(await readFile(destination, "utf8"));

  assert.equal(result.path, destination);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.match(config.AI_EMPLOYEE_DATA_KEY, /^keychain:\/\/foursday-[a-f0-9]{16}\/data-key$/u);
  assert.match(config.AI_EMPLOYEE_BACKUP_KEY, /^keychain:\/\/foursday-[a-f0-9]{16}\/backup-key$/u);
  assert.notEqual(config.AI_EMPLOYEE_DATA_KEY, config.AI_EMPLOYEE_BACKUP_KEY);
  assert.notEqual(
    config.AI_EMPLOYEE_ADMIN_READ_TOKEN,
    config.AI_EMPLOYEE_ADMIN_WRITE_TOKEN,
  );
  assert.equal(config.DWS_PATH, "dws");
  assert.equal(config.CODEX_PATH, "codex");
  assert.equal(config.CLAUDE_CODE_PATH, "claude");
  assert.equal(config.AI_EMPLOYEE_AGENT_RUNTIME, "codex");
  assert.equal(config.GBRAIN_PATH, "gbrain");
  assert.equal(
    config.AI_EMPLOYEE_GBRAIN_HOME,
    join(directory, "nested", "gbrain-runtime"),
  );
  assert.equal(config.AI_EMPLOYEE_GBRAIN_DATABASE_URL, "");
  assert.equal(config.AI_EMPLOYEE_MEMORY_AUTHORITY_MODE, "gbrain");
  assert.match(
    config.AI_EMPLOYEE_MEMORY_AUTHORITY_SOURCE_ID,
    /^foursday-[a-f0-9]{16}$/u,
  );
  assert.equal(config.AI_EMPLOYEE_MEMORY_AUTHORITY_WRITE, false);
  assert.equal(config.AI_EMPLOYEE_MEMORY_AUTHORITY_AUTO_CONFIRM, false);
  assert.equal(
    config.AI_EMPLOYEE_MEMORY_AUTHORITY_ROOT,
    join(directory, "nested", "gbrain", "brain"),
  );
  assert.equal(config.AI_EMPLOYEE_TENANT_ID, "");
  assert.equal(config.AI_EMPLOYEE_APPROVER, "");
  assert.equal(config.DINGTALK_TARGET_USER_IDS, "");
  assert.equal(config.DINGTALK_TARGET_GROUP_IDS, "");
  assert.equal(config.DINGTALK_SELF_USER_ID, "");
  assert.equal(config.DATABASE_URL, "");
  assert.equal(result.secretStorage, "keychain");
  assert.equal(result.generatedSecrets.length, 0);
  assert.deepEqual(result.externalSecretReferences, [
    "AI_EMPLOYEE_DATA_KEY",
    "AI_EMPLOYEE_BACKUP_KEY",
    "AI_EMPLOYEE_ADMIN_READ_TOKEN",
    "AI_EMPLOYEE_ADMIN_WRITE_TOKEN",
  ]);
  assert.deepEqual(result.requiredEdits, [
    "DATABASE_URL",
    "AI_EMPLOYEE_GBRAIN_DATABASE_URL",
    "AI_EMPLOYEE_TENANT_ID",
    "DINGTALK_TARGET_USER_IDS or DINGTALK_TARGET_GROUP_IDS",
    "DINGTALK_SELF_USER_ID",
    "AI_EMPLOYEE_APPROVER",
  ]);

  await assert.rejects(
    () => initializeProductionConfig({ outputPath: destination }),
    (error) => error.code === "EEXIST",
  );
});

test("two initialized workspaces never reuse a Keychain namespace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-config-pair-"));
  const firstPath = join(directory, "first.json");
  const secondPath = join(directory, "second.json");
  const first = await initializeProductionConfig({ outputPath: firstPath });
  const second = await initializeProductionConfig({ outputPath: secondPath });
  assert.notEqual(first.keychainService, second.keychainService);
});
