import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildFoursdayNativeInstallPlan,
  finishFoursdayNativeProfileInstall,
  foursdayNativeHermesLayout,
  inspectFoursdaySourceCommit,
  runFoursdayNativeHermesInstall,
  prepareNativeHermesInstallDirectory,
  recoverInterruptedNativeHermesInstall,
  stageFoursdayProfileDistribution,
} from "../src/foursday-hermes-native-install.mjs";

function lock(body) {
  return {
    repository: "https://github.com/NousResearch/hermes-agent.git",
    release: "v2026.8.18",
    version: "0.20.4",
    commit: "e".repeat(40),
    installerPath: "scripts/install.sh",
    installerSha256: createHash("sha256").update(body).digest("hex"),
  };
}

test("native Hermes plan uses official profile and Gateway surfaces without touching legacy", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-plan-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  const plan = buildFoursdayNativeInstallPlan({ lock: lock("x".repeat(10_000)), layout, installGateway: true });
  assert.equal(plan.layout.hermesHome, join(root, ".hermes"));
  assert.equal(plan.layout.profile, "foursday");
  assert.equal(plan.profile.gatewayInstallRequested, true);
  assert.equal(plan.legacyRuntimeTouched, false);
  assert.equal(plan.productionWrite, false);
});

test("source commit identity requires a clean worktree without hidden index flags", async () => {
  const head = "f".repeat(40);
  const run = async (_path, args) => {
    if (args.includes("rev-parse")) return { stdout: `${head}\n` };
    if (args.includes("status")) return { stdout: "" };
    if (args.includes("ls-files")) return { stdout: "H README.md\n" };
    throw new Error("unexpected command");
  };
  assert.equal(await inspectFoursdaySourceCommit("/private/project", {
    userHome: "/private/home",
    run,
  }), head);
  assert.equal(await inspectFoursdaySourceCommit("/private/project", {
    userHome: "/private/home",
    run: async (path, args, options) => {
      const result = await run(path, args, options);
      return args.includes("status") ? { stdout: " M README.md\n" } : result;
    },
  }), null);
  assert.equal(await inspectFoursdaySourceCommit("/private/project", {
    userHome: "/private/home",
    run: async (path, args, options) => {
      const result = await run(path, args, options);
      return args.includes("ls-files") ? { stdout: "h README.md\n" } : result;
    },
  }), null);
});

test("profile staging packages plugins, profile and skills without Python caches", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-stage-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "hermes", "profile"), { recursive: true });
  await mkdir(join(root, "hermes", "skills", "project-work"), { recursive: true });
  await writeFile(join(root, "hermes", "profile", "SOUL.md"), "# Foursday\n");
  await writeFile(join(root, "hermes", "skills", "project-work", "SKILL.md"), "# Skill\n");
  await mkdir(join(root, "src"));
  await mkdir(join(root, "scripts"));
  for (const name of [
    "hermes-dws-sidecar.mjs",
    "hermes-personal-memory-context.mjs",
    "hermes-memory-candidate-sidecar.mjs",
    "personal-gbrain-promoter.mjs",
  ]) await writeFile(join(root, "src", name), "// host\n");
  await writeFile(join(root, "scripts", "运行个人gbrain记忆晋升.mjs"), "// promoter\n");
  await mkdir(join(root, "hermes", "host"));
  await writeFile(join(root, "hermes", "host", "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  await writeFile(join(root, "hermes", "host", "package-lock.json"), JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: { "": { name: "fixture", version: "1.0.0" } },
  }));
  for (const name of [
    "dws_personal", "project_router", "foursday_boundary", "gbrain_memory",
    "foursday_work_twin",
  ]) {
    await mkdir(join(root, "hermes", "plugins", name), { recursive: true });
    await writeFile(join(root, "hermes", "plugins", name, "plugin.yaml"), `name: ${name}\n`);
    await writeFile(join(root, "hermes", "plugins", name, "__init__.py"), "# plugin\n");
  }
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  const result = await stageFoursdayProfileDistribution({
    layout,
    version: "0.6.0",
    hermesVersion: "0.20.4",
  });
  assert.equal(result.pluginCount, 1);
  assert.equal(result.componentPluginCount, 4);
  const distribution = await readFile(join(result.stage, "distribution.yaml"), "utf8");
  assert.match(distribution, /hermes_requires: '==0\.20\.4'/u);
  assert.match(distribution, /foursday-release\.json/u);
  assert.equal(JSON.parse(
    await readFile(join(result.stage, "foursday-release.json"), "utf8"),
  ).foursdayCommit, null);
  assert.match(await readFile(join(result.stage, "config.yaml"), "utf8"), /foursday-work-twin/u);
  await access(join(result.stage, "skills", "project-work", "SKILL.md"));
  await access(join(result.stage, "host", "src", "hermes-dws-sidecar.mjs"));
  await assert.rejects(access(join(result.stage, "host", "src", "worker.mjs")));
  assert.match(
    await readFile(join(result.stage, "scripts", "foursday-memory-promoter.sh"), "utf8"),
    /--quiet-idle/u,
  );
  const committed = await stageFoursdayProfileDistribution({
    layout,
    version: "0.6.0",
    hermesVersion: "0.20.4",
    foursdayCommit: "f".repeat(40),
    hermesCommit: "e".repeat(40),
    hermesRepository: "https://github.com/NousResearch/hermes-agent.git",
  });
  const release = JSON.parse(
    await readFile(join(committed.stage, "foursday-release.json"), "utf8"),
  );
  assert.equal(release.foursdayCommit, "f".repeat(40));
  assert.equal(release.hermesCommit, "e".repeat(40));
  assert.equal(release.hermesRepository, "https://github.com/NousResearch/hermes-agent.git");
});

test("native apply verifies installer digest, installs profile, doctors plugins and keeps Gateway stopped", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-apply-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from("#!/bin/sh\n" + "#".repeat(10_000));
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  const calls = [];
  const run = async (path, args) => {
    calls.push([path, args]);
    if (path === "/usr/bin/git" && args.includes("rev-parse")) {
      return { stdout: `${"e".repeat(40)}\n` };
    }
    if (path === "/bin/bash") {
      await mkdir(join(root, ".local", "bin"), { recursive: true });
      await writeFile(layout.hermesCommand, "#!/bin/sh\n", { mode: 0o700 });
      return { stdout: "" };
    }
    if (path === layout.hermesCommand && args[0] === "--version") {
      return { stdout: "Hermes Agent 0.20.4\n" };
    }
    if (path === layout.hermesCommand && args[0] === "profile") {
      await writeFile(layout.profileAlias, "#!/bin/sh\n", { mode: 0o700 });
      return { stdout: "" };
    }
    return { stdout: "" };
  };
  const result = await runFoursdayNativeHermesInstall({
    apply: true,
    lock: lock(body),
    layout,
    foursdayVersion: "0.6.0",
    run,
    fetchImpl: async () => new Response(body, { status: 200 }),
    stageProfile: async () => ({ stage: join(root, "stage") }),
    installHostDependencies: async () => {},
    bootstrapCheckout: async () => {},
  });
  assert.equal(result.installed, true);
  assert.equal(result.gatewayInstalled, false);
  assert.equal(result.gatewayStarted, false);
  assert.deepEqual(calls.map(([path, args]) => [path, args[0]]), [
    ["/bin/bash", calls[0][1][0]],
    ["/usr/bin/git", "-C"],
    [layout.hermesCommand, "--version"],
    [layout.hermesCommand, "profile"],
    [layout.hermesCommand, "profile"],
    [layout.hermesCommand, "profile"],
    [layout.profileAlias, "plugins"],
  ]);
});

test("interrupted native install journal restores the previous CLI on the next run", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-journal-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  const backup = `${layout.installDirectory}.backup`;
  await mkdir(layout.installDirectory, { recursive: true });
  await mkdir(backup);
  await writeFile(join(layout.installDirectory, "partial"), "partial");
  await writeFile(join(backup, "working"), "working");
  await mkdir(layout.hermesHome, { recursive: true });
  await writeFile(join(layout.hermesHome, ".foursday-native-install.json"), JSON.stringify({
    schema: "foursday-native-hermes-install-journal/v1",
    installDirectory: layout.installDirectory,
    backup,
    targetCommit: "e".repeat(40),
    createdAt: "2026-08-20T00:00:00Z",
  }), { mode: 0o600 });
  const result = await recoverInterruptedNativeHermesInstall(layout);
  assert.equal(result.recovered, true);
  await access(join(layout.installDirectory, "working"));
  await access(join(result.interrupted, "partial"));
  await assert.rejects(access(join(layout.hermesHome, ".foursday-native-install.json")));
});

test("native install refuses a changed official installer before running it", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-digest-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  let ran = false;
  await assert.rejects(
    runFoursdayNativeHermesInstall({
      apply: true,
      lock: { ...lock("x".repeat(10_000)), installerSha256: "0".repeat(64) },
      layout: foursdayNativeHermesLayout({ userHome: root, projectRoot: root }),
      foursdayVersion: "0.6.0",
      run: async () => { ran = true; return { stdout: "" }; },
      fetchImpl: async () => new Response("x".repeat(10_000), { status: 200 }),
    }),
    /digest mismatch/u,
  );
  assert.equal(ran, false);
});

test("untracked native installs are moved to a recoverable backup only after exact installer identity", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-existing-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from("#!/bin/sh\n" + "#".repeat(10_000));
  const upstream = lock(body);
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  await mkdir(join(layout.installDirectory, "scripts"), { recursive: true });
  await writeFile(join(layout.installDirectory, "scripts", "install.sh"), body);
  const result = await prepareNativeHermesInstallDirectory(layout, upstream);
  assert.ok(result.backup);
  await access(join(result.backup, "scripts", "install.sh"));
  await assert.rejects(access(layout.installDirectory));
});

test("native profile update refuses a running Gateway before changing files", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-running-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  await mkdir(layout.profileDirectory, { recursive: true });
  await mkdir(join(root, ".local", "bin"), { recursive: true });
  await writeFile(layout.hermesCommand, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(layout.profileAlias, "#!/bin/sh\n", { mode: 0o700 });
  const calls = [];
  await assert.rejects(
    finishFoursdayNativeProfileInstall({
      layout,
      lock: { version: "0.20.4" },
      foursdayVersion: "0.6.0",
      run: async (path, args) => {
        calls.push([path, args]);
        if (args[0] === "--version") return { stdout: "Hermes Agent 0.20.4\n" };
        if (args[0] === "gateway") return { stdout: "Gateway is running\n" };
        throw new Error("must not mutate profile");
      },
      stageProfile: async () => { throw new Error("must not stage"); },
    }),
    /Stop the Foursday Gateway/u,
  );
  assert.equal(calls.length, 2);
});

test("failed native profile update restores the official exported profile", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-rollback-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = foursdayNativeHermesLayout({ userHome: root, projectRoot: root });
  await mkdir(layout.profileDirectory, { recursive: true });
  await mkdir(join(root, ".local", "bin"), { recursive: true });
  await writeFile(layout.hermesCommand, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(layout.profileAlias, "#!/bin/sh\n", { mode: 0o700 });
  const calls = [];
  await assert.rejects(
    finishFoursdayNativeProfileInstall({
      layout,
      lock: { version: "0.20.4" },
      foursdayVersion: "0.6.0",
      run: async (path, args) => {
        calls.push([path, args]);
        if (args[0] === "--version") return { stdout: "Hermes Agent 0.20.4\n" };
        if (args[0] === "gateway") return { stdout: "Gateway is not running\n" };
        if (args[0] === "profile" && args[1] === "export") {
          await writeFile(args.at(-1), "private profile backup", { mode: 0o600 });
          return { stdout: "" };
        }
        if (args[0] === "profile" && args[1] === "update") {
          throw new Error("profile update failed");
        }
        return { stdout: "" };
      },
      stageProfile: async () => ({ stage: join(root, "stage") }),
      installHostDependencies: async () => {},
    }),
    /profile update failed/u,
  );
  const profileActions = calls
    .filter(([, args]) => args[0] === "profile")
    .map(([, args]) => args[1]);
  assert.deepEqual(profileActions, [
    "export", "install", "update", "alias", "delete", "import", "alias",
  ]);
});
