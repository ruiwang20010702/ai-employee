import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { requiredHermesReleaseFiles } from "../src/hermes-release-identity.mjs";

const execFileAsync = promisify(execFile);
const releaseSha = "a".repeat(40);

test("Hermes release identity 默认零写并按精确文件生成", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-identity-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of requiredHermesReleaseFiles) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, `${path}\n`, { mode: 0o600 });
  }
  const output = join(root, "identity.json");
  const baseArgs = [
    "scripts/生成Hermes发布身份.mjs",
    "--release-sha",
    releaseSha,
    "--release-root",
    root,
    "--output",
    output,
  ];
  const preview = JSON.parse((await execFileAsync(process.execPath, baseArgs, {
    cwd: new URL("../", import.meta.url),
  })).stdout);
  assert.equal(preview.applied, false);
  assert.equal(preview.productionWrite, false);
  assert.equal(preview.fileCount, requiredHermesReleaseFiles.length);
  await assert.rejects(access(output), { code: "ENOENT" });

  const applied = JSON.parse((await execFileAsync(
    process.execPath,
    [...baseArgs, "--apply"],
    { cwd: new URL("../", import.meta.url) },
  )).stdout);
  assert.equal(applied.applied, true);
  const identity = JSON.parse(await readFile(output, "utf8"));
  assert.equal(identity.releaseSha, releaseSha);
  assert.equal((await stat(output)).mode & 0o077, 0);
});
