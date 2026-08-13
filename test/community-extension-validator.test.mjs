import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runCommunityExtensionValidation,
  validateCommunityAdapter,
  validateCommunityExtensions,
  validateCommunityRecipe,
} from "../scripts/验证社区扩展.mjs";

const recipe = {
  version: 1,
  id: "safe-review",
  name: "Safe review",
  description: "Prepare a local project review.",
  category: "community",
  objective: "Review {{focus}}.",
  baselineMinutes: 20,
  baselineMethod: "user_confirmed",
  inputs: [{ name: "focus", type: "string", description: "Review focus" }],
  steps: [{
    id: "research",
    capability: "research",
    description: "Research {{focus}}.",
    workingDirectory: "{{projectRoot}}",
    inputs: {},
    expectedEvidence: "A source-checked summary",
    rollback: null,
  }],
};

const adapter = {
  version: 1,
  id: "safe-chat",
  name: "Safe chat reference",
  platform: "safe-chat",
  contract: "message_adapter",
  contractVersion: "1.0",
  status: "experimental",
  permissions: ["chat.read", "chat.write"],
  runtimeSecrets: ["SAFE_CHAT_TOKEN"],
  guarantees: {
    allowlist: true,
    idempotency: true,
    humanTakeover: true,
    targetReadback: true,
    unknownOutcome: true,
  },
};

test("社区扩展独立命令默认只读验证仓库示例", async () => {
  const result = await validateCommunityExtensions();
  assert.equal(result.valid, true);
  assert.equal(result.recipes, 1);
  assert.equal(result.adapters, 4);
  assert.deepEqual(result.capabilities, ["document_draft", "research"]);
  assert.equal(result.sideEffectSteps, 0);
  assert.equal(result.credentialFilesRead, 0);
  assert.equal(result.externalActions, 0);
});

test("社区扩展命令可验证贡献者指定的配方和适配器且不输出内容或路径", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-community-validator-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const recipePath = join(directory, "recipe.json");
  const adapterPath = join(directory, "adapter.json");
  await Promise.all([
    writeFile(recipePath, JSON.stringify(recipe)),
    writeFile(adapterPath, JSON.stringify(adapter)),
  ]);
  let output = "";
  const result = await runCommunityExtensionValidation({
    args: ["--recipe", recipePath, "--adapter", adapterPath],
    output: { write(value) { output += value; } },
  });
  assert.equal(result.recipes, 1);
  assert.equal(result.adapters, 1);
  assert.match(output, /"safe-review"/u);
  assert.doesNotMatch(output, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(output, /SAFE_CHAT_TOKEN|chat\.write/u);
});

test("社区配方拒绝未知能力、凭据输入、凭据值和任意工作目录", () => {
  assert.throws(
    () => validateCommunityRecipe({
      ...recipe,
      steps: [{ ...recipe.steps[0], capability: "arbitrary_executor" }],
    }),
    /capability is not registered/u,
  );
  assert.throws(
    () => validateCommunityRecipe({
      ...recipe,
      inputs: [{ name: "apiToken", type: "string", description: "Runtime value" }],
    }),
    /cannot request credentials/u,
  );
  assert.throws(
    () => validateCommunityRecipe({
      ...recipe,
      steps: [{ ...recipe.steps[0], inputs: { authorization: "Bearer abcdefghijklmnop" } }],
    }),
    /credential field/u,
  );
  assert.throws(
    () => validateCommunityRecipe({
      ...recipe,
      steps: [{ ...recipe.steps[0], workingDirectory: "/tmp/unreviewed" }],
    }),
    /must use \{\{projectRoot\}\}/u,
  );
});

test("社区适配器拒绝秘密值、未知字段和缺失安全保证", () => {
  assert.throws(
    () => validateCommunityAdapter({ ...adapter, accessToken: "secret-value" }),
    /unsupported fields/u,
  );
  assert.throws(
    () => validateCommunityAdapter({
      ...adapter,
      permissions: ["authorization: Bearer abcdefghijklmnop"],
    }),
    /credential material/u,
  );
  assert.throws(
    () => validateCommunityAdapter({
      ...adapter,
      guarantees: { ...adapter.guarantees, targetReadback: false },
    }),
    /every safety guarantee/u,
  );
});

test("社区扩展显式路径拒绝符号链接和重复 ID", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-community-validator-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source.json");
  const link = join(directory, "link.json");
  await writeFile(source, JSON.stringify(recipe));
  await symlink(source, link);
  await assert.rejects(
    validateCommunityExtensions({ recipePaths: [link] }),
    /regular JSON file/u,
  );
  const second = join(directory, "second.json");
  await writeFile(second, JSON.stringify({ ...adapter, id: recipe.id }));
  await assert.rejects(
    validateCommunityExtensions({ recipePaths: [source], adapterPaths: [second] }),
    /IDs must be unique/u,
  );
});
