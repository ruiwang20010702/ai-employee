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

test("Codex 草稿失败区分执行故障和结构无效", () => {
  assert.equal(
    safeErrorCode(new Error("Codex draft execution failed [exit=1 stderrSha256=secret]")),
    "codex_execution_failed",
  );
  assert.equal(
    safeErrorCode(new Error("Codex returned an invalid draft with private content")),
    "codex_output_invalid",
  );
  const receiptError = new Error("private receipt content");
  receiptError.code = "dws_send_receipt_unknown";
  assert.equal(safeErrorCode(receiptError), "dws_send_receipt_unknown");
});
