import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyAdminPassword } from "../src/admin-session-auth.mjs";
import { configureAdminLogin } from "../scripts/设置管理台登录.mjs";

test("管理台账户配置帮助命令正常退出且不要求密码", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/设置管理台登录.mjs", import.meta.url)), "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--identifier <username-or-email>/u);
  assert.equal(result.stderr, "");
});

test("管理台账户配置默认零写，显式应用只保存哈希并保留双令牌", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-admin-login-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "production.json");
  const original = {
    DATABASE_URL: "env://DATABASE_URL",
    AI_EMPLOYEE_ADMIN_READ_TOKEN: "env://ADMIN_READ_TOKEN",
    AI_EMPLOYEE_ADMIN_WRITE_TOKEN: "env://ADMIN_WRITE_TOKEN",
  };
  await writeFile(configPath, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  const options = {
    configPath,
    identifiers: [" RuiWang ", "RuiWang@example.com"],
    password: "correct horse battery staple",
    sessionTtlMs: 7_200_000,
  };

  const preview = await configureAdminLogin(options);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.configured, false);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), original);

  const result = await configureAdminLogin({ ...options, apply: true });
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(result.configured, true);
  assert.equal(result.passwordStored, false);
  assert.equal(result.passwordHashPrinted, false);
  assert.equal(result.legacyTokensPreserved, true);
  assert.equal(saved.AI_EMPLOYEE_ADMIN_READ_TOKEN, original.AI_EMPLOYEE_ADMIN_READ_TOKEN);
  assert.equal(saved.AI_EMPLOYEE_ADMIN_WRITE_TOKEN, original.AI_EMPLOYEE_ADMIN_WRITE_TOKEN);
  assert.equal(saved.AI_EMPLOYEE_ADMIN_LOGIN_IDENTIFIERS, "ruiwang,ruiwang@example.com");
  assert.equal(saved.AI_EMPLOYEE_ADMIN_SESSION_TTL_MS, 7_200_000);
  assert.doesNotMatch(saved.AI_EMPLOYEE_ADMIN_PASSWORD_HASH, /correct|horse|battery|staple/u);
  assert.equal(
    await verifyAdminPassword(
      "correct horse battery staple",
      saved.AI_EMPLOYEE_ADMIN_PASSWORD_HASH,
    ),
    true,
  );
  assert.equal((await stat(configPath)).mode & 0o077, 0);
  assert.doesNotMatch(JSON.stringify(result), /correct|horse|battery|staple|scrypt\$/u);
  await assert.rejects(
    configureAdminLogin({ ...options, apply: true }),
    /already configured/u,
  );
});

test("管理台账户配置拒绝通过符号链接覆盖配置", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-admin-login-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const realPath = join(directory, "production.json");
  const linkPath = join(directory, "linked-production.json");
  await writeFile(realPath, `${JSON.stringify({ DATABASE_URL: "env://DATABASE_URL" })}\n`, {
    mode: 0o600,
  });
  await symlink(realPath, linkPath);
  await assert.rejects(
    configureAdminLogin({
      configPath: linkPath,
      identifiers: ["owner"],
      password: "correct horse battery staple",
    }),
    /non-symlink/u,
  );
});
