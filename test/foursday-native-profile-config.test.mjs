import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { foursdayNativeHermesLayout } from "../src/foursday-hermes-native-install.mjs";
import {
  buildFoursdayNativeProfileConfiguration,
  configureFoursdayNativeProfile,
  ensureFoursdayMemoryPromoterCron,
} from "../src/foursday-native-profile-config.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-config-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  const production = join(root, "production.json");
  const registry = join(root, "projects.json");
  const node = join(root, "node");
  const dws = join(root, "dws");
  await writeFile(production, JSON.stringify({
    DATABASE_URL: "keychain://service/database",
    AI_EMPLOYEE_DATA_KEY: "keychain://service/data",
    DINGTALK_TARGET_USER_IDS: "trusted-user",
    DINGTALK_TARGET_GROUP_IDS: "trusted-group",
    DINGTALK_SELF_USER_ID: "owner",
  }), { mode: 0o600 });
  await writeFile(registry, JSON.stringify({ schemaVersion: 1, projects: [] }), { mode: 0o600 });
  await writeFile(node, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(dws, "#!/bin/sh\n", { mode: 0o700 });
  return {
    root,
    production,
    registry,
    node,
    dws,
    layout: foursdayNativeHermesLayout({ userHome: root, projectRoot: project }),
  };
}

test("native profile config contains paths and allowlists but no resolved secrets", async (t) => {
  const value = await fixture(t);
  const plan = await buildFoursdayNativeProfileConfiguration({
    layout: value.layout,
    productionConfigPath: value.production,
    projectRegistryPath: value.registry,
    nodePath: value.node,
    dwsPath: value.dws,
  });
  assert.equal(plan.mode, "shadow");
  assert.equal(plan.sendEnabled, false);
  assert.equal(plan.secretsCopied, false);
  assert.match(plan.envContent, /DWS_PERSONAL_ALLOWED_USERS="trusted-user"/u);
  assert.match(plan.envContent, /DWS_PERSONAL_SEND_ENABLED="false"/u);
  assert.doesNotMatch(plan.envContent, /keychain|database|service\/data/u);
});

test("native profile config writes private user-owned files idempotently and requires explicit replace", async (t) => {
  const value = await fixture(t);
  await mkdir(value.layout.profileDirectory, { recursive: true });
  const options = {
    layout: value.layout,
    productionConfigPath: value.production,
    projectRegistryPath: value.registry,
    nodePath: value.node,
    dwsPath: value.dws,
    apply: true,
  };
  const first = await configureFoursdayNativeProfile(options);
  const second = await configureFoursdayNativeProfile(options);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal((await readFile(join(value.layout.profileDirectory, ".env"), "utf8")).includes("send=true"), false);
  await writeFile(value.production, JSON.stringify({
    DATABASE_URL: "keychain://service/database",
    AI_EMPLOYEE_DATA_KEY: "keychain://service/data",
    DINGTALK_TARGET_USER_IDS: "another-user",
  }), { mode: 0o600 });
  await assert.rejects(configureFoursdayNativeProfile(options), /different content/u);
  const replaced = await configureFoursdayNativeProfile({ ...options, replace: true });
  assert.equal(replaced.backupsCreated > 0, true);
});

test("native profile config rejects inline production secrets", async (t) => {
  const value = await fixture(t);
  await writeFile(value.production, JSON.stringify({ DATABASE_URL: "postgresql://inline" }), { mode: 0o600 });
  await assert.rejects(
    buildFoursdayNativeProfileConfiguration({
      layout: value.layout,
      productionConfigPath: value.production,
      projectRegistryPath: value.registry,
      nodePath: value.node,
      dwsPath: value.dws,
    }),
    /externally referenced/u,
  );
});

test("memory promotion cron is created through Hermes and exact read-back is required", async (t) => {
  const value = await fixture(t);
  await mkdir(join(value.layout.profileDirectory, "cron"), { recursive: true });
  const jobsPath = join(value.layout.profileDirectory, "cron", "jobs.json");
  await writeFile(jobsPath, "[]\n");
  const preview = await ensureFoursdayMemoryPromoterCron({ layout: value.layout });
  assert.equal(preview.created, false);
  const result = await ensureFoursdayMemoryPromoterCron({
    layout: value.layout,
    apply: true,
    run: async (_path, args) => {
      assert.deepEqual(args, [
        "cron", "create", "every 1m",
        "--no-agent", "--script", "foursday-memory-promoter.sh",
        "--name", "foursday-memory-promoter",
      ]);
      await writeFile(jobsPath, `${JSON.stringify([{
        id: "job-1",
        name: "foursday-memory-promoter",
        script: "foursday-memory-promoter.sh",
        no_agent: true,
        enabled: true,
        schedule: { kind: "interval", seconds: 60 },
      }])}\n`);
      return { stdout: "" };
    },
  });
  assert.deepEqual(result, {
    apply: true,
    created: true,
    verified: true,
    jobId: "job-1",
  });
  const idempotent = await ensureFoursdayMemoryPromoterCron({
    layout: value.layout,
    apply: true,
    run: async () => { throw new Error("must not recreate"); },
  });
  assert.equal(idempotent.created, false);
});
