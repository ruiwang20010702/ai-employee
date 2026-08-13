import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adapterContractVersion } from "../src/adapter-contracts.mjs";
import { StructuredArtifactRuntime } from "../src/artifact-runtime.mjs";

test("structured artifact runtime keeps model output inside a bounded artifact envelope", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-artifact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const runtime = new StructuredArtifactRuntime({
    id: "test-runtime",
    decisionSource: "test-runtime",
    contractVersion: adapterContractVersion,
    async generateDraft(input) {
      calls.push({
        prompt: input.prompt,
        schema: JSON.parse(await readFile(input.schemaPath, "utf8")),
        workspacePath: input.workspacePath,
      });
      return { artifact: "diff --git a/a b/a\n" };
    },
  });
  const result = await runtime.generateArtifact({
    prompt: "Prepare a patch",
    workingDirectory: directory,
    outputDirectory: join(directory, "output"),
    maxBytes: 1_024,
  });
  assert.equal(result.output, "diff --git a/a b/a\n");
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.runtimeId, "test-runtime");
  assert.equal(calls[0].schema.additionalProperties, false);
  assert.equal(calls[0].workspacePath, directory);
  assert.match(calls[0].prompt, /add no commentary outside it/u);
});

test("structured artifact runtime rejects malformed and oversized provider output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-artifact-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = (value) => new StructuredArtifactRuntime({
    id: "test-runtime",
    decisionSource: "test-runtime",
    contractVersion: adapterContractVersion,
    async generateDraft() { return value; },
  });
  await assert.rejects(
    () => candidate({ output: "wrong key" }).generateArtifact({
      prompt: "x", workingDirectory: directory, outputDirectory: join(directory, "a"),
    }),
    /invalid artifact envelope/u,
  );
  await assert.rejects(
    () => candidate({ artifact: "12345" }).generateArtifact({
      prompt: "x", workingDirectory: directory, outputDirectory: join(directory, "b"), maxBytes: 4,
    }),
    /exceeded size limit/u,
  );
});
