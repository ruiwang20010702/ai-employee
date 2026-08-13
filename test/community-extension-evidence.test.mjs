import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runCommunityExtensionEvidenceVerification,
  verifyCommunityExtensionEvidence,
} from "../scripts/验证社区扩展证据.mjs";

const candidateSha = "a".repeat(40);
const recipe = {
  version: 1,
  id: "community-safe-review",
  name: "Community safe review",
  description: "Prepare a credential-free project review.",
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
const recipeSha256 = createHash("sha256").update(JSON.stringify(recipe)).digest("hex");

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "foursday-extension-evidence-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "examples", "recipes"), { recursive: true });
  await mkdir(join(root, "examples", "adapters"), { recursive: true });
  await writeFile(join(root, "examples", "recipes", "community-safe-review.json"), JSON.stringify(recipe));
  const manifestPath = join(root, "evidence.json");
  const manifest = {
    schema: "foursday-community-extension-evidence/v1",
    candidateSha,
    entries: [{
      kind: "recipe",
      extensionId: recipe.id,
      extensionPath: "examples/recipes/community-safe-review.json",
      pullNumber: 123,
    }],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, manifestPath, manifest };
}

test("社区扩展证据绑定候选提交、已验证文件和公开 PR 编号", async (context) => {
  const { root, manifestPath } = await fixture(context);
  const result = await verifyCommunityExtensionEvidence(manifestPath, {
    candidateSha,
    root,
  });
  assert.equal(result.valid, true);
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.verifiedCommunityRecipesOrAdapters, 1);
  assert.equal(result.recipes, 1);
  assert.equal(result.adapters, 0);
  assert.deepEqual(result.entries, [{
    kind: "recipe",
    extensionId: recipe.id,
    extensionPath: "examples/recipes/community-safe-review.json",
    contentSha256: recipeSha256,
    pullNumber: 123,
  }]);
  assert.equal(result.localIntegrityVerified, true);
  assert.equal(result.targetReadbackReverificationRequired, true);
  assert.equal(result.contributorIdentitiesEmitted, false);
});

test("社区扩展证据拒绝候选漂移、文件身份不符和重复 PR", async (context) => {
  const { root, manifestPath, manifest } = await fixture(context);
  await assert.rejects(
    verifyCommunityExtensionEvidence(manifestPath, { candidateSha: "b".repeat(40), root }),
    /candidate SHA does not match/u,
  );
  await writeFile(manifestPath, JSON.stringify({
    ...manifest,
    entries: [{ ...manifest.entries[0], extensionId: "different-extension" }],
  }));
  await assert.rejects(
    verifyCommunityExtensionEvidence(manifestPath, { candidateSha, root }),
    /does not match the validated file/u,
  );
  await writeFile(manifestPath, JSON.stringify({
    ...manifest,
    entries: [
      manifest.entries[0],
      { ...manifest.entries[0], extensionId: "another-id", extensionPath: "examples/recipes/another.json" },
    ],
  }));
  await writeFile(
    join(root, "examples", "recipes", "another.json"),
    JSON.stringify({ ...recipe, id: "another-id" }),
  );
  await assert.rejects(
    verifyCommunityExtensionEvidence(manifestPath, { candidateSha, root }),
    /pull request numbers must be unique/u,
  );
});

test("社区扩展证据拒绝越界路径和任一级符号链接", async (context) => {
  const { root, manifestPath, manifest } = await fixture(context);
  await writeFile(manifestPath, JSON.stringify({
    ...manifest,
    entries: [{ ...manifest.entries[0], extensionPath: "../private.json" }],
  }));
  await assert.rejects(
    verifyCommunityExtensionEvidence(manifestPath, { candidateSha, root }),
    /evidence path is invalid/u,
  );

  const realRecipes = join(root, "real-recipes");
  await mkdir(realRecipes);
  await writeFile(join(realRecipes, "community-safe-review.json"), JSON.stringify(recipe));
  await rm(join(root, "examples", "recipes"), { recursive: true });
  await symlink(realRecipes, join(root, "examples", "recipes"));
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    verifyCommunityExtensionEvidence(manifestPath, { candidateSha, root }),
    /cannot contain symbolic links/u,
  );
});

test("社区扩展证据命令只输出受限结构且要求显式候选", async () => {
  await assert.rejects(
    runCommunityExtensionEvidenceVerification({ args: [] }),
    /Usage/u,
  );
  let output = "";
  const result = await runCommunityExtensionEvidenceVerification({
    args: ["--manifest", "private/evidence.json", "--sha", candidateSha],
    output: { write(value) { output += value; } },
    verify: async (path, options) => ({
      valid: true,
      pathReceived: path,
      candidateSha: options.candidateSha,
      contributorIdentitiesEmitted: false,
    }),
  });
  assert.equal(result.pathReceived, "private/evidence.json");
  assert.equal(result.candidateSha, candidateSha);
  assert.deepEqual(JSON.parse(output), result);
});
