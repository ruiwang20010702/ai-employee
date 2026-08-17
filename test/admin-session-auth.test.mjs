import assert from "node:assert/strict";
import test from "node:test";
import {
  adminSessionCookie,
  clearAdminSessionCookie,
  createAdminPasswordHash,
  createAdminSessionManager,
  normalizeAdminLoginIdentifiers,
  verifyAdminPassword,
} from "../src/admin-session-auth.mjs";

const identifiers = ["ruiwang", "ruiwang@example.com"];
const password = "correct horse battery staple";

test("管理密码使用固定参数 scrypt 哈希且不保存明文", async () => {
  const hash = await createAdminPasswordHash(password, {
    identifiers,
    salt: Buffer.alloc(16, 7),
  });
  assert.match(hash, /^scrypt\$32768\$8\$1\$/u);
  assert.doesNotMatch(hash, /correct|horse|battery|staple/u);
  assert.equal(await verifyAdminPassword(password, hash), true);
  assert.equal(await verifyAdminPassword("wrong password value", hash), false);
  await assert.rejects(
    createAdminPasswordHash("short", { identifiers }),
    /12-256 characters/u,
  );
  await assert.rejects(
    createAdminPasswordHash("ruiwang-is-the-password", { identifiers }),
    /must not contain a login identifier/u,
  );
  await assert.rejects(
    verifyAdminPassword(password, "scrypt$2$8$1$bad$bad"),
    /hash is invalid/u,
  );
});

test("用户名和邮箱归一化为同一所有者的登录别名", () => {
  assert.deepEqual(
    normalizeAdminLoginIdentifiers([" RuiWang ", "RUIWANG@example.com", "ruiwang"]),
    identifiers,
  );
  assert.throws(
    () => normalizeAdminLoginIdentifiers(["bad identifier"]),
    /username or email-like/u,
  );
});

test("密码登录签发有界会话并以 CSRF 保护写操作", async () => {
  let current = 1_000;
  const passwordHash = await createAdminPasswordHash(password, {
    identifiers,
    salt: Buffer.alloc(16, 9),
  });
  const manager = createAdminSessionManager({
    identifiers,
    passwordHash,
    sessionTtlMs: 300_000,
    now: () => current,
  });
  const login = await manager.login({
    identifier: "RUIWANG@example.com",
    password,
  });
  assert.equal(login.status, "authenticated");
  assert.equal(login.identifier, "ruiwang@example.com");
  const cookie = adminSessionCookie(login.token, 300_000);
  assert.match(cookie, /Path=\/; HttpOnly; SameSite=Strict; Max-Age=300/u);
  assert.doesNotMatch(cookie, /Secure/u);
  const session = manager.authenticate(cookie.split(";", 1)[0]);
  assert.equal(session.identifier, "ruiwang@example.com");
  assert.equal(manager.csrfAuthorized(session, login.csrfToken), true);
  assert.equal(manager.csrfAuthorized(session, "wrong"), false);

  current += 300_001;
  assert.equal(manager.authenticate(cookie.split(";", 1)[0]), null);
  assert.equal(clearAdminSessionCookie().includes("Max-Age=0"), true);
});

test("未知账号与错误密码使用同一失败结果并在五次失败后限流", async () => {
  let current = 10_000;
  const passwordHash = await createAdminPasswordHash(password, {
    identifiers,
    salt: Buffer.alloc(16, 11),
  });
  const manager = createAdminSessionManager({
    identifiers,
    passwordHash,
    now: () => current,
  });
  assert.deepEqual(
    await manager.login({ identifier: "unknown", password }),
    { status: "invalid" },
  );
  for (let attempt = 1; attempt < 5; attempt += 1) {
    assert.deepEqual(
      await manager.login({ identifier: "ruiwang", password: "wrong password value" }),
      { status: "invalid" },
    );
  }
  const blocked = await manager.login({ identifier: "ruiwang", password });
  assert.equal(blocked.status, "rate_limited");
  assert.equal(blocked.retryAfterSeconds, 900);
  current += 900_001;
  assert.equal((await manager.login({ identifier: "ruiwang", password })).status, "authenticated");
});

test("未配置密码登录时仍可保留旧令牌兼容通道", async () => {
  const manager = createAdminSessionManager();
  assert.equal(manager.configured, false);
  assert.deepEqual(await manager.login({ identifier: "ruiwang", password }), {
    status: "unavailable",
  });
});
