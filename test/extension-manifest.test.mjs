import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadExtensionManifests, validateExtensionManifest } from "../src/extension-manifest.mjs";
import { validateWorkRecipe } from "../src/work-recipe.mjs";

test("四个社区适配器示例声明可验证扩展边界", async () => {
  const manifests = await loadExtensionManifests(new URL("../examples/adapters/", import.meta.url));
  assert.deepEqual([...manifests.keys()].sort(), [
    "gmail-push", "google-workspace", "slack-events", "teams-graph",
  ]);
  for (const manifest of manifests.values()) {
    assert.equal(Object.values(manifest.guarantees).every(Boolean), true);
    assert.equal(manifest.runtimeSecrets.every((name) => !name.includes("=")), true);
  }
});

test("社区配方示例使用同一版本化安全契约", async () => {
  const recipe = validateWorkRecipe(JSON.parse(await readFile(
    new URL("../examples/recipes/community-weekly-review.json", import.meta.url),
    "utf8",
  )));
  assert.equal(recipe.id, "community-weekly-review");
  assert.deepEqual(recipe.steps.map((step) => step.capability), ["research", "document_draft"]);
});

test("扩展清单拒绝秘密值和未登记契约", () => {
  assert.throws(() => validateExtensionManifest({
    version: 1, id: "bad", name: "Bad", platform: "bad",
    contract: "arbitrary_executor", contractVersion: "1.0",
    permissions: [], runtimeSecrets: ["TOKEN=secret"], guarantees: {},
  }), /unsupported/u);
  assert.throws(() => validateExtensionManifest({
    version: 1, id: "bad", name: "Bad", platform: "bad",
    contract: "message_adapter", contractVersion: "1.0", status: "experimental",
    permissions: [], runtimeSecrets: ["TOKEN=secret"], guarantees: {},
  }), /environment variable names/u);
  assert.throws(() => validateExtensionManifest({
    version: 1, id: "unsafe", name: "Unsafe", platform: "test",
    contract: "message_adapter", contractVersion: "1.0", status: "experimental",
    permissions: [], runtimeSecrets: [], guarantees: {
      allowlist: true, idempotency: true, humanTakeover: false,
      targetReadback: true, unknownOutcome: true,
    },
  }), /every safety guarantee/u);
  assert.throws(() => validateExtensionManifest({
    version: 1, id: "future", name: "Future", platform: "test",
    contract: "message_adapter", contractVersion: "2.0", status: "experimental",
    permissions: [], runtimeSecrets: [], guarantees: {
      allowlist: true, idempotency: true, humanTakeover: true,
      targetReadback: true, unknownOutcome: true,
    },
  }), /contractVersion must be 1\.0/u);
});
