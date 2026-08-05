import assert from "node:assert/strict";
import test from "node:test";
import { safeErrorCode } from "../src/logging.mjs";

test("日志错误只保留稳定分类，不泄露标识和地址", () => {
  const code = safeErrorCode(
    new Error("request timeout for https://gateway.example/users/secret-user-id"),
  );
  assert.equal(code, "request_timeout");
  assert.doesNotMatch(code, /secret|gateway|https/u);
});
