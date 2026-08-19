import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createHermesReleaseIdentity,
  requiredHermesReleaseFiles,
  verifyHermesReleaseIdentity,
} from "../src/hermes-release-identity.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "foursday-hermes-identity-"));
  const canonical = await (await import("node:fs/promises")).realpath(root);
  t.after(() => rm(canonical, { recursive: true, force: true }));
  for (const path of requiredHermesReleaseFiles) {
    const target = join(canonical, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, `${path}\n`, { mode: 0o600 });
  }
  return canonical;
}

test("Hermes release identity 绑定精确提交和全部关键运行文件", async (t) => {
  const root = await fixture(t);
  const releaseSha = "a".repeat(40);
  const identity = await createHermesReleaseIdentity({
    releaseSha,
    releaseRoot: root,
    createdAt: new Date("2026-08-18T12:00:00.000Z"),
  });
  assert.equal(Object.keys(identity.files).length, requiredHermesReleaseFiles.length);
  assert.deepEqual(await verifyHermesReleaseIdentity({
    identity,
    releaseSha,
    releaseRoot: root,
  }), {
    valid: true,
    releaseSha,
    fileCount: requiredHermesReleaseFiles.length,
  });
});

test("Hermes release identity 拒绝内容漂移和符号链接替换", async (t) => {
  const root = await fixture(t);
  const releaseSha = "a".repeat(40);
  const identity = await createHermesReleaseIdentity({ releaseSha, releaseRoot: root });
  const path = join(root, requiredHermesReleaseFiles[0]);
  await writeFile(path, "changed\n", { mode: 0o600 });
  await assert.rejects(
    verifyHermesReleaseIdentity({ identity, releaseSha, releaseRoot: root }),
    /changed after identity/u,
  );
  await rm(path);
  const outside = join(root, "outside");
  await writeFile(outside, "outside\n", { mode: 0o600 });
  await symlink(outside, path);
  await assert.rejects(
    verifyHermesReleaseIdentity({ identity, releaseSha, releaseRoot: root }),
    /must be regular/u,
  );
});
