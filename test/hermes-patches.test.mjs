import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateHermesPatchLock } from "../src/hermes-patches.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("Hermes 极薄补丁绑定上游提交、文件和摘要", async () => {
  const lock = validateHermesPatchLock(JSON.parse(await readFile(
    join(projectRoot, "hermes", "patches.lock.json"),
    "utf8",
  )));
  assert.equal(lock.baseCommit, "e624e9fde561e1add9388384012b295fde669ade");
  assert.deepEqual(lock.patches, [{
    path: "hermes/patches/0001-gateway-session-workspace.patch",
    sha256: "5b68dfca43c5806364b2e912745e3bc7ab2fadab34001323eaeec90ef0ef7c89",
    purpose: "Allow a trusted messaging adapter to persist and bind a project workspace per session",
  }]);
});

test("Hermes 补丁锁拒绝越界路径、短 SHA 和重复补丁", () => {
  const patch = {
    path: "hermes/patches/0001.patch",
    sha256: "a".repeat(64),
    purpose: "Session workspace contract",
  };
  const base = {
    schemaVersion: 1,
    baseCommit: "e624e9fde561e1add9388384012b295fde669ade",
    patches: [patch],
  };
  for (const candidate of [
    { ...base, baseCommit: "e624e9f" },
    { ...base, patches: [{ ...patch, path: "../outside.patch" }] },
    { ...base, patches: [{ ...patch, sha256: "bad" }] },
    { ...base, patches: [patch, patch] },
  ]) {
    assert.throws(() => validateHermesPatchLock(candidate));
  }
});
