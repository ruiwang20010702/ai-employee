import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isMainModule } from "../src/main-module.mjs";

test("main module detection survives canonical path aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-entry-"));
  const entry = join(directory, "入口.mjs");
  await writeFile(entry, "export {};\n");
  const canonicalUrl = pathToFileURL(await realpath(entry)).href;
  assert.equal(isMainModule(canonicalUrl, ["node", entry]), true);
  assert.equal(isMainModule(import.meta.url, ["node", entry]), false);
});
