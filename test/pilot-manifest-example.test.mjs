import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import test from "node:test";

function stringValues(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(stringValues);
  }
  return [];
}

test("pilot manifest example is synthetic and contains no private material", async () => {
  const contents = await readFile(
    new URL("../docs/examples/pilot-manifest.example.json", import.meta.url),
    "utf8",
  );
  const manifest = JSON.parse(contents);

  assert.equal(manifest.schema, "foursday-pilot-evidence/v1");
  assert.deepEqual(
    manifest.entries.map((entry) => entry.cohort),
    ["self", "external"],
  );
  for (const entry of manifest.entries) {
    assert.match(entry.participantAlias, /^pilot-(?:self|external)-\d{2}$/u);
    assert.equal(posix.isAbsolute(entry.evidencePath), false);
    assert.equal(win32.isAbsolute(entry.evidencePath), false);
    assert.doesNotMatch(entry.evidencePath, /(?:^|[\\/])\.\.(?:[\\/]|$)/u);
  }

  assert.doesNotMatch(
    contents,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  );
  assert.doesNotMatch(contents, /token|credential|password|secret|api[_ -]?key/iu);
  for (const value of stringValues(manifest)) {
    assert.equal(posix.isAbsolute(value) || win32.isAbsolute(value), false);
  }
});
