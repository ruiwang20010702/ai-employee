import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeProductionConfig } from "../scripts/初始化生产配置.mjs";

test("production config initializer writes protected unique secrets and refuses overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-config-"));
  const destination = join(directory, "nested", "production.json");
  const result = await initializeProductionConfig({ outputPath: destination });
  const metadata = await stat(destination);
  const config = JSON.parse(await readFile(destination, "utf8"));

  assert.equal(result.path, destination);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(Buffer.from(config.AI_EMPLOYEE_DATA_KEY, "base64").length, 32);
  assert.equal(Buffer.from(config.AI_EMPLOYEE_BACKUP_KEY, "base64").length, 32);
  assert.notEqual(config.AI_EMPLOYEE_DATA_KEY, config.AI_EMPLOYEE_BACKUP_KEY);
  assert.notEqual(
    config.AI_EMPLOYEE_ADMIN_READ_TOKEN,
    config.AI_EMPLOYEE_ADMIN_WRITE_TOKEN,
  );
  assert.equal(config.DWS_PATH, "dws");
  assert.equal(config.CODEX_PATH, "codex");
  assert.equal(config.GBRAIN_PATH, "gbrain");

  await assert.rejects(
    () => initializeProductionConfig({ outputPath: destination }),
    (error) => error.code === "EEXIST",
  );
});
