import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { activationHelp, runActivation } from "../scripts/启动体验.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const activationScript = fileURLToPath(new URL("../scripts/启动体验.mjs", import.meta.url));

test("activation help is English and returns before loading runtime dependencies", async () => {
  const chunks = [];
  let dependencyLoads = 0;
  const result = await runActivation({
    args: ["--help", "--port", "invalid"],
    output: { write: (chunk) => chunks.push(chunk) },
    loadRuntime: async () => {
      dependencyLoads += 1;
      throw new Error("activation runtime must not load for help");
    },
  });
  const output = chunks.join("");

  assert.equal(result, null);
  assert.equal(dependencyLoads, 0);
  assert.equal(output, activationHelp);
  assert.match(output, /Usage:\n  npm start -- \[options\]/u);
  assert.match(output, /foursday start \[options\]/u);
  assert.match(output, /--help\s+Show this help and exit\./u);
  assert.match(output, /without starting a listener/u);
  assert.match(output, /model, Git, GitHub, SQLite, or production systems/u);
  assert.doesNotMatch(output, /[^\x00-\x7F]/u);
});

test("activation CLI help exits without model setup or a listener", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [activationScript, "--help"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      FOURSDAY_OPENAI_BASE_URL: "https://example.invalid/v1/",
      FOURSDAY_OPENAI_API_KEY: "",
      FOURSDAY_OPENAI_MODEL: "",
    },
    timeout: 2_000,
  });

  assert.equal(stderr, "");
  assert.equal(stdout, activationHelp);
});
