import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSafeTemporaryTestDirectory,
  isolatedTestEnvironment,
  runCompleteTest,
  versionedDirectories,
} from "../scripts/运行完整测试.mjs";

test("完整测试运行器只清理系统临时目录中的专用随机目录", () => {
  const systemTemporaryDirectory = "/tmp";
  assert.equal(
    assertSafeTemporaryTestDirectory(
      join(systemTemporaryDirectory, "foursday-pgtest-abc123"),
      systemTemporaryDirectory,
    ),
    join(systemTemporaryDirectory, "foursday-pgtest-abc123"),
  );
  assert.throws(
    () => assertSafeTemporaryTestDirectory("/tmp/other-project", systemTemporaryDirectory),
    /不在允许范围/u,
  );
  assert.throws(
    () => assertSafeTemporaryTestDirectory("/tmp/foursday-pgtest-abc/nested", systemTemporaryDirectory),
    /不在允许范围/u,
  );
});

test("完整测试子进程不继承生产连接和业务密钥", () => {
  const environment = isolatedTestEnvironment({
    PATH: "/usr/bin:/bin",
    LANG: "zh_CN.UTF-8",
    DATABASE_URL: "production-database",
    FOURSDAY_DATA_KEY: "production-key",
    FOURSDAY_CONFIG_FILE: "production-config",
    DINGTALK_SELF_USER_ID: "production-user",
    DWS_PATH: "/production/dws",
    CLAUDE_CODE_PATH: "/production/claude",
    ANTHROPIC_API_KEY: "production-anthropic-key",
    PGPASSWORD: "production-password",
    TEST_DATABASE_URL: "old-test-database",
  }, "postgresql://test@127.0.0.1:55433/foursday_test");
  assert.equal(environment.PATH, "/usr/bin:/bin");
  assert.equal(environment.LANG, "zh_CN.UTF-8");
  assert.equal(environment.TEST_DATABASE_TEMP, "false");
  assert.equal(
    environment.TEST_DATABASE_URL,
    "postgresql://test@127.0.0.1:55433/foursday_test",
  );
  for (const key of [
    "DATABASE_URL",
    "FOURSDAY_DATA_KEY",
    "FOURSDAY_CONFIG_FILE",
    "DINGTALK_SELF_USER_ID",
    "DWS_PATH",
    "CLAUDE_CODE_PATH",
    "ANTHROPIC_API_KEY",
    "PGPASSWORD",
  ]) assert.equal(Object.hasOwn(environment, key), false);
});

test("完整测试可以识别 Homebrew 版本目录符号链接", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "foursday-postgres-links-"));
  const target = join(fixture, "postgresql-17.9");
  const link = join(fixture, "postgresql@17");
  try {
    await mkdir(join(target, "bin"), { recursive: true });
    await symlink(target, link);
    assert.deepEqual(await versionedDirectories(fixture), [join(link, "bin")]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("完整测试失败后仍停止临时数据库并清理专用目录", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "foursday-runner-fixture-"));
  const postgresBin = join(fixture, "postgres-bin");
  const isolatedTemporaryDirectory = join(fixture, "tmp");
  const project = join(fixture, "project");
  const stopReceipt = join(fixture, "stopped.txt");
  await Promise.all([
    mkdir(postgresBin),
    mkdir(isolatedTemporaryDirectory),
    mkdir(join(project, "test"), { recursive: true }),
  ]);
  const executable = async (name, body) => {
    const path = join(postgresBin, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    await chmod(path, 0o700);
  };
  try {
    await executable("initdb", "exit 0");
    await executable(
      "pg_ctl",
      `case " $* " in *" stop "*) printf stopped > ${JSON.stringify(stopReceipt)};; esac\nexit 0`,
    );
    await executable("createdb", "exit 0");
    await writeFile(join(project, "package.json"), JSON.stringify({
      name: "complete-test-failure-fixture",
      private: true,
      scripts: { check: "node -e \"process.exit(7)\"" },
    }));
    await writeFile(join(project, "test", "fixture.test.mjs"), "// fixture\n");
    await assert.rejects(
      () => runCompleteTest({
        environment: { PATH: process.env.PATH },
        root: project,
        postgresBin,
        systemTemporaryDirectory: isolatedTemporaryDirectory,
      }),
      /完整测试失败，退出码/u,
    );
    assert.equal(await readFile(stopReceipt, "utf8"), "stopped");
    assert.deepEqual(await readdir(isolatedTemporaryDirectory), []);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("发布安装包缺少源码测试时不会启动临时数据库", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "foursday-no-source-tests-"));
  try {
    await assert.rejects(
      runCompleteTest({
        root: fixture,
        postgresBin: "/must-not-be-used",
      }),
      /只能在包含 test 目录的源码仓库中运行/u,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
