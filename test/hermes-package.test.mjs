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
    "hermes/upstream.lock.json",
    "hermes/patches.lock.json",
    "hermes/patches/0001-gateway-session-workspace.patch",
    "hermes/plugins/dws_personal/__init__.py",
    "hermes/plugins/dws_personal/adapter.py",
    "hermes/plugins/dws_personal/bridge.py",
    "hermes/plugins/dws_personal/memory.py",
    "hermes/plugins/dws_personal/plugin.yaml",
    "hermes/plugins/foursday_boundary/__init__.py",
    "hermes/plugins/foursday_boundary/plugin.yaml",
    "hermes/plugins/foursday_work_twin/__init__.py",
    "hermes/plugins/foursday_work_twin/plugin.yaml",
    "hermes/plugins/gbrain_memory/__init__.py",
    "hermes/plugins/gbrain_memory/plugin.yaml",
    "hermes/plugins/project_router/runtime_context.py",
    "hermes/host/package.json",
    "hermes/host/package-lock.json",
    "hermes/profile/SOUL.md",
    "hermes/skills/project-work/SKILL.md",
    "scripts/安装Hermes发行层.mjs",
    "scripts/一键安装Hermes.mjs",
    "scripts/安装Foursday原生Hermes.mjs",
    "scripts/配置Foursday原生Hermes.mjs",
    "scripts/管理Foursday原生Gateway.mjs",
    "scripts/运行个人gbrain记忆晋升.mjs",
    "scripts/管理Hermes常驻服务.mjs",
    "scripts/切换Hermes生产运行时.mjs",
    "scripts/生成Hermes影子验收.mjs",
    "scripts/生成Hermes发布身份.mjs",
    "src/hermes-production-service.mjs",
    "src/hermes-gateway-launcher.mjs",
    "src/hermes-cutover.mjs",
    "src/hermes-shadow-acceptance.mjs",
    "src/hermes-release-identity.mjs",
    "src/foursday-hermes-native-install.mjs",
    "src/foursday-native-profile-config.mjs",
    "src/foursday-native-gateway.mjs",
    "src/foursday-runtime-status.mjs",
    "src/hermes-memory-candidate-sidecar.mjs",
    "src/personal-gbrain-candidate.mjs",
    "src/personal-gbrain-candidate-store.mjs",
    "src/personal-gbrain-promoter.mjs",
    "src/personal-gbrain-writer.mjs",
    "db/migrations/024_Hermes个人记忆候选.sql",
  ]) {
    assert.ok(packagedFiles.includes(path), `missing packaged file: ${path}`);
  }
  assert.equal(packagedFiles.filter((path) => path.includes("/__pycache__/")).length, 0);
  assert.equal(packagedFiles.filter((path) => path.endsWith(".pyc")).length, 0);
});
