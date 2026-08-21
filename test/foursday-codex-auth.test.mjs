import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runFoursdayCodexLogin } from "../src/foursday-codex-auth.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-codex-auth-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profileDirectory = join(root, "profile");
  const codexHome = join(profileDirectory, "local", "foursday", "codex");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(join(codexHome, "config.toml"), 'default_permissions = ":workspace"\n', { mode: 0o600 });
  const codex = join(root, "codex");
  await writeFile(codex, "#!/bin/sh\n", { mode: 0o700 });
  const configPath = join(root, "foursday.json");
  await writeFile(configPath, `${JSON.stringify({ FOURSDAY_CODEX_PATH: codex })}\n`, { mode: 0o600 });
  return { root, profileDirectory, codexHome, codex, configPath };
}

test("Foursday Codex login never reads or copies the user's default Codex home", async (t) => {
  const value = await fixture(t);
  const preview = await runFoursdayCodexLogin({
    layout: { userHome: value.root, profileDirectory: value.profileDirectory },
    configPath: value.configPath,
  });
  assert.equal(preview.apply, false);
  assert.equal(preview.codexHome, value.codexHome);
  assert.equal(preview.isolatedFromUserCodex, true);
  assert.equal(preview.credentialsCopied, false);
  const invocations = [];
  const applied = await runFoursdayCodexLogin({
    layout: { userHome: value.root, profileDirectory: value.profileDirectory },
    configPath: value.configPath,
    apply: true,
    run: async (path, args, options) => { invocations.push({ path, args, options }); },
  });
  assert.equal(applied.authenticated, true);
  assert.equal(applied.verified, true);
  assert.equal(applied.credentialWrite, true);
  assert.equal(applied.productionWrite, false);
  assert.equal(invocations[0].path, value.codex);
  assert.deepEqual(invocations.map(({ args }) => args), [["login"], ["login", "status"]]);
  assert.equal(invocations[0].options.env.CODEX_HOME, value.codexHome);
  assert.ok(invocations[0].options.env.PATH.split(":").includes(dirname(value.codex)));
  assert.doesNotMatch(JSON.stringify(invocations), /\.codex\/auth\.json/u);
});
