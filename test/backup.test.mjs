import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const backupScript = resolve("scripts/备份数据库.mjs");
const restoreScript = resolve("scripts/恢复数据库.mjs");
const key = Buffer.alloc(32, 9).toString("base64");

async function executable(path, content) {
  await writeFile(path, content, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-backup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function environment(directory, pgDumpPath) {
  return {
    ...process.env,
    DATABASE_URL: "postgresql://user:password@127.0.0.1:5432/database",
    AI_EMPLOYEE_BACKUP_KEY: key,
    AI_EMPLOYEE_BACKUP_DIRECTORY: directory,
    PG_DUMP_PATH: pgDumpPath,
  };
}

test("备份成功后原子发布且可以通过认证解密恢复", async (t) => {
  const directory = await fixture(t);
  const dumpPath = join(directory, "pg_dump");
  const restorePath = join(directory, "pg_restore");
  const restoredPath = join(directory, "restored.dump");
  await executable(dumpPath, "#!/bin/sh\nprintf 'verified-dump-content'\n");
  await executable(
    restorePath,
    "#!/bin/sh\ncat > \"$FAKE_RESTORE_OUTPUT\"\n",
  );

  const { stdout } = await execFileAsync(process.execPath, [backupScript], {
    env: environment(directory, dumpPath),
  });
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.completed, true);
  const backupFiles = (await readdir(directory)).filter((name) =>
    name.endsWith(".dump.enc"),
  );
  assert.equal(backupFiles.length, 1);
  const destination = join(directory, backupFiles[0]);
  const encrypted = await readFile(destination);
  assert.equal(encrypted.includes(Buffer.from("verified-dump-content")), false);
  assert.equal(
    (await readdir(directory)).some((name) => name.endsWith(".partial")),
    false,
  );

  await execFileAsync(process.execPath, [restoreScript, destination], {
    env: {
      ...environment(directory, dumpPath),
      PG_RESTORE_PATH: restorePath,
      FAKE_RESTORE_OUTPUT: restoredPath,
      AI_EMPLOYEE_CONFIRM_RESTORE: "yes",
    },
  });
  assert.equal(await readFile(restoredPath, "utf8"), "verified-dump-content");
});

test("pg_dump 失败时不会留下可误认的最终备份", async (t) => {
  const directory = await fixture(t);
  const dumpPath = join(directory, "pg_dump");
  await executable(
    dumpPath,
    "#!/bin/sh\nprintf 'partial-content'\nprintf 'failed' >&2\nexit 2\n",
  );
  await assert.rejects(
    execFileAsync(process.execPath, [backupScript], {
      env: environment(directory, dumpPath),
    }),
  );
  const files = await readdir(directory);
  assert.deepEqual(files, ["pg_dump"]);
});
