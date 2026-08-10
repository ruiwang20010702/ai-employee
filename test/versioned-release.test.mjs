import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activateVersionedRelease,
  prepareVersionedRelease,
} from "../scripts/准备版本化发布.mjs";

const sha = "a".repeat(40);

async function releaseFixture(directory) {
  await mkdir(join(directory, ".runtime"), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "package.json"), "{}\n", { mode: 0o600 });
  await writeFile(join(directory, ".runtime", "production.json"), "{}\n", {
    mode: 0o600,
  });
  await chmod(join(directory, ".runtime", "production.json"), 0o600);
}

test("准备、激活和下一次准备形成可验证的版本链", async () => {
  const base = await mkdtemp(join(tmpdir(), "ai-employee-release-"));
  const root = join(base, "ai-employee-production");
  const environmentFile = join(base, "github-env");
  await writeFile(environmentFile, "", { mode: 0o600 });

  const first = await prepareVersionedRelease({
    root,
    sha,
    runId: "101",
    attempt: "1",
    environmentFile,
  });
  assert.equal(first.hasPreviousRelease, false);
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.equal((await lstat(first.releaseDirectory)).mode & 0o777, 0o700);
  await releaseFixture(first.releaseDirectory);
  const activated = await activateVersionedRelease({
    root,
    releaseDirectory: first.releaseDirectory,
    runId: "101",
    attempt: "1",
  });
  assert.equal(activated.activated, true);
  assert.equal(await realpath(join(root, "current")), first.releaseDirectory);

  const secondEnvironment = join(base, "github-env-second");
  await writeFile(secondEnvironment, "", { mode: 0o600 });
  const second = await prepareVersionedRelease({
    root,
    sha: "b".repeat(40),
    runId: "102",
    attempt: "1",
    environmentFile: secondEnvironment,
  });
  assert.equal(second.hasPreviousRelease, true);
  const exported = await readFile(secondEnvironment, "utf8");
  assert.match(exported, new RegExp(`AI_EMPLOYEE_PREVIOUS_RELEASE=${first.releaseDirectory}`));
});

test("拒绝过宽部署根目录、越界版本和非符号链接 current", async () => {
  const base = await mkdtemp(join(tmpdir(), "ai-employee-release-guard-"));
  const environmentFile = join(base, "github-env");
  await writeFile(environmentFile, "", { mode: 0o600 });
  await assert.rejects(
    prepareVersionedRelease({
      root: homedir(),
      sha,
      runId: "1",
      attempt: "1",
      environmentFile,
    }),
    /too broad/u,
  );

  const root = join(base, "ai-employee-production");
  const prepared = await prepareVersionedRelease({
    root,
    sha,
    runId: "2",
    attempt: "1",
    environmentFile,
  });
  const outside = join(base, "outside");
  await releaseFixture(outside);
  await assert.rejects(
    activateVersionedRelease({
      root,
      releaseDirectory: outside,
      runId: "2",
      attempt: "1",
    }),
    /escaped/u,
  );

  await writeFile(join(root, "current"), "not-a-link", { mode: 0o600 });
  await releaseFixture(prepared.releaseDirectory);
  await assert.rejects(
    activateVersionedRelease({
      root,
      releaseDirectory: prepared.releaseDirectory,
      runId: "2",
      attempt: "1",
    }),
    /symbolic link/u,
  );
});

test("拒绝指向越界或权限过宽配置的上一版本", async () => {
  const base = await mkdtemp(join(tmpdir(), "ai-employee-release-current-"));
  const root = join(base, "ai-employee-production");
  const releases = join(root, "releases");
  const outside = join(base, "outside");
  await mkdir(releases, { recursive: true, mode: 0o700 });
  await releaseFixture(outside);
  await symlink(outside, join(root, "current"));
  const environmentFile = join(base, "github-env");
  await writeFile(environmentFile, "", { mode: 0o600 });
  await assert.rejects(
    prepareVersionedRelease({
      root,
      sha,
      runId: "3",
      attempt: "1",
      environmentFile,
    }),
    /escaped/u,
  );

  const protectedRoot = join(base, "nested", "ai-employee-production");
  const protectedReleases = join(protectedRoot, "releases");
  const unsafeRelease = join(protectedReleases, "unsafe-release");
  await releaseFixture(unsafeRelease);
  await chmod(join(unsafeRelease, ".runtime", "production.json"), 0o644);
  await symlink(unsafeRelease, join(protectedRoot, "current"));
  await assert.rejects(
    prepareVersionedRelease({
      root: protectedRoot,
      sha,
      runId: "4",
      attempt: "1",
      environmentFile,
    }),
    /permissions are too broad/u,
  );
});

test("激活校验失败时恢复上一版本链接", async () => {
  const base = await mkdtemp(join(tmpdir(), "ai-employee-release-rollback-"));
  const root = join(base, "ai-employee-production");
  const environmentFile = join(base, "github-env");
  await writeFile(environmentFile, "", { mode: 0o600 });
  const first = await prepareVersionedRelease({
    root,
    sha,
    runId: "201",
    attempt: "1",
    environmentFile,
  });
  await releaseFixture(first.releaseDirectory);
  await activateVersionedRelease({
    root,
    releaseDirectory: first.releaseDirectory,
    runId: "201",
    attempt: "1",
  });
  const second = await prepareVersionedRelease({
    root,
    sha: "b".repeat(40),
    runId: "202",
    attempt: "1",
    environmentFile,
  });
  await releaseFixture(second.releaseDirectory);

  await assert.rejects(
    activateVersionedRelease({
      root,
      releaseDirectory: second.releaseDirectory,
      runId: "202",
      attempt: "1",
      verifyActivation: async () => {
        throw new Error("simulated activation verification failure");
      },
    }),
    /simulated activation verification failure/u,
  );
  assert.equal(await realpath(join(root, "current")), first.releaseDirectory);
});
