import { randomUUID } from "node:crypto";
import { DataCipher } from "./crypto.mjs";
import {
  normalizePersonalGbrainCandidate,
  personalGbrainCandidateKey,
} from "./personal-gbrain-candidate.mjs";

function safeErrorCode(error) {
  const value = String(error?.code ?? error?.name ?? "promotion_failed")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .slice(0, 80);
  return value || "promotion_failed";
}

function rowValue(row, cipher) {
  if (!row) return null;
  return {
    id: row.id,
    candidateKey: row.candidate_key,
    projectId: row.project_id,
    type: row.type,
    factKey: row.fact_key,
    title: cipher.decrypt(row.title_ciphertext),
    statement: cipher.decrypt(row.statement_ciphertext),
    evidence: JSON.parse(cipher.decrypt(row.evidence_ciphertext)),
    sensitivity: row.sensitivity,
    confidence: Number(row.confidence),
    sourceSessionHash: row.source_session_hash,
    status: row.status,
    attemptCount: row.attempt_count,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    authoritySlug: row.authority_slug,
    authorityCommit: row.authority_commit,
    authoritySha256: row.authority_sha256,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    promotedAt: row.promoted_at,
    privacyErasedAt: row.privacy_erased_at,
  };
}

export class PersonalGbrainCandidateStore {
  constructor({ pool, tenantId, dataKey }) {
    if (!pool?.query) throw new Error("personal gbrain candidate store requires PostgreSQL");
    if (typeof tenantId !== "string" || !tenantId.trim()) {
      throw new Error("personal gbrain candidate tenant is required");
    }
    this.pool = pool;
    this.tenantId = tenantId;
    this.dataKey = dataKey;
    this.cipher = null;
  }

  async open() {
    this.cipher = await DataCipher.create({ encodedKey: this.dataKey, ephemeral: false });
    await this.pool.query("SELECT 1 FROM hermes_memory_candidates LIMIT 0");
    await this.pool.query("SELECT 1 FROM hermes_memory_candidate_sources LIMIT 0");
    return this;
  }

  async propose(candidate, now = new Date(), { sourcePrincipalId } = {}) {
    if (!this.cipher) throw new Error("personal gbrain candidate store is not open");
    const principal = String(sourcePrincipalId ?? "").trim();
    if (!principal || principal.length > 500 || /[\u0000-\u001f\u007f]/u.test(principal)) {
      throw new Error("personal gbrain candidate source principal is invalid");
    }
    const normalized = normalizePersonalGbrainCandidate(candidate);
    const candidateKey = personalGbrainCandidateKey(normalized);
    const id = `hmc_${candidateKey.slice(0, 32)}`;
    const values = [
      this.tenantId,
      id,
      candidateKey,
      normalized.projectId,
      normalized.type,
      normalized.factKey,
      this.cipher.encrypt(normalized.title),
      this.cipher.encrypt(normalized.statement),
      this.cipher.encrypt(JSON.stringify(normalized.evidence)),
      normalized.sensitivity,
      normalized.confidence,
      normalized.sourceSessionHash,
      now,
    ];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO hermes_memory_candidates(
           tenant_id, id, candidate_key, project_id, type, fact_key,
           title_ciphertext, statement_ciphertext, evidence_ciphertext,
           sensitivity, confidence, source_session_hash, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13
         )
         ON CONFLICT (tenant_id, candidate_key) DO NOTHING`,
        values,
      );
      const result = await client.query(
        `SELECT * FROM hermes_memory_candidates
         WHERE tenant_id = $1 AND candidate_key = $2 FOR UPDATE`,
        [this.tenantId, candidateKey],
      );
      if (!result.rows[0]) throw new Error("personal gbrain candidate insert did not read back");
      await client.query(
        `INSERT INTO hermes_memory_candidate_sources(
           tenant_id, candidate_id, source_principal_key, source_session_hash, created_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [
          this.tenantId,
          result.rows[0].id,
          this.cipher.fingerprint(principal),
          normalized.sourceSessionHash,
          now,
        ],
      );
      await client.query("COMMIT");
      return rowValue(result.rows[0], this.cipher);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async leaseNext({ owner = randomUUID(), leaseMs = 120_000, now = new Date() } = {}) {
    if (!/^[A-Za-z0-9._:-]{8,200}$/u.test(String(owner))) {
      throw new Error("personal gbrain candidate lease owner is invalid");
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 600_000) {
      throw new Error("personal gbrain candidate lease is invalid");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT id FROM hermes_memory_candidates
         WHERE tenant_id = $1
           AND status IN ('proposed', 'retry', 'processing')
           AND (status <> 'processing' OR lease_expires_at <= $2)
         ORDER BY updated_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [this.tenantId, now],
      );
      if (!selected.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const result = await client.query(
        `UPDATE hermes_memory_candidates
         SET status = 'processing', lease_owner = $3,
             lease_expires_at = $4, attempt_count = attempt_count + 1,
             updated_at = $2
         WHERE tenant_id = $1 AND id = $5
         RETURNING *`,
        [
          this.tenantId,
          now,
          owner,
          new Date(now.getTime() + leaseMs),
          selected.rows[0].id,
        ],
      );
      await client.query("COMMIT");
      return rowValue(result.rows[0], this.cipher);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(id, owner, promotion, now = new Date()) {
    const result = await this.pool.query(
      `UPDATE hermes_memory_candidates
       SET status = 'promoted', authority_slug = $4, authority_commit = $5,
           authority_sha256 = $6, promoted_at = $3, updated_at = $3,
           lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL
       WHERE tenant_id = $1 AND id = $2 AND status = 'processing' AND lease_owner = $7
       RETURNING *`,
      [
        this.tenantId,
        id,
        now,
        promotion.slug,
        promotion.commit,
        promotion.contentSha256,
        owner,
      ],
    );
    if (!result.rows[0]) throw new Error("personal gbrain candidate lease was lost");
    return rowValue(result.rows[0], this.cipher);
  }

  async fail(id, owner, error, { maxAttempts = 5, now = new Date() } = {}) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      throw new Error("personal gbrain candidate max attempts is invalid");
    }
    const result = await this.pool.query(
      `UPDATE hermes_memory_candidates
       SET status = CASE WHEN attempt_count >= $4 THEN 'blocked' ELSE 'retry' END,
           last_error_code = $5, updated_at = $3,
           lease_owner = NULL, lease_expires_at = NULL
       WHERE tenant_id = $1 AND id = $2 AND status = 'processing' AND lease_owner = $6
       RETURNING *`,
      [this.tenantId, id, now, maxAttempts, safeErrorCode(error), owner],
    );
    if (!result.rows[0]) throw new Error("personal gbrain candidate lease was lost");
    return rowValue(result.rows[0], this.cipher);
  }

  async revoke(id, retirement, now = new Date()) {
    const result = await this.pool.query(
      `UPDATE hermes_memory_candidates
       SET status = 'revoked', authority_commit = $3, authority_sha256 = $4,
           updated_at = $5, lease_owner = NULL, lease_expires_at = NULL
       WHERE tenant_id = $1 AND id = $2 AND status = 'promoted'
       RETURNING *`,
      [this.tenantId, id, retirement.commit, retirement.contentSha256, now],
    );
    if (!result.rows[0]) throw new Error("personal gbrain promoted candidate is no longer revocable");
    return rowValue(result.rows[0], this.cipher);
  }

  async completeRetirement(id, owner, retirement, now = new Date()) {
    const result = await this.pool.query(
      `UPDATE hermes_memory_candidates
       SET status = 'revoked', authority_commit = $4, authority_sha256 = $5,
           updated_at = $3, lease_owner = NULL, lease_expires_at = NULL,
           last_error_code = NULL
       WHERE tenant_id = $1 AND id = $2 AND status = 'retiring' AND lease_owner = $6
       RETURNING *`,
      [this.tenantId, id, now, retirement.commit, retirement.contentSha256, owner],
    );
    if (!result.rows[0]) throw new Error("personal gbrain retirement lease was lost");
    return rowValue(result.rows[0], this.cipher);
  }

  async leaseRetirement({ owner = randomUUID(), leaseMs = 120_000, now = new Date() } = {}) {
    if (!/^[A-Za-z0-9._:-]{8,200}$/u.test(String(owner))) {
      throw new Error("personal gbrain retirement lease owner is invalid");
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 600_000) {
      throw new Error("personal gbrain retirement lease is invalid");
    }
    const result = await this.pool.query(
      `UPDATE hermes_memory_candidates
       SET status = 'retiring', lease_owner = $3, lease_expires_at = $4,
           attempt_count = attempt_count + 1, updated_at = $2
       WHERE tenant_id = $1 AND id = (
         SELECT id FROM hermes_memory_candidates
         WHERE tenant_id = $1
           AND status IN ('retirement_pending', 'retiring')
           AND (status <> 'retiring' OR lease_expires_at <= $2)
         ORDER BY updated_at ASC, id ASC
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING *`,
      [this.tenantId, now, owner, new Date(now.getTime() + leaseMs)],
    );
    return rowValue(result.rows[0], this.cipher);
  }

  async failRetirement(id, owner, error, now = new Date()) {
    const result = await this.pool.query(
      `UPDATE hermes_memory_candidates
       SET status = 'retirement_pending', last_error_code = $5, updated_at = $3,
           lease_owner = NULL, lease_expires_at = NULL
       WHERE tenant_id = $1 AND id = $2 AND status = 'retiring' AND lease_owner = $4
       RETURNING *`,
      [this.tenantId, id, now, owner, safeErrorCode(error)],
    );
    if (!result.rows[0]) throw new Error("personal gbrain retirement lease was lost");
    return rowValue(result.rows[0], this.cipher);
  }

  async list({ status = null, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("personal gbrain candidate list limit is invalid");
    }
    const result = await this.pool.query(
      `SELECT * FROM hermes_memory_candidates
       WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY updated_at DESC, id DESC LIMIT $3`,
      [this.tenantId, status, limit],
    );
    return result.rows.map((row) => rowValue(row, this.cipher));
  }
}
