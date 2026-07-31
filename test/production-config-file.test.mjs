import assert from "node:assert/strict";
import { mkdtemp, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";

async function configFile(values, mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-config-"));
  const path = join(directory, "production.json");
  await writeFile(path, JSON.stringify(values), { mode });
  await chmod(path, mode);
  return path;
}

test("生产配置只接受白名单标量并写入指定环境", async () => {
  const path = await configFile({
    DATABASE_URL: "postgresql://example",
    DATABASE_POOL_MAX: 12,
    DATABASE_SSL: true,
  });
  const environment = {};
  await applyProductionConfigFile({ path, environment });
  assert.equal(environment.DATABASE_URL, "postgresql://example");
  assert.equal(environment.DATABASE_POOL_MAX, "12");
  assert.equal(environment.DATABASE_SSL, "true");
});

test("生产配置拒绝过宽文件权限", async () => {
  const path = await configFile({ DATABASE_URL: "postgresql://example" }, 0o644);
  await assert.rejects(
    applyProductionConfigFile({ path, environment: {} }),
    /must not be readable/u,
  );
});

test("生产配置拒绝未知键和复合值", async () => {
  const unknownPath = await configFile({ SHELL: "/bin/sh" });
  await assert.rejects(
    applyProductionConfigFile({ path: unknownPath, environment: {} }),
    /Unsupported config key/u,
  );
  const objectPath = await configFile({ DATABASE_URL: { value: "bad" } });
  await assert.rejects(
    applyProductionConfigFile({ path: objectPath, environment: {} }),
    /must be scalar/u,
  );
});
