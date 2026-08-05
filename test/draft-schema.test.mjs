import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("draft schema is strict and models optional work requests as null", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../schemas/draft.schema.json", import.meta.url)),
  );
  assert.deepEqual(
    [...schema.required].sort(),
    Object.keys(schema.properties).sort(),
  );
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.workRequest.anyOf.some(
    (variant) => variant.type === "null",
  ));
  const objectVariant = schema.properties.workRequest.anyOf.find(
    (variant) => variant.type === "object",
  );
  assert.deepEqual(
    [...objectVariant.required].sort(),
    Object.keys(objectVariant.properties).sort(),
  );
  assert.equal(objectVariant.additionalProperties, false);
});
