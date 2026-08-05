import { createHash, randomUUID } from "node:crypto";
import { DataCipher } from "./crypto.mjs";
import { checkPostgres, createPostgresPool } from "./postgres.mjs";
import { splitMessageBursts } from "./message-bundling.mjs";
import { memoryIsUsable, validateMemoryProposal } from "./memory-policy.mjs";
import { memoryDeletionConfirmation } from "./memory-portability.mjs";
import { analyzeMemoryConflicts, memoryFactKey } from "./memory-conflicts.mjs";
import { buildPlanResultDraft } from "./plan-result-notification.mjs";
import { buildOperationalMetrics } from "./operational-metrics.mjs";
import { messageCoverageCheckpointKey } from "./message-reconciliation.mjs";
import { decisionSha256 } from "./decision-quality.mjs";
import {
  availabilityBucket,
  buildAvailabilityMetrics,
} from "./availability-metrics.mjs";
import {
  normalizePauseChange,
  normalizePauseScope,
  scopedPauseKey,
} from "./scoped-pause.mjs";
import { validateWorkPlanRevision } from "./work-plan.mjs";

function toDate(value) {
  if (value instanceof Date) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== "") {
    return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return parsed;
}

function taskFromRow(row, cipher) {
  if (!row) return null;
  return {
    ...row,
    sender_user_id: cipher.decrypt(row.sender_user_id_ciphertext),
    conversation_id: cipher.decrypt(row.conversation_id_ciphertext),
    payload: JSON.parse(cipher.decrypt(row.payload_ciphertext)),
    result: row.result_ciphertext
      ? JSON.parse(cipher.decrypt(row.result_ciphertext))
      : null,
    last_error: row.last_error_ciphertext
      ? cipher.decrypt(row.last_error_ciphertext)
      : null,
    sender_user_id_ciphertext: undefined,
    conversation_id_ciphertext: undefined,
    payload_ciphertext: undefined,
    result_ciphertext: undefined,
    last_error_ciphertext: undefined,
  };
}

function memoryFromRow(row, cipher) {
  if (!row) return null;
  return {
    ...row,
    subject: cipher.decrypt(row.subject_ciphertext),
    statement: cipher.decrypt(row.statement_ciphertext),
    source_id: cipher.decrypt(row.source_id_ciphertext),
    scope: JSON.parse(cipher.decrypt(row.scope_ciphertext)),
    subject_ciphertext: undefined,
    statement_ciphertext: undefined,
    source_id_ciphertext: undefined,
    scope_ciphertext: undefined,
  };
}

function workPlanFromRow(row, cipher) {
  if (!row) return null;
  return {
    ...row,
    requester_id: cipher.decrypt(row.requester_ciphertext),
    objective: cipher.decrypt(row.objective_ciphertext),
    plan: JSON.parse(cipher.decrypt(row.plan_ciphertext)),
    requester_ciphertext: undefined,
    objective_ciphertext: undefined,
    plan_ciphertext: undefined,
  };
}

export class PostgresStore {
  constructor(config, { pool } = {}) {
    this.config = config;
    this.tenantId = config.tenantId;
    this.pool = pool ?? createPostgresPool(config);
    this.ownsPool = !pool;
    this.cipher = null;
    this.opened = false;
  }

  async open() {
    if (this.opened) return this;
    if (!this.tenantId) throw new Error("AI_EMPLOYEE_TENANT_ID is required");
    if (!this.config.dataKey) throw new Error("AI_EMPLOYEE_DATA_KEY is required");
    this.cipher = await DataCipher.create({
      encodedKey: this.config.dataKey,
      ephemeral: false,
    });
    await checkPostgres(this.pool);
    const migration = await this.pool.query(
      "SELECT to_regclass('public.schema_migrations') AS table_name",
    );
    if (!migration.rows[0].table_name) {
      throw new Error("Database is not migrated; run npm run db:migrate");
    }
    await this.pool.query(
      `
      INSERT INTO settings(tenant_id, key, value)
      VALUES ($1, 'encryption_sentinel', $2)
      ON CONFLICT (tenant_id, key) DO NOTHING
    `,
      [this.tenantId, this.cipher.encrypt("ai-employee-v1")],
    );
    const sentinel = await this.pool.query(
      "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'encryption_sentinel'",
      [this.tenantId],
    );
    try {
      if (this.cipher.decrypt(sentinel.rows[0].value) !== "ai-employee-v1") {
        throw new Error("sentinel mismatch");
      }
    } catch {
      throw new Error("The configured data key does not match this tenant");
    }
    this.opened = true;
    return this;
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
    this.opened = false;
  }

  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async audit(client, {
    taskId = null,
    eventType,
    actor = "system",
    details = {},
  }) {
    await client.query(
      `
      INSERT INTO audit_events(
        tenant_id, task_id, event_type, actor, details_ciphertext
      ) VALUES ($1, $2, $3, $4, $5)
    `,
      [
        this.tenantId,
        taskId,
        eventType,
        actor,
        this.cipher.encrypt(JSON.stringify(details)),
      ],
    );
  }

  async ingestMessages(messages, now = new Date()) {
    return this.transaction(async (client) => {
      let inserted = 0;
      for (const message of messages) {
        if (
          !message.id ||
          !message.senderUserId ||
          !message.conversationId ||
          !message.createTime
        ) {
          continue;
        }
        const result = await client.query(
          `
          INSERT INTO messages(
            tenant_id, platform_message_id, sender_key,
            sender_user_id_ciphertext, sender_name_ciphertext,
            conversation_key, conversation_id_ciphertext,
            occurred_at, content_ciphertext, ingested_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (tenant_id, platform_message_id) DO NOTHING
        `,
          [
            this.tenantId,
            message.id,
            this.cipher.fingerprint(message.senderUserId),
            this.cipher.encrypt(message.senderUserId),
            this.cipher.encrypt(message.senderName ?? ""),
            this.cipher.fingerprint(message.conversationId),
            this.cipher.encrypt(message.conversationId),
            toDate(message.createTime),
            this.cipher.encrypt(String(message.content ?? "")),
            now,
          ],
        );
        inserted += result.rowCount;
      }
      if (inserted > 0) {
        await this.audit(client, {
          eventType: "messages.ingested",
          details: { count: inserted },
        });
      }
      return inserted;
    });
  }

  async createReadyTasks({
    quietWindowMs,
    bundleGapMs = 120_000,
    maxMessagesPerTask = 20,
    maxAttempts = 5,
    now = new Date(),
  }) {
    const cutoff = new Date(now.getTime() - quietWindowMs);
    return this.transaction(async (client) => {
      const groups = await client.query(
        `
        SELECT conversation_key, sender_key
        FROM messages
        WHERE tenant_id = $1 AND status = 'pending'
        GROUP BY conversation_key, sender_key
        HAVING MAX(ingested_at) <= $2
        ORDER BY MAX(ingested_at)
      `,
        [this.tenantId, cutoff],
      );
      const created = [];
      for (const group of groups.rows) {
        const selected = await client.query(
          `
          SELECT *
          FROM messages
          WHERE tenant_id = $1
            AND conversation_key = $2
            AND sender_key = $3
            AND status = 'pending'
          ORDER BY occurred_at, platform_message_id
          FOR UPDATE SKIP LOCKED
        `,
          [this.tenantId, group.conversation_key, group.sender_key],
        );
        if (selected.rowCount === 0) continue;
        const bursts = splitMessageBursts(selected.rows, {
          gapMs: bundleGapMs,
          maxMessages: maxMessagesPerTask,
        });
        for (const rows of bursts) {
          const digest = createHash("sha256")
            .update(
              `${this.tenantId}\n${rows
                .map((message) => message.platform_message_id)
                .join("\n")}`,
            )
            .digest("hex")
            .slice(0, 24);
          const taskId = `reply_${digest}`;
          const payload = {
            messageIds: rows.map((message) => message.platform_message_id),
            latestMessageId: rows.at(-1).platform_message_id,
            latestCreateTime: rows.at(-1).occurred_at.toISOString(),
            senderName: this.cipher.decrypt(rows.at(-1).sender_name_ciphertext),
            content: rows
              .map((message) => this.cipher.decrypt(message.content_ciphertext))
              .join("\n"),
            messages: rows.map((message) => ({
              id: message.platform_message_id,
              createTime: message.occurred_at.toISOString(),
              content: this.cipher.decrypt(message.content_ciphertext),
            })),
          };
          const inserted = await client.query(
            `
            INSERT INTO tasks(
              id, tenant_id, kind, status, sender_key,
              sender_user_id_ciphertext, conversation_key,
              conversation_id_ciphertext, payload_ciphertext,
              max_attempts, available_at, created_at, updated_at
            ) VALUES (
              $1,$2,'reply','queued',$3,$4,$5,$6,$7,$8,$9,$9,$9
            )
            ON CONFLICT (id) DO NOTHING
          `,
            [
              taskId,
              this.tenantId,
              group.sender_key,
              rows.at(-1).sender_user_id_ciphertext,
              group.conversation_key,
              rows.at(-1).conversation_id_ciphertext,
              this.cipher.encrypt(JSON.stringify(payload)),
              maxAttempts,
              now,
            ],
          );
          if (inserted.rowCount === 0) continue;
          await client.query(
            `
            UPDATE messages
            SET status = 'bundled', task_id = $1
            WHERE tenant_id = $2
              AND platform_message_id = ANY($3::text[])
              AND status = 'pending'
          `,
            [
              taskId,
              this.tenantId,
              rows.map((message) => message.platform_message_id),
            ],
          );
          await this.audit(client, {
            taskId,
            eventType: "task.queued",
            details: { messageCount: rows.length },
          });
          created.push(taskId);
        }
      }
      return created;
    });
  }

  async claimTask({ leaseMs = 120_000, now = new Date() } = {}) {
    return this.transaction(async (client) => {
      await client.query(
        `
        UPDATE tasks
        SET status = 'dead', lease_until = NULL,
            last_error_ciphertext = COALESCE(last_error_ciphertext, $3),
            updated_at = $2
        WHERE tenant_id = $1
          AND status = 'processing'
          AND lease_until <= $2
          AND attempts >= max_attempts
      `,
        [
          this.tenantId,
          now,
          this.cipher.encrypt("processing lease exhausted"),
        ],
      );
      const selected = await client.query(
        `
        SELECT *
        FROM tasks
        WHERE tenant_id = $1
          AND (
            status = 'queued'
            OR (status = 'processing' AND lease_until <= $2)
          )
          AND available_at <= $2
          AND attempts < max_attempts
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
        [this.tenantId, now],
      );
      if (selected.rowCount === 0) return null;
      const row = selected.rows[0];
      const leaseUntil = new Date(now.getTime() + leaseMs);
      const updated = await client.query(
        `
        UPDATE tasks
        SET status = 'processing', attempts = attempts + 1,
            lease_until = $2, updated_at = $3
        WHERE id = $1
        RETURNING *
      `,
        [row.id, leaseUntil, now],
      );
      await this.audit(client, {
        taskId: row.id,
        eventType: "task.claimed",
        details: { leaseUntil },
      });
      return taskFromRow(updated.rows[0], this.cipher);
    });
  }

  async deferTaskForPause(taskId, retryAfterMs = 30_000, now = new Date()) {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 1_000) {
      throw new Error("Pause retry delay must be at least 1000ms");
    }
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE tasks SET status = 'queued',
         attempts = GREATEST(attempts - 1, 0), available_at = $3,
         lease_until = NULL, last_error_ciphertext = NULL, updated_at = $4
         WHERE id = $1 AND tenant_id = $2 AND status = 'processing'`,
        [
          taskId,
          this.tenantId,
          new Date(now.getTime() + retryAfterMs),
          now,
        ],
      );
      if (result.rowCount !== 1) throw new Error("Task is not processing");
      await this.audit(client, {
        taskId,
        eventType: "task.deferred_by_scope_pause",
      });
      return "queued";
    });
  }

  async completeDraft(taskId, draft, now = new Date()) {
    const status = draft.shouldReply ? "awaiting_approval" : "no_reply";
    return this.transaction(async (client) => {
      const result = await client.query(
        `
        UPDATE tasks
        SET status = $3, result_ciphertext = $4, draft_ready_at = $5, lease_until = NULL,
            last_error_ciphertext = NULL, updated_at = $5
        WHERE id = $1 AND tenant_id = $2 AND status = 'processing'
      `,
        [
          taskId,
          this.tenantId,
          status,
          this.cipher.encrypt(JSON.stringify(draft)),
          now,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error(`Task is not processing: ${taskId}`);
      }
      await this.audit(client, {
        taskId,
        eventType: draft.shouldReply
          ? "draft.awaiting_approval"
          : "draft.no_reply",
        details: {
          confidence: draft.confidence,
          riskLevel: draft.riskLevel,
        },
      });
    });
  }

  async failTask(taskId, error, now = new Date()) {
    return this.transaction(async (client) => {
      const selected = await client.query(
        `
        SELECT attempts, max_attempts
        FROM tasks
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `,
        [taskId, this.tenantId],
      );
      if (selected.rowCount === 0) return null;
      const task = selected.rows[0];
      const dead = task.attempts >= task.max_attempts;
      const delayMs = Math.min(
        300_000,
        1_000 * 2 ** Math.max(0, task.attempts - 1),
      );
      const status = dead ? "dead" : "queued";
      await client.query(
        `
        UPDATE tasks
        SET status = $3, available_at = $4, lease_until = NULL,
            last_error_ciphertext = $5, updated_at = $6
        WHERE id = $1 AND tenant_id = $2
      `,
        [
          taskId,
          this.tenantId,
          status,
          new Date(now.getTime() + delayMs),
          this.cipher.encrypt(String(error?.message ?? error)),
          now,
        ],
      );
      await this.audit(client, {
        taskId,
        eventType: `task.${status}`,
        details: { attempts: task.attempts },
      });
      return status;
    });
  }

  async decideTask(
    taskId,
    { decision, actor, reason = "" },
    now = new Date(),
  ) {
    if (!["approved", "rejected"].includes(decision)) {
      throw new Error("decision must be approved or rejected");
    }
    return this.transaction(async (client) => {
      const selected = await client.query(
        `
        SELECT status, approval_version
        FROM tasks
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `,
        [taskId, this.tenantId],
      );
      if (selected.rowCount === 0) throw new Error(`task not found: ${taskId}`);
      const task = selected.rows[0];
      if (task.status !== "awaiting_approval") {
        throw new Error(`task is not awaiting approval: ${task.status}`);
      }
      await client.query(
        `
        INSERT INTO approvals(
          id, tenant_id, task_id, approval_version,
          decision, actor, reason_ciphertext, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
        [
          randomUUID(),
          this.tenantId,
          taskId,
          task.approval_version,
          decision,
          actor,
          this.cipher.encrypt(reason),
          now,
        ],
      );
      await client.query(
        `
        UPDATE tasks
        SET status = $3, decision_at = $4, approved_at = $5,
            approved_by = $6, updated_at = $7
        WHERE id = $1 AND tenant_id = $2
      `,
        [
          taskId,
          this.tenantId,
          decision,
          now,
          decision === "approved" ? now : null,
          actor,
          now,
        ],
      );
      await this.audit(client, {
        taskId,
        eventType: `approval.${decision}`,
        actor,
        details: { approvalVersion: task.approval_version },
      });
      return decision;
    });
  }

  async claimApprovedTask({ leaseMs = 120_000, now = new Date() } = {}) {
    return this.transaction(async (client) => {
      const selected = await client.query(
        `
        SELECT *
        FROM tasks
        WHERE tenant_id = $1
          AND (
            status = 'approved'
            OR (status = 'sending' AND lease_until <= $2)
          )
          AND available_at <= $2
        ORDER BY approved_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
        [this.tenantId, now],
      );
      if (selected.rowCount === 0) return null;
      const row = selected.rows[0];
      const updated = await client.query(
        `
        UPDATE tasks
        SET status = 'sending', lease_until = $3, updated_at = $4
        WHERE id = $1 AND tenant_id = $2
        RETURNING *
      `,
        [
          row.id,
          this.tenantId,
          new Date(now.getTime() + leaseMs),
          now,
        ],
      );
      await this.audit(client, {
        taskId: row.id,
        eventType: "send.claimed",
      });
      return taskFromRow(updated.rows[0], this.cipher);
    });
  }

  async beginSideEffect(taskId, capability, now = new Date()) {
    return this.transaction(async (client) => {
      const key = `${capability}:${taskId}`;
      await client.query(
        `
        INSERT INTO side_effects(
          idempotency_key, tenant_id, task_id, capability,
          status, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,'started',$5,$5)
        ON CONFLICT (idempotency_key) DO NOTHING
      `,
        [key, this.tenantId, taskId, capability, now],
      );
      const result = await client.query(
        `
        SELECT *
        FROM side_effects
        WHERE idempotency_key = $1 AND tenant_id = $2
      `,
        [key, this.tenantId],
      );
      return {
        ...result.rows[0],
        receipt_json: result.rows[0].receipt_ciphertext
          ? this.cipher.decrypt(result.rows[0].receipt_ciphertext)
          : null,
      };
    });
  }

  async completeSideEffect(taskId, capability, receipt, now = new Date()) {
    return this.transaction(async (client) => {
      const key = `${capability}:${taskId}`;
      const effect = await client.query(
        `
        UPDATE side_effects
        SET status = 'completed', receipt_ciphertext = $3,
            last_error_ciphertext = NULL, updated_at = $4
        WHERE idempotency_key = $1 AND tenant_id = $2
        RETURNING idempotency_key
      `,
        [
          key,
          this.tenantId,
          this.cipher.encrypt(JSON.stringify(receipt)),
          now,
        ],
      );
      if (effect.rowCount !== 1) throw new Error("Side effect was not started");
      await client.query(
        `
        UPDATE tasks
        SET status = 'completed', lease_until = NULL, updated_at = $3
        WHERE id = $1 AND tenant_id = $2
      `,
        [taskId, this.tenantId, now],
      );
      await this.audit(client, {
        taskId,
        eventType: "send.completed",
      });
    });
  }

  async markSideEffectUnknown(
    taskId,
    capability,
    error,
    now = new Date(),
  ) {
    return this.transaction(async (client) => {
      const key = `${capability}:${taskId}`;
      await client.query(
        `
        UPDATE side_effects
        SET status = 'unknown', last_error_ciphertext = $3, updated_at = $4
        WHERE idempotency_key = $1 AND tenant_id = $2
      `,
        [
          key,
          this.tenantId,
          this.cipher.encrypt(String(error?.message ?? error)),
          now,
        ],
      );
      await client.query(
        `
        UPDATE tasks
        SET status = 'send_unknown', lease_until = NULL,
            last_error_ciphertext = $3, updated_at = $4
        WHERE id = $1 AND tenant_id = $2
      `,
        [
          taskId,
          this.tenantId,
          this.cipher.encrypt(String(error?.message ?? error)),
          now,
        ],
      );
      await this.audit(client, {
        taskId,
        eventType: "send.unknown",
        details: { error: String(error?.message ?? error) },
      });
    });
  }

  async returnApprovedTask(
    taskId,
    reason,
    now = new Date(),
    retryAfterMs = 30_000,
  ) {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 1_000) {
      throw new Error("Send retry delay must be at least 1000ms");
    }
    await this.pool.query(
      `
      UPDATE tasks
      SET status = 'approved', lease_until = NULL,
          available_at = $3, last_error_ciphertext = $4, updated_at = $5
      WHERE id = $1 AND tenant_id = $2 AND status = 'sending'
    `,
      [
        taskId,
        this.tenantId,
        new Date(now.getTime() + retryAfterMs),
        this.cipher.encrypt(reason),
        now,
      ],
    );
  }

  async cancelForManualReply(taskId, now = new Date()) {
    return this.transaction(async (client) => {
      await client.query(
        `
        UPDATE tasks
        SET status = 'cancelled_manual', lease_until = NULL, updated_at = $3
        WHERE id = $1 AND tenant_id = $2 AND status = 'sending'
      `,
        [taskId, this.tenantId, now],
      );
      await this.audit(client, {
        taskId,
        eventType: "send.cancelled_manual",
      });
    });
  }

  async cancelDraftForManualReply(taskId, now = new Date()) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `
        UPDATE tasks
        SET status = 'cancelled_manual', updated_at = $3
        WHERE id = $1 AND tenant_id = $2 AND status = 'awaiting_approval'
      `,
        [taskId, this.tenantId, now],
      );
      if (result.rowCount === 0) return false;
      await this.audit(client, {
        taskId,
        eventType: "draft.cancelled_manual",
      });
      return true;
    });
  }

  async getTask(taskId) {
    const result = await this.pool.query(
      "SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2",
      [taskId, this.tenantId],
    );
    return taskFromRow(result.rows[0], this.cipher);
  }

  async listTasks({
    limit = 50,
    offset = 0,
    status,
    beforeCreatedAt,
    beforeId,
  } = {}) {
    let result;
    if (status && beforeCreatedAt && beforeId) {
      result = await this.pool.query(
        `
        SELECT * FROM tasks
        WHERE tenant_id = $1 AND status = $2
          AND (created_at, id) < ($3, $4)
        ORDER BY created_at DESC, id DESC
        LIMIT $5
      `,
        [this.tenantId, status, beforeCreatedAt, beforeId, limit],
      );
    } else if (status) {
      result = await this.pool.query(
          `
          SELECT * FROM tasks
          WHERE tenant_id = $1 AND status = $2
          ORDER BY created_at DESC, id DESC
          LIMIT $3 OFFSET $4
        `,
          [this.tenantId, status, limit, offset],
        );
    } else {
      result = await this.pool.query(
          `
          SELECT * FROM tasks
          WHERE tenant_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2 OFFSET $3
        `,
          [this.tenantId, limit, offset],
        );
    }
    return result.rows.map((row) => taskFromRow(row, this.cipher));
  }

  async expireAwaitingDrafts({ before, now = new Date() }) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `
        UPDATE tasks
        SET status = 'expired', updated_at = $3
        WHERE tenant_id = $1
          AND status = 'awaiting_approval'
          AND updated_at < $2
        RETURNING id
      `,
        [this.tenantId, before, now],
      );
      for (const row of result.rows) {
        await this.audit(client, {
          taskId: row.id,
          eventType: "draft.expired",
        });
      }
      return result.rowCount;
    });
  }

  async retryTask(taskId, now = new Date()) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE tasks
         SET status = 'queued', attempts = 0, available_at = $3,
             lease_until = NULL, last_error_ciphertext = NULL, updated_at = $3
         WHERE id = $1 AND tenant_id = $2 AND status = 'dead'`,
        [taskId, this.tenantId, now],
      );
      if (result.rowCount !== 1) {
        throw new Error("Only dead tasks can be retried");
      }
      await this.audit(client, {
        taskId,
        eventType: "task.retried_by_operator",
        actor: this.config.approver ?? "operator",
      });
    });
  }

  async dismissDeadTask(taskId, actor, reason = "", now = new Date()) {
    if (!String(actor ?? "").trim()) throw new Error("actor is required");
    return this.transaction(async (client) => {
      const result = await client.query(
        `
        UPDATE tasks
        SET status = 'cancelled_operator', lease_until = NULL, updated_at = $3
        WHERE id = $1 AND tenant_id = $2 AND status = 'dead'
        RETURNING id
      `,
        [taskId, this.tenantId, now],
      );
      if (result.rowCount !== 1) {
        throw new Error("Only dead tasks can be dismissed");
      }
      await this.audit(client, {
        taskId,
        eventType: "task.dismissed_by_operator",
        actor,
        details: { reason: String(reason).slice(0, 1_000) },
      });
      return "cancelled_operator";
    });
  }

  async resolveUnknownSend(taskId, resolution, actor, now = new Date()) {
    if (!["sent", "not_sent"].includes(resolution)) {
      throw new Error("resolution must be sent or not_sent");
    }
    return this.transaction(async (client) => {
      const selected = await client.query(
        `
        SELECT status
        FROM tasks
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `,
        [taskId, this.tenantId],
      );
      if (selected.rows[0]?.status !== "send_unknown") {
        throw new Error("Task is not in send_unknown state");
      }
      if (resolution === "sent") {
        await client.query(
          `
          UPDATE side_effects
          SET status = 'completed', receipt_ciphertext = $3,
              last_error_ciphertext = NULL, updated_at = $4
          WHERE task_id = $1 AND tenant_id = $2
            AND capability = 'send_message'
        `,
          [
            taskId,
            this.tenantId,
            this.cipher.encrypt(JSON.stringify({ manuallyConfirmedBy: actor })),
            now,
          ],
        );
        await client.query(
          `
          UPDATE tasks
          SET status = 'completed', last_error_ciphertext = NULL, updated_at = $3
          WHERE id = $1 AND tenant_id = $2
        `,
          [taskId, this.tenantId, now],
        );
      } else {
        await client.query(
          `
          DELETE FROM side_effects
          WHERE task_id = $1 AND tenant_id = $2
            AND capability = 'send_message'
        `,
          [taskId, this.tenantId],
        );
        await client.query(
          `
          UPDATE tasks
          SET status = 'approved', last_error_ciphertext = NULL, updated_at = $3
          WHERE id = $1 AND tenant_id = $2
        `,
          [taskId, this.tenantId, now],
        );
      }
      await this.audit(client, {
        taskId,
        eventType: `send.resolved_${resolution}`,
        actor,
      });
    });
  }

  async getCheckpoint(key) {
    const result = await this.pool.query(
      "SELECT value FROM checkpoints WHERE tenant_id = $1 AND key = $2",
      [this.tenantId, key],
    );
    return result.rows[0]?.value;
  }

  async knownMessageIds(ids) {
    const unique = [...new Set(ids.map(String))];
    if (unique.length === 0) return new Set();
    const result = await this.pool.query(
      `SELECT platform_message_id FROM messages
       WHERE tenant_id = $1 AND platform_message_id = ANY($2::text[])`,
      [this.tenantId, unique],
    );
    return new Set(result.rows.map((row) => String(row.platform_message_id)));
  }

  async setCheckpoint(key, value, now = new Date()) {
    await this.pool.query(
      `
      INSERT INTO checkpoints(tenant_id, key, value, updated_at)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `,
      [this.tenantId, key, value, now],
    );
  }

  async setScopedPause(change, now = new Date()) {
    const normalized = normalizePauseChange(change);
    const key = scopedPauseKey(
      this.cipher,
      normalized.type,
      normalized.value,
    );
    return this.transaction(async (client) => {
      if (normalized.paused) {
        await client.query(
          `INSERT INTO checkpoints(tenant_id, key, value, updated_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (tenant_id, key)
           DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [
            this.tenantId,
            key,
            this.cipher.encrypt(JSON.stringify({
              type: normalized.type,
              value: normalized.value,
              actor: normalized.actor,
              reason: normalized.reason,
              pausedAt: now.toISOString(),
            })),
            now,
          ],
        );
      } else {
        await client.query(
          "DELETE FROM checkpoints WHERE tenant_id = $1 AND key = $2",
          [this.tenantId, key],
        );
      }
      await this.audit(client, {
        eventType: normalized.paused ? "scope.paused" : "scope.resumed",
        actor: normalized.actor,
        details: {
          type: normalized.type,
          valueFingerprint: this.cipher.fingerprint(normalized.value),
          reason: normalized.reason,
        },
      });
      return normalized.paused;
    });
  }

  async isScopedPaused(type, value) {
    const scope = normalizePauseScope(type, value);
    const key = scopedPauseKey(this.cipher, scope.type, scope.value);
    const result = await this.pool.query(
      "SELECT 1 FROM checkpoints WHERE tenant_id = $1 AND key = $2",
      [this.tenantId, key],
    );
    return result.rowCount === 1;
  }

  async listScopedPauses() {
    const result = await this.pool.query(
      `SELECT value, updated_at FROM checkpoints
       WHERE tenant_id = $1 AND left(key, 13) = 'scoped_pause:'
       ORDER BY updated_at DESC`,
      [this.tenantId],
    );
    return result.rows.map((row) => ({
      ...JSON.parse(this.cipher.decrypt(row.value)),
      updatedAt: row.updated_at,
    }));
  }

  async proposeMemory(input, now = new Date()) {
    const memory = validateMemoryProposal(input);
    const id = `memory_${randomUUID()}`;
    await this.transaction(async (client) => {
      await client.query(
        `
        INSERT INTO memory_items(
          id, tenant_id, type, subject_key, subject_ciphertext, project_id,
          statement_ciphertext, source_type, source_id_ciphertext,
          source_version, scope_ciphertext, confidence, status,
          sensitivity, expires_at, created_by, updated_by, supersedes_id,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'proposed',$13,$14,$15,$15,$16,$17,$17)
      `,
        [
          id,
          this.tenantId,
          memory.type,
          this.cipher.fingerprint(memory.subject),
          this.cipher.encrypt(memory.subject),
          memory.projectId,
          this.cipher.encrypt(memory.statement),
          memory.sourceType,
          this.cipher.encrypt(memory.sourceId),
          memory.sourceVersion,
          this.cipher.encrypt(JSON.stringify(memory.scope)),
          memory.confidence,
          memory.sensitivity,
          memory.expiresAt,
          memory.createdBy,
          memory.supersedesId,
          now,
        ],
      );
      await this.audit(client, {
        eventType: "memory.proposed",
        actor: memory.createdBy,
        details: { memoryId: id, type: memory.type, projectId: memory.projectId },
      });
    });
    return id;
  }

  async confirmMemory(id, actor, now = new Date(), { supersedesId = null } = {}) {
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM memory_items
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [this.tenantId, id],
      );
      if (selected.rowCount === 0) throw new Error(`Memory not found: ${id}`);
      const memory = selected.rows[0];
      if (memory.status !== "proposed") throw new Error("Memory is not proposed");
      const activeResult = await client.query(
        `SELECT * FROM memory_items
         WHERE tenant_id = $1 AND status = 'confirmed' AND deleted_at IS NULL
           AND type = $2 AND subject_key = $3
           AND project_id IS NOT DISTINCT FROM $4
           AND (expires_at IS NULL OR expires_at > $5)
         ORDER BY updated_at DESC FOR UPDATE`,
        [this.tenantId, memory.type, memory.subject_key, memory.project_id, now],
      );
      const candidate = memoryFromRow(memory, this.cipher);
      const factKey = memoryFactKey(candidate);
      const comparable = factKey
        ? activeResult.rows.filter(
            (item) => memoryFactKey(memoryFromRow(item, this.cipher)) === factKey,
          )
        : [];
      const statement = candidate.statement.trim();
      const duplicates = comparable.filter(
        (item) => this.cipher.decrypt(item.statement_ciphertext).trim() === statement,
      );
      const conflicts = comparable.filter(
        (item) => this.cipher.decrypt(item.statement_ciphertext).trim() !== statement,
      );
      if (duplicates.length > 0) throw new Error("Memory duplicates an active fact");
      if (conflicts.length > 1) {
        throw new Error("Multiple active memory conflicts require manual reconciliation");
      }
      const replacementId = supersedesId ?? memory.supersedes_id;
      if (conflicts.length === 1 && replacementId !== conflicts[0].id) {
        throw new Error("Memory conflict requires an explicit supersedesId");
      }
      if (
        conflicts.length === 0 &&
        replacementId &&
        !activeResult.rows.some((item) => item.id === replacementId)
      ) {
        throw new Error("Superseded memory is not an active conflicting fact");
      }
      await client.query(
        `UPDATE memory_items
         SET status = 'confirmed', supersedes_id = $3,
             valid_from = $4, updated_at = $4, updated_by = $5
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id, replacementId, now, actor],
      );
      if (replacementId) {
        await client.query(
          `UPDATE memory_items SET status = 'revoked', updated_at = $3, updated_by = $4
           WHERE tenant_id = $1 AND id = $2 AND status = 'confirmed'`,
          [this.tenantId, replacementId, now, actor],
        );
      }
      await this.audit(client, {
        eventType: "memory.confirmed",
        actor,
        details: { memoryId: id, supersedesId: replacementId },
      });
      return "confirmed";
    });
  }

  async revokeMemory(id, actor, now = new Date()) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE memory_items SET status = 'revoked', updated_at = $3, updated_by = $4
         WHERE tenant_id = $1 AND id = $2
           AND status IN ('proposed', 'confirmed')`,
        [this.tenantId, id, now, actor],
      );
      if (result.rowCount !== 1) throw new Error("Memory cannot be revoked");
      await this.audit(client, {
        eventType: "memory.revoked",
        actor,
        details: { memoryId: id },
      });
      return "revoked";
    });
  }

  async deleteMemory(id, actor, confirmation, now = new Date()) {
    if (confirmation !== memoryDeletionConfirmation(id)) {
      throw new Error("Memory deletion confirmation does not match");
    }
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT id FROM memory_items
         WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [this.tenantId, id],
      );
      if (selected.rowCount !== 1) throw new Error("Memory cannot be deleted");
      const result = await client.query(
        `UPDATE memory_items SET
           subject_key = $3, subject_ciphertext = $4, project_id = NULL,
           statement_ciphertext = $5, source_type = 'deleted',
           source_id_ciphertext = $6, source_version = NULL,
           scope_ciphertext = $7, confidence = 0, status = 'revoked',
           sensitivity = 'internal', valid_from = NULL, expires_at = NULL,
           created_by = 'deleted', updated_by = 'deleted', supersedes_id = NULL,
           created_at = $8, updated_at = $8, deleted_at = $8
         WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [
          this.tenantId,
          id,
          this.cipher.fingerprint(`deleted:${id}:${randomUUID()}`),
          this.cipher.encrypt(""),
          this.cipher.encrypt(""),
          this.cipher.encrypt(""),
          this.cipher.encrypt("{}"),
          now,
        ],
      );
      if (result.rowCount !== 1) throw new Error("Memory cannot be deleted");
      await this.audit(client, {
        eventType: "memory.deleted",
        actor,
        details: { memoryId: id, erased: true },
      });
      return "deleted";
    });
  }

  async recordMemoryExport({
    actor,
    projectId,
    includeContent,
    count,
    destination,
  }, now = new Date()) {
    return this.transaction(async (client) => {
      await this.audit(client, {
        eventType: "memory.exported",
        actor,
        details: {
          projectId,
          includeContent,
          count,
          destinationFingerprint: this.cipher.fingerprint(destination),
        },
      });
      return { recorded: true, at: now.toISOString() };
    });
  }

  async listMemories({
    type,
    subject,
    projectId,
    status,
    sensitivity,
    limit = 100,
  } = {}) {
    const parameters = [this.tenantId];
    const clauses = ["tenant_id = $1", "deleted_at IS NULL"];
    const add = (sql, value) => {
      parameters.push(value);
      clauses.push(`${sql} $${parameters.length}`);
    };
    if (type) add("type =", type);
    if (subject) add("subject_key =", this.cipher.fingerprint(subject));
    if (projectId) add("project_id =", projectId);
    if (status) add("status =", status);
    if (sensitivity) add("sensitivity =", sensitivity);
    parameters.push(limit);
    const result = await this.pool.query(
      `SELECT * FROM memory_items WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC, id DESC LIMIT $${parameters.length}`,
      parameters,
    );
    return result.rows.map((row) => memoryFromRow(row, this.cipher));
  }

  async memoryConflictMetrics(now = new Date()) {
    return analyzeMemoryConflicts(await this.listMemories({ limit: 1_000 }), now);
  }

  async searchMemories({ query = "", now = new Date(), limit = 20, ...filters } = {}) {
    const needle = String(query).trim().toLowerCase();
    const memories = await this.listMemories({
      ...filters,
      status: "confirmed",
      limit: 500,
    });
    return memories
      .filter((memory) => memoryIsUsable(memory, now))
      .filter(
        (memory) =>
          !needle ||
          memory.statement.toLowerCase().includes(needle) ||
          memory.subject.toLowerCase().includes(needle),
      )
      .slice(0, limit);
  }

  async registerWorkPlan(assessment, now = new Date()) {
    if (!assessment?.planHash || !assessment?.plan) {
      throw new Error("Assessed work plan is required");
    }
    if (!["ALLOW", "REQUIRE_APPROVAL"].includes(assessment.decision)) {
      throw new Error("Denied work plan cannot be registered");
    }
    const id = `plan_${assessment.planHash.slice(0, 24)}`;
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO work_plans(
          id, tenant_id, project_id, requester_key, requester_ciphertext,
          objective_ciphertext, plan_ciphertext, plan_hash, max_level,
          policy_decision, status, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
        ON CONFLICT (tenant_id, plan_hash) DO NOTHING`,
        [
          id,
          this.tenantId,
          assessment.plan.projectId,
          this.cipher.fingerprint(assessment.plan.requesterId),
          this.cipher.encrypt(assessment.plan.requesterId),
          this.cipher.encrypt(assessment.plan.objective),
          this.cipher.encrypt(JSON.stringify(assessment.plan)),
          assessment.planHash,
          assessment.maxLevel,
          assessment.decision,
          assessment.decision === "ALLOW" ? "ready" : "awaiting_approval",
          now,
        ],
      );
      for (const [position, step] of assessment.plan.steps.entries()) {
        await client.query(
          `INSERT INTO work_plan_steps(
            tenant_id, work_plan_id, step_id, position,
            capability, status, updated_at
          ) VALUES ($1,$2,$3,$4,$5,'pending',$6)
          ON CONFLICT (tenant_id, work_plan_id, step_id) DO NOTHING`,
          [this.tenantId, id, step.id, position, step.capability, now],
        );
      }
      await this.audit(client, {
        eventType: "work_plan.registered",
        actor: assessment.plan.requesterId,
        details: {
          workPlanId: id,
          projectId: assessment.plan.projectId,
          planHash: assessment.planHash,
          decision: assessment.decision,
        },
      });
    });
    return this.getWorkPlan(id);
  }

  async reviseWorkPlan(id, assessment, actor, now = new Date()) {
    if (!String(actor ?? "").trim()) {
      throw new Error("Work plan revision actor is required");
    }
    const revisedId = `plan_${assessment?.planHash?.slice(0, 24)}`;
    await this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM work_plans
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [this.tenantId, id],
      );
      const current = selected.rows[0];
      if (!current || !["awaiting_approval", "rejected"].includes(current.status)) {
        throw new Error("Work plan can no longer be revised");
      }
      validateWorkPlanRevision({
        currentPlan: JSON.parse(this.cipher.decrypt(current.plan_ciphertext)),
        currentPlanHash: current.plan_hash,
        assessment,
      });
      const duplicate = await client.query(
        `SELECT 1 FROM work_plans
         WHERE tenant_id = $1 AND (id = $2 OR plan_hash = $3)`,
        [this.tenantId, revisedId, assessment.planHash],
      );
      if (duplicate.rowCount > 0) throw new Error("Revised work plan already exists");
      await client.query(
        `INSERT INTO work_plans(
          id, tenant_id, project_id, requester_key, requester_ciphertext,
          objective_ciphertext, plan_ciphertext, plan_hash, max_level,
          policy_decision, status, supersedes_work_plan_id, revision_actor,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'awaiting_approval',$11,$12,$13,$13)`,
        [
          revisedId,
          this.tenantId,
          assessment.plan.projectId,
          this.cipher.fingerprint(assessment.plan.requesterId),
          this.cipher.encrypt(assessment.plan.requesterId),
          this.cipher.encrypt(assessment.plan.objective),
          this.cipher.encrypt(JSON.stringify(assessment.plan)),
          assessment.planHash,
          assessment.maxLevel,
          assessment.decision,
          id,
          actor,
          now,
        ],
      );
      for (const [position, step] of assessment.plan.steps.entries()) {
        await client.query(
          `INSERT INTO work_plan_steps(
            tenant_id, work_plan_id, step_id, position,
            capability, status, updated_at
          ) VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
          [this.tenantId, revisedId, step.id, position, step.capability, now],
        );
      }
      const updated = await client.query(
        `UPDATE work_plans SET status = 'superseded', updated_at = $3
         WHERE tenant_id = $1 AND id = $2
           AND status IN ('awaiting_approval','rejected')`,
        [this.tenantId, id, now],
      );
      if (updated.rowCount !== 1) throw new Error("Work plan revision race detected");
      await this.audit(client, {
        eventType: "work_plan.revised",
        actor,
        details: {
          previousWorkPlanId: id,
          revisedWorkPlanId: revisedId,
          previousPlanHash: current.plan_hash,
          revisedPlanHash: assessment.planHash,
        },
      });
    });
    return this.getWorkPlan(revisedId);
  }

  async getWorkPlan(id) {
    const result = await this.pool.query(
      "SELECT * FROM work_plans WHERE tenant_id = $1 AND id = $2",
      [this.tenantId, id],
    );
    return workPlanFromRow(result.rows[0], this.cipher);
  }

  async listWorkPlans({ status, limit = 100 } = {}) {
    const result = status
      ? await this.pool.query(
          `SELECT * FROM work_plans
           WHERE tenant_id = $1 AND status = $2
           ORDER BY updated_at DESC, id DESC LIMIT $3`,
          [this.tenantId, status, limit],
        )
      : await this.pool.query(
          `SELECT * FROM work_plans
           WHERE tenant_id = $1
           ORDER BY updated_at DESC, id DESC LIMIT $2`,
          [this.tenantId, limit],
        );
    return result.rows.map((row) => workPlanFromRow(row, this.cipher));
  }

  async decideWorkPlan(
    id,
    { decision, actor, reason = "", expiresAt, maxConsumptions = 1 },
    now = new Date(),
  ) {
    if (!["approved", "rejected"].includes(decision)) {
      throw new Error("decision must be approved or rejected");
    }
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM work_plans
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [this.tenantId, id],
      );
      const plan = selected.rows[0];
      if (!plan || plan.status !== "awaiting_approval") {
        throw new Error("Work plan is not awaiting approval");
      }
      const expiry = expiresAt
        ? new Date(expiresAt)
        : new Date(now.getTime() + 2 * 60 * 60 * 1000);
      if (
        decision === "approved" &&
        (!Number.isFinite(expiry.getTime()) || expiry <= now)
      ) {
        throw new Error("Approval expiry must be in the future");
      }
      if (!Number.isSafeInteger(maxConsumptions) || maxConsumptions <= 0) {
        throw new Error("maxConsumptions must be a positive integer");
      }
      await client.query(
        `INSERT INTO work_plan_approvals(
          id, tenant_id, work_plan_id, plan_hash, approval_version,
          decision, actor, reason_ciphertext, expires_at,
          max_consumptions, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          randomUUID(),
          this.tenantId,
          id,
          plan.plan_hash,
          plan.approval_version,
          decision,
          actor,
          this.cipher.encrypt(reason),
          decision === "approved" ? expiry : null,
          maxConsumptions,
          now,
        ],
      );
      await client.query(
        "UPDATE work_plans SET status = $3, updated_at = $4 WHERE tenant_id = $1 AND id = $2",
        [this.tenantId, id, decision, now],
      );
      await this.audit(client, {
        eventType: `work_plan.${decision}`,
        actor,
        details: { workPlanId: id, planHash: plan.plan_hash },
      });
      return decision;
    });
  }

  async consumeWorkPlanAuthorization(
    id,
    now = new Date(),
    { owner = null, leaseExpiresAt = null } = {},
  ) {
    if (owner && !(leaseExpiresAt instanceof Date && leaseExpiresAt > now)) {
      throw new Error("Execution lease expiry must be in the future");
    }
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM work_plans
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [this.tenantId, id],
      );
      const plan = selected.rows[0];
      if (!plan) throw new Error("Work plan not found");
      if (plan.status === "ready" && plan.policy_decision === "ALLOW") {
        await client.query(
          `UPDATE work_plans SET status = 'executing', execution_owner = $3,
           lease_expires_at = $4, updated_at = $5
           WHERE tenant_id = $1 AND id = $2`,
          [this.tenantId, id, owner, leaseExpiresAt, now],
        );
        return true;
      }
      if (plan.status !== "approved") {
        throw new Error("Work plan is not authorized");
      }
      const approval = await client.query(
        `SELECT * FROM work_plan_approvals
         WHERE tenant_id = $1 AND work_plan_id = $2
           AND approval_version = $3 AND decision = 'approved'
           AND plan_hash = $4 AND expires_at > $5
           AND consumed < max_consumptions
         FOR UPDATE`,
        [this.tenantId, id, plan.approval_version, plan.plan_hash, now],
      );
      if (approval.rowCount !== 1) {
        throw new Error("Work plan approval is invalid or expired");
      }
      await client.query(
        `UPDATE work_plan_approvals SET consumed = consumed + 1
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, approval.rows[0].id],
      );
      await client.query(
        `UPDATE work_plans SET status = 'executing', execution_owner = $3,
         lease_expires_at = $4, updated_at = $5
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id, owner, leaseExpiresAt, now],
      );
      await this.audit(client, {
        eventType: "work_plan.authorization_consumed",
        details: { workPlanId: id, planHash: plan.plan_hash },
      });
      return true;
    });
  }

  async renewWorkPlanLease(id, owner, leaseExpiresAt, now = new Date()) {
    if (!owner || !(leaseExpiresAt instanceof Date && leaseExpiresAt > now)) {
      throw new Error("Valid execution owner and future lease expiry are required");
    }
    const result = await this.pool.query(
      `UPDATE work_plans SET lease_expires_at = $4, updated_at = $5
       WHERE tenant_id = $1 AND id = $2 AND execution_owner = $3
         AND status IN ('executing','verifying')`,
      [this.tenantId, id, owner, leaseExpiresAt, now],
    );
    if (result.rowCount !== 1) throw new Error("Work plan execution lease was lost");
    return true;
  }

  async requestWorkPlanCancellation(id, actor, now = new Date()) {
    if (!String(actor ?? "").trim()) throw new Error("Cancellation actor is required");
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT status FROM work_plans
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [this.tenantId, id],
      );
      const plan = selected.rows[0];
      if (!plan) throw new Error("Work plan not found");
      if (plan.status === "cancelled") return "cancelled";
      let status;
      if (["ready", "awaiting_approval", "approved"].includes(plan.status)) {
        await client.query(
          `UPDATE work_plan_steps SET status = 'cancelled',
           completed_at = $3, updated_at = $3
           WHERE tenant_id = $1 AND work_plan_id = $2 AND status = 'pending'`,
          [this.tenantId, id, now],
        );
        await client.query(
          `UPDATE work_plans SET status = 'cancelled', cancel_requested_at = $3,
           cancel_requested_by = $4, updated_at = $3
           WHERE tenant_id = $1 AND id = $2`,
          [this.tenantId, id, now, actor],
        );
        status = "cancelled";
      } else if (["executing", "verifying"].includes(plan.status)) {
        await client.query(
          `UPDATE work_plans SET cancel_requested_at = COALESCE(cancel_requested_at, $3),
           cancel_requested_by = COALESCE(cancel_requested_by, $4), updated_at = $3
           WHERE tenant_id = $1 AND id = $2`,
          [this.tenantId, id, now, actor],
        );
        status = "cancellation_requested";
      } else {
        throw new Error("Work plan can no longer be cancelled");
      }
      await this.audit(client, {
        eventType: "work_plan.cancellation_requested",
        actor,
        details: { workPlanId: id, result: status },
      });
      return status;
    });
  }

  async isWorkPlanCancellationRequested(id) {
    const result = await this.pool.query(
      `SELECT 1 FROM work_plans
       WHERE tenant_id = $1 AND id = $2 AND cancel_requested_at IS NOT NULL
         AND status IN ('executing','verifying')`,
      [this.tenantId, id],
    );
    return result.rowCount === 1;
  }

  async finalizeWorkPlanCancellation(id, now = new Date()) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE work_plans SET status = 'cancelled', execution_owner = NULL,
         lease_expires_at = NULL, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND cancel_requested_at IS NOT NULL
           AND status IN ('executing','verifying')`,
        [this.tenantId, id, now],
      );
      if (result.rowCount !== 1) {
        throw new Error("Work plan has no active cancellation request");
      }
      await client.query(
        `UPDATE work_plan_steps SET status = 'cancelled',
         completed_at = $3, updated_at = $3
         WHERE tenant_id = $1 AND work_plan_id = $2
           AND status IN ('pending','executing','verifying')`,
        [this.tenantId, id, now],
      );
      await this.audit(client, {
        eventType: "work_plan.cancelled",
        details: { workPlanId: id },
      });
      return "cancelled";
    });
  }

  async recoverExpiredWorkPlans(now = new Date()) {
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT id FROM work_plans
         WHERE tenant_id = $1 AND status IN ('executing','verifying')
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= $2
         FOR UPDATE`,
        [this.tenantId, now],
      );
      for (const { id } of selected.rows) {
        await client.query(
          `UPDATE work_plan_steps SET status = 'failed', error_ciphertext = $3,
           completed_at = $4, updated_at = $4
           WHERE tenant_id = $1 AND work_plan_id = $2
             AND status IN ('executing','verifying')`,
          [this.tenantId, id, this.cipher.encrypt("execution_interrupted"), now],
        );
        await client.query(
          `UPDATE work_plans SET status = 'failed', execution_owner = NULL,
           lease_expires_at = NULL, updated_at = $3
           WHERE tenant_id = $1 AND id = $2`,
          [this.tenantId, id, now],
        );
        await this.audit(client, {
          eventType: "work_plan.interrupted",
          details: { workPlanId: id },
        });
      }
      return selected.rowCount;
    });
  }

  async listWorkPlanSteps(id) {
    const result = await this.pool.query(
      `SELECT * FROM work_plan_steps
       WHERE tenant_id = $1 AND work_plan_id = $2 ORDER BY position`,
      [this.tenantId, id],
    );
    return result.rows.map((row) => ({
      ...row,
      evidence: row.evidence_ciphertext
        ? JSON.parse(this.cipher.decrypt(row.evidence_ciphertext))
        : null,
      error: row.error_ciphertext
        ? this.cipher.decrypt(row.error_ciphertext)
        : null,
      evidence_ciphertext: undefined,
      error_ciphertext: undefined,
    }));
  }

  async updateWorkPlanStep(
    id,
    stepId,
    { status, evidence = null, error = null },
    now = new Date(),
  ) {
    const allowed = new Set([
      "executing",
      "verifying",
      "completed",
      "failed",
      "cancelled",
    ]);
    if (!allowed.has(status)) throw new Error("Invalid work plan step status");
    const result = await this.pool.query(
      `UPDATE work_plan_steps SET
        status = $4,
        evidence_ciphertext = COALESCE($5, evidence_ciphertext),
        error_ciphertext = $6,
        started_at = CASE WHEN $4 = 'executing' THEN COALESCE(started_at, $7) ELSE started_at END,
        completed_at = CASE WHEN $4 IN ('completed','failed','cancelled') THEN $7 ELSE completed_at END,
        updated_at = $7
       WHERE tenant_id = $1 AND work_plan_id = $2 AND step_id = $3`,
      [
        this.tenantId,
        id,
        stepId,
        status,
        evidence == null ? null : this.cipher.encrypt(JSON.stringify(evidence)),
        error == null ? null : this.cipher.encrypt(String(error)),
        now,
      ],
    );
    if (result.rowCount !== 1) throw new Error("Work plan step not found");
  }

  async finishWorkPlan(id, { success, error = null }, now = new Date()) {
    const status = success ? "completed" : "failed";
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE work_plans SET status = $3, execution_owner = NULL,
         lease_expires_at = NULL, updated_at = $4
         WHERE tenant_id = $1 AND id = $2
           AND status IN ('executing','verifying')`,
        [this.tenantId, id, status, now],
      );
      if (result.rowCount !== 1) throw new Error("Work plan is not executing");
      await this.audit(client, {
        eventType: `work_plan.${status}`,
        details: { workPlanId: id, error: error ? "present" : null },
      });
      return { status, error };
    });
  }

  async ensureWorkPlanResultDraft(planId, now = new Date()) {
    return this.transaction(async (client) => {
      const planResult = await client.query(
        "SELECT * FROM work_plans WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [this.tenantId, planId],
      );
      const plan = workPlanFromRow(planResult.rows[0], this.cipher);
      if (!plan) throw new Error("Work plan not found");
      const stepResult = await client.query(
        `SELECT * FROM work_plan_steps
         WHERE tenant_id = $1 AND work_plan_id = $2 ORDER BY position`,
        [this.tenantId, planId],
      );
      const draft = buildPlanResultDraft({ plan, steps: stepResult.rows, now });
      if (!draft) return null;
      const sourceResult = await client.query(
        "SELECT * FROM tasks WHERE tenant_id = $1 AND id = $2",
        [this.tenantId, draft.sourceTaskId],
      );
      const sourceRow = sourceResult.rows[0];
      if (!sourceRow) return null;
      const source = taskFromRow(sourceRow, this.cipher);
      const payload = {
        ...draft.payload,
        senderName: source.payload?.senderName ?? null,
      };
      const inserted = await client.query(
        `INSERT INTO tasks(
          id, tenant_id, kind, status, sender_key,
          sender_user_id_ciphertext, conversation_key,
          conversation_id_ciphertext, payload_ciphertext,
          result_ciphertext, max_attempts, available_at,
          draft_ready_at, created_at, updated_at
        ) VALUES ($1,$2,'reply','awaiting_approval',$3,$4,$5,$6,$7,$8,1,$9,$9,$9,$9)
        ON CONFLICT (id) DO NOTHING`,
        [
          draft.id,
          this.tenantId,
          sourceRow.sender_key,
          this.cipher.encrypt(source.sender_user_id),
          sourceRow.conversation_key,
          this.cipher.encrypt(source.conversation_id),
          this.cipher.encrypt(JSON.stringify(payload)),
          this.cipher.encrypt(JSON.stringify(draft.result)),
          now,
        ],
      );
      if (inserted.rowCount === 1) {
        await this.audit(client, {
          taskId: draft.id,
          eventType: "work_plan.result_draft_created",
          details: { workPlanId: planId },
        });
      }
      const created = await client.query(
        "SELECT * FROM tasks WHERE tenant_id = $1 AND id = $2",
        [this.tenantId, draft.id],
      );
      return taskFromRow(created.rows[0], this.cipher);
    });
  }

  async upsertDecisionReview(
    taskId,
    { expectedShouldReply, reviewer, note = "" },
    now = new Date(),
  ) {
    if (typeof expectedShouldReply !== "boolean") {
      throw new Error("expectedShouldReply must be boolean");
    }
    if (!String(reviewer ?? "").trim()) throw new Error("reviewer is required");
    const task = await this.getTask(taskId);
    if (!task || typeof task.result?.shouldReply !== "boolean") {
      throw new Error("Task has no completed reply decision");
    }
    if (expectedShouldReply !== task.result.shouldReply && !String(note).trim()) {
      throw new Error("note is required when human and AI decisions differ");
    }
    const fingerprint = decisionSha256(task.result);
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO decision_review_events(
          id, tenant_id, task_id, expected_should_reply, reviewer,
          note_ciphertext, decision_sha256, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          this.tenantId,
          taskId,
          expectedShouldReply,
          String(reviewer).trim(),
          this.cipher.encrypt(String(note)),
          fingerprint,
          now,
        ],
      );
      await client.query(
      `INSERT INTO decision_reviews(
        id, tenant_id, task_id, expected_should_reply, reviewer,
        note_ciphertext, decision_sha256, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
      ON CONFLICT (tenant_id, task_id) DO UPDATE SET
        expected_should_reply = EXCLUDED.expected_should_reply,
        reviewer = EXCLUDED.reviewer,
        note_ciphertext = EXCLUDED.note_ciphertext,
        decision_sha256 = EXCLUDED.decision_sha256,
        updated_at = EXCLUDED.updated_at`,
      [
        randomUUID(),
        this.tenantId,
        taskId,
        expectedShouldReply,
        String(reviewer).trim(),
        this.cipher.encrypt(String(note)),
        fingerprint,
        now,
      ],
      );
    });
    return (await this.listDecisionReviews({ taskId, limit: 1 }))[0];
  }

  async listDecisionReviews({ taskId, limit = 1_000 } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new Error("Decision review limit must be between 1 and 10000");
    }
    const result = taskId
      ? await this.pool.query(
          `SELECT r.*, t.result_ciphertext, t.payload_ciphertext,
                  t.sender_user_id_ciphertext, t.conversation_id_ciphertext
           FROM decision_reviews r
           JOIN tasks t ON t.tenant_id = r.tenant_id AND t.id = r.task_id
           WHERE r.tenant_id = $1 AND r.task_id = $2
           ORDER BY r.updated_at DESC LIMIT $3`,
          [this.tenantId, taskId, limit],
        )
      : await this.pool.query(
          `SELECT r.*, t.result_ciphertext, t.payload_ciphertext,
                  t.sender_user_id_ciphertext, t.conversation_id_ciphertext
           FROM decision_reviews r
           JOIN tasks t ON t.tenant_id = r.tenant_id AND t.id = r.task_id
           WHERE r.tenant_id = $1 ORDER BY r.updated_at DESC LIMIT $2`,
          [this.tenantId, limit],
        );
    return result.rows.map((row) => {
      const taskResult = row.result_ciphertext
        ? JSON.parse(this.cipher.decrypt(row.result_ciphertext))
        : {};
      const taskPayload = row.payload_ciphertext
        ? JSON.parse(this.cipher.decrypt(row.payload_ciphertext))
        : {};
      return {
        id: row.id,
        taskId: row.task_id,
        expectedShouldReply: row.expected_should_reply,
        predictedShouldReply: taskResult.shouldReply,
        riskLevel: taskResult.riskLevel ?? null,
        decisionSource: taskResult.decisionSource ?? null,
        decisionKind: taskResult.decisionKind ?? null,
        decisionSha256: row.decision_sha256 ?? null,
        decisionCurrent:
          row.decision_sha256 != null &&
          row.decision_sha256 === decisionSha256(taskResult),
        senderName: taskPayload.senderName ?? null,
        senderUserId: this.cipher.decrypt(row.sender_user_id_ciphertext),
        conversationId: this.cipher.decrypt(row.conversation_id_ciphertext),
        reviewer: row.reviewer,
        note: this.cipher.decrypt(row.note_ciphertext),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  async isPaused() {
    const result = await this.pool.query(
      "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'paused'",
      [this.tenantId],
    );
    return result.rows[0]?.value === "true";
  }

  async setPaused(paused, now = new Date()) {
    await this.pool.query(
      `
      INSERT INTO settings(tenant_id, key, value, updated_at)
      VALUES ($1,'paused',$2,$3)
      ON CONFLICT (tenant_id, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `,
      [this.tenantId, String(Boolean(paused)), now],
    );
  }

  async recordHeartbeat(component, now = new Date()) {
    await this.pool.query(
      `
      INSERT INTO settings(tenant_id, key, value, updated_at)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `,
      [this.tenantId, `heartbeat:${component}`, now.toISOString(), now],
    );
  }

  async recordAvailabilitySample(
    ready,
    {
      now = new Date(),
      intervalMs = 60_000,
      retentionMs = 45 * 24 * 60 * 60 * 1000,
    } = {},
  ) {
    const bucket = availabilityBucket(now, intervalMs);
    const cutoff = new Date(new Date(now).getTime() - retentionMs);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO availability_samples(tenant_id, bucket_at, ready)
         VALUES ($1, $2, $3)
         ON CONFLICT(tenant_id, bucket_at) DO UPDATE SET
           ready = availability_samples.ready AND EXCLUDED.ready`,
        [this.tenantId, bucket, Boolean(ready)],
      );
      await client.query(
        "DELETE FROM availability_samples WHERE tenant_id = $1 AND bucket_at < $2",
        [this.tenantId, cutoff],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return bucket.toISOString();
  }

  async availabilityMetrics({
    now = new Date(),
    intervalMs = 60_000,
    windowMs = 30 * 24 * 60 * 60 * 1000,
  } = {}) {
    const end = availabilityBucket(now, intervalMs);
    const start = new Date(end.getTime() - windowMs);
    const result = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE bucket_at >= $2 AND bucket_at < $3) AS "sampleCount",
         COUNT(*) FILTER (WHERE bucket_at >= $2 AND bucket_at < $3 AND ready) AS "readyCount",
         MIN(bucket_at) AS "firstTrackedAt",
         MAX(bucket_at) FILTER (WHERE bucket_at >= $2 AND bucket_at < $3) AS "lastSampleAt"
       FROM availability_samples WHERE tenant_id = $1`,
      [this.tenantId, start, end],
    );
    const aggregate = result.rows[0];
    return buildAvailabilityMetrics({
      sampleCount: Number(aggregate.sampleCount),
      readyCount: Number(aggregate.readyCount),
      firstTrackedAt: aggregate.firstTrackedAt,
      lastSampleAt: aggregate.lastSampleAt,
    }, { now, intervalMs, windowMs });
  }

  async operationalMetrics({
    since,
    now = new Date(),
    limit = 10_000,
    availabilityIntervalMs = 60_000,
    availabilityWindowMs = 30 * 24 * 60 * 60 * 1000,
  } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100_000) {
      throw new Error("Operational metrics limit must be between 1 and 100000");
    }
    const [
      messageResult,
      taskResult,
      effectResult,
      messageCoverage,
      availability,
      memoryConflicts,
    ] = await Promise.all([
      this.pool.query(
        `SELECT occurred_at AS "occurredAt", ingested_at AS "ingestedAt"
         FROM messages WHERE tenant_id = $1
           AND ingested_at >= $2 AND ingested_at <= $3
         ORDER BY ingested_at DESC LIMIT $4`,
        [this.tenantId, since, now, limit + 1],
      ),
      this.pool.query(
        `SELECT * FROM tasks WHERE tenant_id = $1
           AND created_at >= $2 AND created_at <= $3
         ORDER BY created_at DESC LIMIT $4`,
        [this.tenantId, since, now, limit + 1],
      ),
      this.pool.query(
        `SELECT task_id AS "taskId", capability, status,
                receipt_ciphertext IS NOT NULL AS "receiptPresent"
         FROM side_effects WHERE tenant_id = $1
           AND created_at >= $2 AND created_at <= $3
         ORDER BY created_at DESC LIMIT $4`,
        [this.tenantId, since, now, limit + 1],
      ),
      this.getCheckpoint(messageCoverageCheckpointKey),
      this.availabilityMetrics({
        now,
        intervalMs: availabilityIntervalMs,
        windowMs: availabilityWindowMs,
      }),
      this.memoryConflictMetrics(),
    ]);
    return buildOperationalMetrics({
      messages: messageResult.rows.slice(0, limit),
      tasks: taskResult.rows.slice(0, limit)
        .map((row) => taskFromRow(row, this.cipher)),
      sideEffects: effectResult.rows.slice(0, limit),
      messageCoverage,
      availability,
      memoryConflicts,
      truncated: {
        messages: messageResult.rows.length > limit,
        tasks: taskResult.rows.length > limit,
        sideEffects: effectResult.rows.length > limit,
      },
    }, { since, now });
  }

  async health() {
    const [
      database,
      taskCounts,
      workPlanCounts,
      expiredExecutionLeases,
      pendingMessages,
      checkpoints,
      heartbeats,
    ] =
      await Promise.all([
        checkPostgres(this.pool),
        this.pool.query(
          `
          SELECT status, COUNT(*)::bigint AS count
          FROM tasks
          WHERE tenant_id = $1
          GROUP BY status
        `,
          [this.tenantId],
        ),
        this.pool.query(
          `SELECT status, COUNT(*)::bigint AS count FROM work_plans
           WHERE tenant_id = $1 GROUP BY status`,
          [this.tenantId],
        ),
        this.pool.query(
          `SELECT COUNT(*)::bigint AS count FROM work_plans
           WHERE tenant_id = $1 AND status IN ('executing','verifying')
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= now()`,
          [this.tenantId],
        ),
        this.pool.query(
          `
          SELECT COUNT(*)::bigint AS count
          FROM messages
          WHERE tenant_id = $1 AND status = 'pending'
        `,
          [this.tenantId],
        ),
        this.pool.query(
          `
          SELECT key, value, updated_at
          FROM checkpoints
          WHERE tenant_id = $1
          ORDER BY updated_at DESC
        `,
          [this.tenantId],
        ),
        this.pool.query(
          `
          SELECT key, value, updated_at
          FROM settings
          WHERE tenant_id = $1 AND key LIKE 'heartbeat:%'
        `,
          [this.tenantId],
        ),
      ]);
    return {
      database,
      paused: await this.isPaused(),
      tasks: Object.fromEntries(
        taskCounts.rows.map((row) => [row.status, Number(row.count)]),
      ),
      workPlans: Object.fromEntries(
        workPlanCounts.rows.map((row) => [row.status, Number(row.count)]),
      ),
      expiredExecutionLeases: Number(expiredExecutionLeases.rows[0].count),
      pendingMessages: Number(pendingMessages.rows[0].count),
      checkpoints: checkpoints.rows,
      heartbeats: Object.fromEntries(
        heartbeats.rows.map((row) => [
          row.key.slice("heartbeat:".length),
          row.value,
        ]),
      ),
    };
  }

  async purgeCompleted({ before }) {
    const timestamp = before instanceof Date ? before : new Date(before);
    return this.transaction(async (client) => {
      const selected = await client.query(
        `
        SELECT id
        FROM tasks
        WHERE tenant_id = $1
          AND status IN (
            'completed', 'no_reply', 'rejected', 'cancelled_manual',
            'cancelled_operator', 'expired'
          )
          AND updated_at < $2
        FOR UPDATE SKIP LOCKED
      `,
        [this.tenantId, timestamp],
      );
      const ids = selected.rows.map((row) => row.id);
      if (ids.length === 0) return 0;
      await client.query(
        "DELETE FROM messages WHERE tenant_id = $1 AND task_id = ANY($2::text[])",
        [this.tenantId, ids],
      );
      await client.query(
        "DELETE FROM tasks WHERE tenant_id = $1 AND id = ANY($2::text[])",
        [this.tenantId, ids],
      );
      return ids.length;
    });
  }
}
