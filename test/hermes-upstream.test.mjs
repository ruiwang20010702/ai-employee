import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  hermesRuntimeLayout,
  validateHermesUpstreamLock,
} from "../src/hermes-upstream.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("Hermes 上游锁定到官方不可变提交并使用独立运行目录", async () => {
  const lock = validateHermesUpstreamLock(JSON.parse(await readFile(
    join(projectRoot, "hermes", "upstream.lock.json"),
    "utf8",
  )));
  assert.deepEqual(lock, {
    schemaVersion: 1,
    repository: "https://github.com/NousResearch/hermes-agent.git",
    release: "v2026.8.18",
    version: "0.20.4",
    commit: "e624e9fde561e1add9388384012b295fde669ade",
    license: "MIT",
    licenseSha256: "821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6",
    pythonRequires: ">=3.11,<3.14",
  });
  const layout = hermesRuntimeLayout(projectRoot);
  assert.match(layout.root, /\/\.runtime\/hermes-poc$/u);
  assert.equal(layout.source.startsWith(layout.root), true);
  assert.equal(layout.patched.startsWith(layout.root), true);
  assert.equal(layout.venv.startsWith(layout.root), true);
  assert.equal(layout.state.startsWith(layout.root), true);
  assert.equal(layout.root.includes("/.hermes"), false);
});

test("Hermes 锁拒绝可变引用、短提交、非官方仓库和宽松许可证", () => {
  const valid = {
    schemaVersion: 1,
    repository: "https://github.com/NousResearch/hermes-agent.git",
    release: "v2026.8.18",
    version: "0.20.4",
    commit: "e624e9fde561e1add9388384012b295fde669ade",
    license: "MIT",
    licenseSha256: "821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6",
    pythonRequires: ">=3.11,<3.14",
  };
  for (const candidate of [
    { ...valid, repository: "https://token@example.com/NousResearch/hermes-agent.git" },
    { ...valid, repository: "https://github.com/other/hermes-agent.git" },
    { ...valid, release: "main" },
    { ...valid, commit: "e624e9f" },
    { ...valid, license: "unknown" },
    { ...valid, licenseSha256: "0" },
    { ...valid, pythonRequires: ">=3.11" },
  ]) {
    assert.throws(() => validateHermesUpstreamLock(candidate));
  }
});
