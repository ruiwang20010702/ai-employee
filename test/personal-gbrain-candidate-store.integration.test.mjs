import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { PersonalGbrainCandidateStore } from "../src/personal-gbrain-candidate-store.mjs";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;

integration("minimal PostgreSQL schema supports the encrypted promotion queue", async (t) => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const tenantId = `test-${randomUUID()}`;
  t.after(async () => {
    await pool.query("DELETE FROM foursday_memory_candidates WHERE tenant_id = $1", [tenantId]);
    await pool.end();
  });
  const store = await new PersonalGbrainCandidateStore({
    pool,
    tenantId,
    dataKey: randomBytes(32).toString("base64"),
  }).open();
  const stored = await store.propose({
    schema: "foursday-personal-gbrain-candidate/v1",
    type: "atom",
    projectId: "example",
    factKey: "project.current_fact",
    title: "Current fact",
    statement: "Verified project fact.",
    sensitivity: "internal",
    confidence: 0.99,
    observedAt: new Date().toISOString(),
    sourceSessionHash: "a".repeat(64),
    evidence: [{
      relativePath: "README.md",
      contentSha256: "b".repeat(64),
      description: "Verified source",
    }],
  }, new Date(), { sourcePrincipalId: "trusted-contact" });
  assert.equal(stored.status, "proposed");
  assert.equal(stored.statement, "Verified project fact.");
  const raw = await pool.query(
    "SELECT statement_ciphertext FROM foursday_memory_candidates WHERE tenant_id = $1",
    [tenantId],
  );
  assert.equal(raw.rowCount, 1);
  assert.notEqual(raw.rows[0].statement_ciphertext, stored.statement);
});
