import assert from "node:assert/strict";
import test from "node:test";
import { safeCodexEnvironment } from "../src/codex-environment.mjs";

test("Codex child receives runtime essentials but no business secrets", () => {
  const environment = safeCodexEnvironment("/opt/tools/codex", {
    HOME: "/Users/example",
    CODEX_HOME: "/Users/example/.codex",
    LANG: "zh_CN.UTF-8",
    HTTPS_PROXY: "https://proxy.example",
    DATABASE_URL: "postgresql://secret",
    AI_EMPLOYEE_DATA_KEY: "data-secret",
    AI_EMPLOYEE_ADMIN_WRITE_TOKEN: "admin-secret",
    DINGTALK_SELF_USER_ID: "private-user",
    OPENAI_API_KEY: "model-secret",
  });

  assert.equal(environment.HOME, "/Users/example");
  assert.equal(environment.CODEX_HOME, "/Users/example/.codex");
  assert.equal(environment.HTTPS_PROXY, "https://proxy.example");
  assert.match(environment.PATH, /^\/opt\/tools:/);
  assert.equal(environment.CI, "1");
  assert.equal(environment.TERM, "xterm-256color");
  for (const forbidden of [
    "DATABASE_URL",
    "AI_EMPLOYEE_DATA_KEY",
    "AI_EMPLOYEE_ADMIN_WRITE_TOKEN",
    "DINGTALK_SELF_USER_ID",
    "OPENAI_API_KEY",
  ]) {
    assert.equal(environment[forbidden], undefined);
  }
});

test("Codex child preserves a usable terminal type", () => {
  assert.equal(
    safeCodexEnvironment("codex", { TERM: "screen-256color" }).TERM,
    "screen-256color",
  );
  assert.equal(
    safeCodexEnvironment("codex", { TERM: "dumb" }).TERM,
    "xterm-256color",
  );
});
