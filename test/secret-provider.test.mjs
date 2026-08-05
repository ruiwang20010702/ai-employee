import assert from "node:assert/strict";
import test from "node:test";
import {
  isSecretReference,
  resolveSecretReference,
} from "../src/secret-provider.mjs";

test("环境变量密钥引用只返回来源类型且不改变值", async () => {
  const secret = "not-printed-secret";
  const result = await resolveSecretReference("env://DATABASE_SECRET", {
    environment: { DATABASE_SECRET: secret },
  });
  assert.deepEqual(result, { value: secret, source: "environment" });
  assert.equal(isSecretReference("postgresql://localhost/database"), false);
});

test("钥匙串引用解码固定服务和账号并支持注入测试适配器", async () => {
  const calls = [];
  const result = await resolveSecretReference(
    "keychain://ai-employee/admin%2Fread",
    {
      keychainReader: async (service, account) => {
        calls.push({ service, account });
        return "keychain-secret";
      },
    },
  );
  assert.deepEqual(calls, [{ service: "ai-employee", account: "admin/read" }]);
  assert.equal(result.source, "macos-keychain");
  assert.equal(result.value, "keychain-secret");
});

test("缺失密钥和畸形引用安全失败且错误不包含引用名称", async () => {
  await assert.rejects(
    resolveSecretReference("env://PRIVATE_NAME", { environment: {} }),
    (error) => {
      assert.doesNotMatch(error.message, /PRIVATE_NAME/u);
      return /unavailable/u.test(error.message);
    },
  );
  await assert.rejects(
    resolveSecretReference("keychain://missing-part"),
    /format is invalid/u,
  );
});
