import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("Foursday package publishes the locked Hermes distribution sources without caches", async (t) => {
  const npmCache = await mkdtemp(join(tmpdir(), "foursday-npm-pack-"));
  t.after(() => rm(npmCache, { recursive: true, force: true }));

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await execFileAsync(
    npm,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        npm_config_cache: npmCache,
        npm_config_update_notifier: "false",
      },
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
    },
  );

  const packs = JSON.parse(stdout);
  assert.equal(packs.length, 1);
  const packagedFiles = packs[0].files.map(({ path }) => path);
  for (const path of [
    "distribution/upstream.lock.json",
    "distribution/plugins/dws_personal/__init__.py",
    "distribution/plugins/dws_personal/adapter.py",
    "distribution/plugins/dws_personal/bridge.py",
    "distribution/plugins/dws_personal/memory.py",
    "distribution/plugins/dws_personal/plugin.yaml",
    "distribution/plugins/foursday_work_twin/__init__.py",
    "distribution/plugins/foursday_work_twin/plugin.yaml",
    "distribution/plugins/project_router/runtime_context.py",
    "distribution/host/package.json",
    "distribution/host/package-lock.json",
    "distribution/profile/SOUL.md",
    "distribution/skills/project-work/SKILL.md",
    "scripts/安装Foursday运行时.mjs",
    "scripts/配置Foursday运行时.mjs",
    "scripts/管理FoursdayGateway.mjs",
    "scripts/运行个人gbrain记忆晋升.mjs",
    "scripts/生成Foursday影子验收.mjs",
    "src/hermes-shadow-acceptance.mjs",
    "src/foursday-hermes-native-install.mjs",
    "src/foursday-native-profile-config.mjs",
    "src/foursday-native-gateway.mjs",
    "src/hermes-memory-candidate-sidecar.mjs",
    "src/personal-gbrain-candidate.mjs",
    "src/personal-gbrain-candidate-store.mjs",
    "src/personal-gbrain-promoter.mjs",
    "src/personal-gbrain-writer.mjs",
    "db/schema.sql",
  ]) {
    assert.ok(packagedFiles.includes(path), `missing packaged file: ${path}`);
  }
  assert.equal(packagedFiles.some((path) => path.startsWith("distribution/patches/")), false);
  assert.equal(packagedFiles.some((path) => path.includes("legacy")), false);
  assert.equal(packagedFiles.filter((path) => path.includes("/__pycache__/")).length, 0);
  assert.equal(packagedFiles.filter((path) => path.endsWith(".pyc")).length, 0);
});
