import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { PersonalGbrainCandidateStore } from "../src/personal-gbrain-candidate-store.mjs";

function candidate() {
  return {
    schema: "foursday-personal-gbrain-candidate/v1",
    type: "atom",
    projectId: "vocab_2_2",
    factKey: "production.formal_question_count",
    title: "正式试题口径",
    statement: "正式题目数量必须依据项目当前汇总文件。",
    sensitivity: "internal",
    confidence: 0.99,
    observedAt: "2026-08-20T00:00:00Z",
    sourceSessionHash: "c".repeat(64),
    evidence: [{
      relativePath: "summary.json",
      contentSha256: "d".repeat(64),
      description: "项目汇总",
    }],
  };
}

class FakePool {
  constructor() {
    this.rows = [];
    this.sources = [];
  }

  async connect() { return this; }
  release() {}

  async query(sql, values = []) {
    if (/^(?:BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [] };
    if (/SELECT 1 FROM/u.test(sql)) return { rows: [] };
    if (/INSERT INTO hermes_memory_candidates/u.test(sql)) {
      if (!this.rows.some((row) => row.candidate_key === values[2])) {
        this.rows.push({
          tenant_id: values[0], id: values[1], candidate_key: values[2],
          project_id: values[3], type: values[4], fact_key: values[5],
          title_ciphertext: values[6], statement_ciphertext: values[7],
          evidence_ciphertext: values[8], sensitivity: values[9], confidence: values[10],
          source_session_hash: values[11], status: "proposed", attempt_count: 0,
          lease_owner: null, lease_expires_at: null, authority_slug: null,
          authority_commit: null, authority_sha256: null, last_error_code: null,
          created_at: values[12], updated_at: values[12], promoted_at: null,
          privacy_erased_at: null,
        });
      }
      return { rows: [] };
    }
    if (/INSERT INTO hermes_memory_candidate_sources/u.test(sql)) {
      if (!this.sources.some((row) => row.candidate_id === values[1] &&
        row.source_principal_key === values[2] && row.source_session_hash === values[3])) {
        this.sources.push({
          tenant_id: values[0], candidate_id: values[1], source_principal_key: values[2],
          source_session_hash: values[3], created_at: values[4],
        });
      }
      return { rows: [] };
    }
    if (/WHERE tenant_id = \$1 AND candidate_key = \$2/u.test(sql)) {
      return { rows: this.rows.filter((row) => row.candidate_key === values[1]) };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

test("candidate store encrypts payloads and repeated proposals are idempotent", async () => {
  const pool = new FakePool();
  const store = await new PersonalGbrainCandidateStore({
    pool,
    tenantId: "tenant",
    dataKey: randomBytes(32).toString("base64"),
  }).open();
  const first = await store.propose(candidate(), new Date(), { sourcePrincipalId: "trusted-user" });
  const second = await store.propose(candidate(), new Date(), { sourcePrincipalId: "trusted-user-2" });
  assert.equal(first.id, second.id);
  assert.equal(pool.rows.length, 1);
  assert.equal(first.statement, candidate().statement);
  assert.notEqual(pool.rows[0].statement_ciphertext, candidate().statement);
  assert.equal(pool.sources.length, 2);
  assert.match(pool.sources[0].source_principal_key, /^[a-f0-9]{64}$/u);
  assert.notEqual(pool.sources[0].source_principal_key, "trusted-user");
  assert.doesNotMatch(JSON.stringify(pool.rows[0]), /正式题目数量/u);
});

test("candidate store rejects proposals without a source principal", async () => {
  const store = await new PersonalGbrainCandidateStore({
    pool: new FakePool(),
    tenantId: "tenant",
    dataKey: randomBytes(32).toString("base64"),
  }).open();
  await assert.rejects(store.propose(candidate()), /source principal/u);
});
