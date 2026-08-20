import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  foursdayNativeHermesLayout,
  stageFoursdayProfileDistribution,
} from "../src/foursday-hermes-native-install.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const hermesCommand = join(process.env.HOME ?? "", ".local", "bin", "hermes");
const available = await access(hermesCommand).then(() => true).catch(() => false);

test("official Hermes installs the Foursday profile distribution and validates all plugins", {
  skip: !available,
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-profile-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = {
    ...foursdayNativeHermesLayout({ userHome: root, projectRoot }),
    profileStage: join(root, "stage"),
  };
  const staged = await stageFoursdayProfileDistribution({
    layout,
    version: "0.6.0",
    hermesVersion: "0.20.4",
  });
  const environment = {
    HOME: process.env.HOME,
    HERMES_HOME: join(root, "home"),
    PATH: `${join(process.env.HOME, ".local", "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
  };
  await execFileAsync(hermesCommand, [
    "profile", "install", staged.stage,
    "--name", "foursday", "--yes",
  ], { env: environment, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const profileHome = join(environment.HERMES_HOME, "profiles", "foursday");
  for (const directory of [
    "foursday_work_twin",
  ]) {
    const { stdout } = await execFileAsync(hermesCommand, [
      "plugins", "doctor", join(profileHome, "plugins", directory), "--ci",
    ], {
      env: { ...environment, HERMES_HOME: profileHome },
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.doesNotMatch(stdout, /invalid|error|failed/iu);
  }
});
