import { createHash, randomUUID } from "node:crypto";
import { DataCipher } from "./crypto.mjs";
import {
  capabilityBudgetSnapshot,
  normalizeCapabilityBudget,
} from "./capability-budget.mjs";
import { checkPostgres, createPostgresPool } from "./postgres.mjs";
import {
  shouldFlushMessageBundleEarly,
  splitMessageBursts,
} from "./message-bundling.mjs";
import { memoryIsUsable, validateMemoryProposal } from "./memory-policy.mjs";
import { validateAutomaticMemoryProposal } from "./memory-candidate.mjs";
import { memoryDeletionConfirmation } from "./memory-portability.mjs";
import { validateSourceAccessChange } from "./memory-source-access.mjs";
import { analyzeMemoryConflicts, memoryFactKey } from "./memory-conflicts.mjs";
import { buildPlanResultDraft } from "./plan-result-notification.mjs";
import { buildOperationalMetrics } from "./operational-metrics.mjs";
import { messageCoverageCheckpointKey } from "./message-reconciliation.mjs";
import {
  decisionSha256,
  draftSha256,
  parseDraftAssessment,
  parseDraftSha256,
} from "./decision-quality.mjs";
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
import {
  assertMigrationStatus,
  inspectMigrationStatus,
} from "./migration-status.mjs";
import {
  buildPrivacyErasurePreview,
  erasableTaskStatuses,
  erasableWorkPlanStatuses,
  jsonContainsAny,
  privacySelectorFingerprint,
  validatePrivacySelector,
} from "./privacy-erasure.mjs";

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

function memoryFactLockKey({ tenantId, type, subjectKey, projectId, factKey }) {
  return [tenantId, type, subjectKey, projectId ?? "", factKey ?? ""].join("\n");
}

function workPlanFromRow(row, cipher) {
  if (!row) return null;
  return {
    ...row,
    requester_id: cipher.decrypt(row.requester_ciphertext),
    objective: cipher.decrypt(row.objective_ciphertext),
    plan: JSON.parse(cipher.decrypt(row.plan_ciphertext)),
    capability_budget: row.capability_budget_ciphertext
      ? JSON.parse(cipher.decrypt(row.capability_budget_ciphertext))
      : null,
    requester_ciphertext: undefined,
    objective_ciphertext: undefined,
    plan_ciphertext: undefined,
    capability_budget_ciphertext: undefined,
  };
}

export class PostgresStore {
  constructor(config, { pool, readOnly = false } = {}) {
    this.config = config;
    this.tenantId = config.tenantId;
    this.pool = pool ?? createPostgresPool(config, { readOnly });
    this.ownsPool = !pool;
    this.readOnly = readOnly;
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
    assertMigrationStatus(await inspectMigrationStatus(this.pool));
    if (!this.readOnly) {
      await this.pool.query(
        `
        INSERT INTO settings(tenant_id, key, value)
        VALUES ($1, 'encryption_sentinel', $2)
        ON CONFLICT (tenant_id, key) DO NOTHING
      `,
        [this.tenantId, this.cipher.encrypt("ai-employee-v1")],
      );
    }
    const sentinel = await this.pool.query(
      "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'encryption_sentinel'",
      [this.tenantId],
    );
    if (!sentinel.rows[0]?.value) {
      throw new Error(
        this.readOnly
          ? "Database encryption sentinel is missing; initialize it through a controlled service start"
          : "Database encryption sentinel was not created",
      );
    }
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
        const erased = await client.query(
          `SELECT 1 FROM privacy_erased_messages
           WHERE tenant_id = $1 AND message_key = $2`,
          [this.tenantId, this.cipher.fingerprint(`message:${message.id}`)],
        );
        if (erased.rowCount > 0) continue;
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

  async nextPendingBundleAt({
    quietWindowMs,
    bundleMaxWaitMs = 8_000,
    now = new Date(),
  }) {
    if (
      !Number.isFinite(quietWindowMs) ||
      quietWindowMs <= 0 ||
      !Number.isFinite(bundleMaxWaitMs) ||
      bundleMaxWaitMs > 8_000 ||
      bundleMaxWaitMs < quietWindowMs
    ) {
      throw new Error("Pending bundle timing configuration is invalid");
    }
    const current = toDate(now);
    const result = await this.pool.query(
      `SELECT MIN(CASE
         WHEN continuation_blocked AND deadline_at <= $4
           THEN $4 + interval '1 second'
         ELSE deadline_at
       END) AS next_at
       FROM (
         SELECT MIN(ingested_at) AS first_ingested,
                MAX(ingested_at) AS last_ingested,
                LEAST(
                  MIN(ingested_at) + $2 * interval '1 millisecond',
                  MAX(ingested_at) + $3 * interval '1 millisecond'
                ) AS deadline_at,
                EXISTS(
                  SELECT 1 FROM tasks
                  WHERE tasks.tenant_id = $1
                    AND tasks.status = 'continuation_pending'
                    AND tasks.conversation_key = messages.conversation_key
                    AND tasks.sender_key = messages.sender_key
                ) AS continuation_blocked
         FROM messages
         WHERE tenant_id = $1 AND status = 'pending'
         GROUP BY conversation_key, sender_key
       ) pending_groups`,
      [this.tenantId, bundleMaxWaitMs, quietWindowMs, current],
    );
    return result.rows[0]?.next_at ?? null;
  }

  async createReadyTasks({
    quietWindowMs,
    bundleMaxWaitMs = 8_000,
    bundleGapMs = 120_000,
    maxMessagesPerTask = 20,
    maxAttempts = 5,
    waitingInformationTtlMs = 86_400_000,
    now = new Date(),
  }) {
    if (!Number.isFinite(waitingInformationTtlMs) || waitingInformationTtlMs <= 0) {
      throw new Error("Waiting information TTL must be positive");
    }
    if (
      !Number.isFinite(bundleMaxWaitMs) ||
      bundleMaxWaitMs <= 0 ||
      bundleMaxWaitMs > 8_000 ||
      bundleMaxWaitMs < quietWindowMs
    ) {
      throw new Error("Bundle maximum wait must be between the quiet window and 8000ms");
    }
    const cutoff = new Date(now.getTime() - quietWindowMs);
    const maximumWaitCutoff = new Date(now.getTime() - bundleMaxWaitMs);
    const waitingCutoff = new Date(now.getTime() - waitingInformationTtlMs);
    return this.transaction(async (client) => {
      await client.query(
        `UPDATE tasks
         SET status = 'expired', updated_at = $2
         WHERE tenant_id = $1
           AND status = 'waiting_information'
           AND COALESCE(waiting_information_at, updated_at) < $3`,
        [this.tenantId, now, waitingCutoff],
      );
      const groups = await client.query(
        `
        SELECT conversation_key, sender_key,
               MIN(ingested_at) AS first_ingested,
               MAX(ingested_at) AS last_ingested
        FROM messages
        WHERE tenant_id = $1 AND status = 'pending'
        GROUP BY conversation_key, sender_key
        ORDER BY LEAST(
          MIN(ingested_at) + $2 * interval '1 millisecond',
          MAX(ingested_at) + $3 * interval '1 millisecond'
        )
        LIMIT 500
      `,
        [this.tenantId, bundleMaxWaitMs, quietWindowMs],
      );
      const created = [];
      for (const group of groups.rows) {
        const timingReady = group.last_ingested <= cutoff ||
          group.first_ingested <= maximumWaitCutoff;
        if (!timingReady) {
          const latest = await client.query(
            `SELECT content_ciphertext
             FROM messages
             WHERE tenant_id = $1
               AND conversation_key = $2
               AND sender_key = $3
               AND status = 'pending'
             ORDER BY ingested_at DESC, occurred_at DESC,
                      platform_message_id DESC
             LIMIT 1`,
            [this.tenantId, group.conversation_key, group.sender_key],
          );
          if (latest.rowCount === 0) continue;
          const content = this.cipher.decrypt(
            latest.rows[0].content_ciphertext,
          );
          if (!shouldFlushMessageBundleEarly([{ content }])) continue;
        }
        const continuationInFlight = await client.query(
          `SELECT id
           FROM tasks
           WHERE tenant_id = $1
             AND conversation_key = $2
             AND sender_key = $3
             AND status = 'continuation_pending'
           LIMIT 1
           FOR UPDATE`,
          [this.tenantId, group.conversation_key, group.sender_key],
        );
        if (continuationInFlight.rowCount > 0) continue;
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
        const waitingRows = await client.query(
          `SELECT id, payload_ciphertext, result_ciphertext,
                  COALESCE(waiting_information_at, updated_at) AS waiting_at
           FROM tasks
           WHERE tenant_id = $1
             AND conversation_key = $2
             AND sender_key = $3
             AND status = 'waiting_information'
             AND COALESCE(waiting_information_at, updated_at) >= $4
           ORDER BY COALESCE(waiting_information_at, updated_at) DESC, id DESC
           LIMIT 2
           FOR UPDATE`,
          [
            this.tenantId,
            group.conversation_key,
            group.sender_key,
            waitingCutoff,
          ],
        );
        let waitingTask = waitingRows.rowCount === 1
          ? {
              id: waitingRows.rows[0].id,
              payload: JSON.parse(
                this.cipher.decrypt(waitingRows.rows[0].payload_ciphertext),
              ),
              result: waitingRows.rows[0].result_ciphertext
                ? JSON.parse(
                    this.cipher.decrypt(waitingRows.rows[0].result_ciphertext),
                  )
                : null,
              waitingAt: waitingRows.rows[0].waiting_at,
            }
          : null;
        const bursts = splitMessageBursts(selected.rows, {
          gapMs: bundleGapMs,
          maxMessages: maxMessagesPerTask,
          boundaryAt: waitingTask?.waitingAt ?? null,
        });
        for (const rows of bursts) {
          const continuationTask = waitingTask &&
            rows[0].occurred_at.getTime() > waitingTask.waitingAt.getTime()
            ? waitingTask
            : null;
          const reservesWaitingTask = Boolean(continuationTask);
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
            waitingTask: continuationTask
              ? {
                  originalRequest: String(
                    continuationTask.payload?.content ?? "",
                  ).slice(0, 4_000),
                  clarificationQuestion: String(
                    continuationTask.result?.reply ?? "",
                  ).slice(0, 1_000),
                  waitingAt: continuationTask.waitingAt.toISOString(),
                }
              : null,
          };
          const inserted = await client.query(
            `
            INSERT INTO tasks(
              id, tenant_id, kind, status, sender_key,
              sender_user_id_ciphertext, conversation_key,
              conversation_id_ciphertext, payload_ciphertext,
              max_attempts, continuation_of_task_id,
              available_at, created_at, updated_at
            ) VALUES (
              $1,$2,'reply','queued',$3,$4,$5,$6,$7,$8,$9,$10,$10,$10
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
              continuationTask?.id ?? null,
              now,
            ],
          );
          if (inserted.rowCount === 0) continue;
          if (continuationTask) {
            const reserved = await client.query(
              `UPDATE tasks
               SET status = 'continuation_pending', updated_at = $3
               WHERE tenant_id = $1 AND id = $2
                 AND status = 'waiting_information'`,
              [this.tenantId, continuationTask.id, now],
            );
            if (reserved.rowCount !== 1) {
              throw new Error("Waiting task could not be reserved");
            }
            waitingTask = null;
          }
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
          if (reservesWaitingTask) break;
        }
      }
      return created;
    });
  }

  async claimTask({ leaseMs = 120_000, now = new Date() } = {}) {
    return this.transaction(async (client) => {
      const exhausted = await client.query(
        `
        UPDATE tasks
        SET status = 'dead', lease_until = NULL,
            last_error_ciphertext = COALESCE(last_error_ciphertext, $3),
            updated_at = $2
        WHERE tenant_id = $1
          AND status = 'processing'
          AND lease_until <= $2
          AND attempts >= max_attempts
        RETURNING continuation_of_task_id
      `,
        [
          this.tenantId,
          now,
          this.cipher.encrypt("processing lease exhausted"),
        ],
      );
      for (const task of exhausted.rows) {
        if (!task.continuation_of_task_id) continue;
        await client.query(
          `UPDATE tasks
           SET status = 'waiting_information', updated_at = $3
           WHERE tenant_id = $1 AND id = $2
             AND status = 'continuation_pending'`,
          [this.tenantId, task.continuation_of_task_id, now],
        );
      }
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
      const selected = await client.query(
        `SELECT continuation_of_task_id, sender_key, conversation_key
         FROM tasks
         WHERE id = $1 AND tenant_id = $2 AND status = 'processing'
         FOR UPDATE`,
        [taskId, this.tenantId],
      );
      if (selected.rowCount !== 1) {
        throw new Error(`Task is not processing: ${taskId}`);
      }
      const continuationId = selected.rows[0].continuation_of_task_id;
      if (draft.relatedToWaitingTask && !continuationId) {
        throw new Error("Draft cannot continue a missing waiting task");
      }
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
      if (continuationId) {
        const hasPendingFollowup = draft.relatedToWaitingTask
          ? await client.query(
              `SELECT 1 FROM messages
               WHERE tenant_id = $1 AND status = 'pending'
                 AND sender_key = $2 AND conversation_key = $3
               LIMIT 1`,
              [
                this.tenantId,
                selected.rows[0].sender_key,
                selected.rows[0].conversation_key,
              ],
            )
          : null;
        const parent = await client.query(
          `UPDATE tasks
           SET status = $3, updated_at = $4
           WHERE tenant_id = $1 AND id = $2
             AND status = 'continuation_pending'`,
          [
            this.tenantId,
            continuationId,
            draft.decisionKind === "manual_reply"
              ? "cancelled_manual"
              : draft.relatedToWaitingTask
                ? hasPendingFollowup?.rowCount > 0
                  ? "waiting_information"
                  : "continued"
                : "waiting_information",
            now,
          ],
        );
        if (parent.rowCount !== 1) {
          throw new Error("Waiting task continuation is no longer available");
        }
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
        SELECT status, attempts, max_attempts, continuation_of_task_id
        FROM tasks
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `,
        [taskId, this.tenantId],
      );
      if (selected.rowCount === 0) return null;
      const task = selected.rows[0];
      if (task.status !== "processing") return task.status;
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
        WHERE id = $1 AND tenant_id = $2 AND status = 'processing'
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
      if (dead && task.continuation_of_task_id) {
        await client.query(
          `UPDATE tasks
           SET status = 'waiting_information', updated_at = $3
           WHERE tenant_id = $1 AND id = $2
             AND status = 'continuation_pending'`,
          [this.tenantId, task.continuation_of_task_id, now],
        );
      }
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
      const task = await client.query(
        `SELECT status FROM tasks
         WHERE id = $1 AND tenant_id = $2
         FOR UPDATE`,
        [taskId, this.tenantId],
      );
      if (task.rows[0]?.status !== "sending") {
        throw new Error("Task is not sending");
      }
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
      const task = await client.query(
        `SELECT result_ciphertext
         FROM tasks
         WHERE id = $1 AND tenant_id = $2 AND status = 'sending'
         FOR UPDATE`,
        [taskId, this.tenantId],
      );
      if (task.rowCount !== 1) throw new Error("Task is not sending");
      const draft = task.rows[0].result_ciphertext
        ? JSON.parse(this.cipher.decrypt(task.rows[0].result_ciphertext))
        : null;
      const taskStatus = draft?.needsInformation
        ? "waiting_information"
        : "completed";
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
        SET status = $3, waiting_information_at = $4,
            lease_until = NULL, updated_at = $5
        WHERE id = $1 AND tenant_id = $2
      `,
        [
          taskId,
          this.tenantId,
          taskStatus,
          taskStatus === "waiting_information" ? now : null,
          now,
        ],
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

  async _cancelWorkPlansForSourceTask(
    client,
    taskId,
    now = new Date(),
    actor = "system:manual-reply",
  ) {
    const candidates = await client.query(
      `SELECT id, plan_ciphertext FROM work_plans
       WHERE tenant_id = $1 AND privacy_erased_at IS NULL
         AND status IN ('ready','awaiting_approval','approved','executing','verifying')`,
      [this.tenantId],
    );
    const ids = candidates.rows.flatMap((row) => {
      try {
        const plan = JSON.parse(this.cipher.decrypt(row.plan_ciphertext));
        return plan?.sourceTaskId === taskId ? [row.id] : [];
      } catch {
        return [];
      }
    });
    if (ids.length === 0) return { cancelled: 0, cancellationRequested: 0 };
    const selected = await client.query(
      `SELECT id, status FROM work_plans
       WHERE tenant_id = $1 AND id = ANY($2::text[])
       FOR UPDATE`,
      [this.tenantId, ids],
    );
    let cancelled = 0;
    let cancellationRequested = 0;
    for (const plan of selected.rows) {
      if (["ready", "awaiting_approval", "approved"].includes(plan.status)) {
        await client.query(
          `UPDATE work_plan_steps SET status = 'cancelled',
           completed_at = $3, updated_at = $3
           WHERE tenant_id = $1 AND work_plan_id = $2 AND status = 'pending'`,
          [this.tenantId, plan.id, now],
        );
        await client.query(
          `UPDATE work_plans SET status = 'cancelled',
           cancel_requested_at = $3, cancel_requested_by = $4, updated_at = $3
           WHERE tenant_id = $1 AND id = $2
             AND status IN ('ready','awaiting_approval','approved')`,
          [this.tenantId, plan.id, now, actor],
        );
        cancelled += 1;
      } else if (["executing", "verifying"].includes(plan.status)) {
        await client.query(
          `UPDATE work_plans
           SET cancel_requested_at = COALESCE(cancel_requested_at, $3),
               cancel_requested_by = COALESCE(cancel_requested_by, $4),
               updated_at = $3
           WHERE tenant_id = $1 AND id = $2
             AND status IN ('executing','verifying')`,
          [this.tenantId, plan.id, now, actor],
        );
        cancellationRequested += 1;
      } else {
        continue;
      }
      await this.audit(client, {
        taskId,
        eventType: "work_plan.manual_takeover",
        actor,
        details: {
          workPlanId: plan.id,
          result: ["executing", "verifying"].includes(plan.status)
            ? "cancellation_requested"
            : "cancelled",
        },
      });
    }
    return { cancelled, cancellationRequested };
  }

  async cancelForManualReply(taskId, now = new Date()) {
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT continuation_of_task_id, result_ciphertext
         FROM tasks WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [taskId, this.tenantId],
      );
      const result = await client.query(
        `
        UPDATE tasks
        SET status = 'cancelled_manual', lease_until = NULL, updated_at = $3
        WHERE id = $1 AND tenant_id = $2 AND status = 'sending'
      `,
        [taskId, this.tenantId, now],
      );
      const task = selected.rows[0];
      if (result.rowCount === 1 && task?.continuation_of_task_id) {
        const draft = task.result_ciphertext
          ? JSON.parse(this.cipher.decrypt(task.result_ciphertext))
          : null;
        if (draft?.relatedToWaitingTask) {
          await client.query(
            `UPDATE tasks SET status = 'cancelled_manual', updated_at = $3
             WHERE id = $1 AND tenant_id = $2 AND status = 'continued'`,
            [task.continuation_of_task_id, this.tenantId, now],
          );
        } else {
          await client.query(
            `UPDATE tasks SET status = 'cancelled_manual', updated_at = $3
             WHERE id = $1 AND tenant_id = $2 AND status = 'continuation_pending'`,
            [task.continuation_of_task_id, this.tenantId, now],
          );
        }
      }
      await this._cancelWorkPlansForSourceTask(client, taskId, now);
      await this.audit(client, {
        taskId,
        eventType: "send.cancelled_manual",
      });
    });
  }

  async cancelDraftForManualReply(taskId, now = new Date()) {
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT continuation_of_task_id, result_ciphertext
         FROM tasks WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [taskId, this.tenantId],
      );
      const result = await client.query(
        `
        UPDATE tasks
        SET status = 'cancelled_manual', updated_at = $3
        WHERE id = $1 AND tenant_id = $2
          AND status IN (
            'processing', 'awaiting_approval', 'waiting_information'
          )
      `,
        [taskId, this.tenantId, now],
      );
      const task = selected.rows[0];
      if (result.rowCount === 1 && task?.continuation_of_task_id) {
        const draft = task.result_ciphertext
          ? JSON.parse(this.cipher.decrypt(task.result_ciphertext))
          : null;
        if (draft?.relatedToWaitingTask) {
          await client.query(
            `UPDATE tasks SET status = 'cancelled_manual', updated_at = $3
             WHERE id = $1 AND tenant_id = $2 AND status = 'continued'`,
            [task.continuation_of_task_id, this.tenantId, now],
          );
        } else {
          await client.query(
            `UPDATE tasks SET status = 'cancelled_manual', updated_at = $3
             WHERE id = $1 AND tenant_id = $2 AND status = 'continuation_pending'`,
            [task.continuation_of_task_id, this.tenantId, now],
          );
        }
      }
      await this._cancelWorkPlansForSourceTask(client, taskId, now);
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
      "SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2 AND privacy_erased_at IS NULL",
      [taskId, this.tenantId],
    );
    return taskFromRow(result.rows[0], this.cipher);
  }

  async listAutomatedSendEvidence({
    since = new Date(0),
    until = new Date(),
  } = {}) {
    const result = await this.pool.query(
      `SELECT t.id AS task_id, t.conversation_id_ciphertext,
              t.result_ciphertext, e.idempotency_key,
              e.status AS effect_status, e.receipt_ciphertext,
              e.created_at, e.updated_at
       FROM side_effects e
       JOIN tasks t
         ON t.tenant_id = e.tenant_id AND t.id = e.task_id
       WHERE e.tenant_id = $1
         AND e.capability = 'send_message'
         AND e.status IN ('started', 'completed', 'unknown')
         AND e.created_at >= $2 AND e.created_at <= $3
         AND t.privacy_erased_at IS NULL
       ORDER BY e.created_at`,
      [this.tenantId, since, until],
    );
    return result.rows.flatMap((row) => {
      const draft = row.result_ciphertext
        ? JSON.parse(this.cipher.decrypt(row.result_ciphertext))
        : null;
      const content = String(draft?.reply ?? "").trim();
      if (!content) return [];
      return [{
        taskId: row.task_id,
        idempotencyKey: row.idempotency_key,
        conversationId: this.cipher.decrypt(row.conversation_id_ciphertext),
        content,
        status: row.effect_status,
        startedAt: row.created_at,
        updatedAt: row.updated_at,
        receipt: row.receipt_ciphertext
          ? JSON.parse(this.cipher.decrypt(row.receipt_ciphertext))
          : null,
      }];
    });
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
        WHERE tenant_id = $1 AND privacy_erased_at IS NULL AND status = $2
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
          WHERE tenant_id = $1 AND privacy_erased_at IS NULL AND status = $2
          ORDER BY created_at DESC, id DESC
          LIMIT $3 OFFSET $4
        `,
          [this.tenantId, status, limit, offset],
        );
    } else {
      result = await this.pool.query(
          `
          SELECT * FROM tasks
          WHERE tenant_id = $1 AND privacy_erased_at IS NULL
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
      const selected = await client.query(
        `SELECT status, continuation_of_task_id
         FROM tasks
         WHERE id = $1 AND tenant_id = $2
         FOR UPDATE`,
        [taskId, this.tenantId],
      );
      const task = selected.rows[0];
      if (task?.status !== "dead") {
        throw new Error("Only dead tasks can be retried");
      }
      if (task.continuation_of_task_id) {
        const parent = await client.query(
          `UPDATE tasks
           SET status = 'continuation_pending', updated_at = $3
           WHERE id = $1 AND tenant_id = $2
             AND status = 'waiting_information'`,
          [task.continuation_of_task_id, this.tenantId, now],
        );
        if (parent.rowCount !== 1) {
          throw new Error("Waiting task continuation cannot be retried");
        }
      }
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
        SELECT status, result_ciphertext
        FROM tasks
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `,
        [taskId, this.tenantId],
      );
      if (selected.rows[0]?.status !== "send_unknown") {
        throw new Error("Task is not in send_unknown state");
      }
      const sideEffect = await client.query(
        `SELECT created_at FROM side_effects
         WHERE task_id = $1 AND tenant_id = $2
           AND capability = 'send_message'
         FOR UPDATE`,
        [taskId, this.tenantId],
      );
      if (sideEffect.rowCount !== 1) {
        throw new Error("Unknown send side effect ledger is missing");
      }
      if (resolution === "sent") {
        const draft = selected.rows[0].result_ciphertext
          ? JSON.parse(this.cipher.decrypt(selected.rows[0].result_ciphertext))
          : null;
        const taskStatus = draft?.needsInformation
          ? "waiting_information"
          : "completed";
        const completedEffect = await client.query(
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
        if (completedEffect.rowCount !== 1) {
          throw new Error("Unknown send side effect ledger is missing");
        }
        await client.query(
          `
          UPDATE tasks
          SET status = $3, waiting_information_at = $4,
              last_error_ciphertext = NULL, updated_at = $5
          WHERE id = $1 AND tenant_id = $2
        `,
          [
            taskId,
            this.tenantId,
            taskStatus,
            taskStatus === "waiting_information"
              ? sideEffect.rows[0].created_at
              : null,
            now,
          ],
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
          source_version, source_access_status, source_access_reason,
          scope_ciphertext, confidence, status,
          sensitivity, expires_at, created_by, updated_by, supersedes_id,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'proposed',$15,$16,$17,$17,$18,$19,$19)
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
          memory.sourceType === "gbrain" ? "unverified" : "not_required",
          memory.sourceType === "gbrain" ? "awaiting_source_check" : null,
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

  async proposeMemoryCandidate(input, now = new Date()) {
    validateAutomaticMemoryProposal(input, now);
    const memory = validateMemoryProposal(input);
    const subjectKey = this.cipher.fingerprint(memory.subject);
    const factKey = memory.scope.factKey;
    const statement = memory.statement.trim();
    return this.transaction(async (client) => {
      const sourceTask = await client.query(
        `SELECT payload_ciphertext FROM tasks
         WHERE tenant_id = $1 AND id = $2
         FOR SHARE`,
        [this.tenantId, memory.sourceVersion],
      );
      const sourcePayload = sourceTask.rows[0]?.payload_ciphertext
        ? JSON.parse(this.cipher.decrypt(sourceTask.rows[0].payload_ciphertext))
        : null;
      if (!(sourcePayload?.messages ?? []).some(
        (message) => String(message.id) === memory.sourceId,
      )) {
        throw new Error("Automatic memory source does not belong to its source task");
      }
      const lockKey = memoryFactLockKey({
        tenantId: this.tenantId,
        type: memory.type,
        subjectKey,
        projectId: memory.projectId,
        factKey,
      });
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
      const selected = await client.query(
        `SELECT * FROM memory_items
         WHERE tenant_id = $1 AND deleted_at IS NULL
           AND status IN ('proposed', 'confirmed')
           AND type = $2 AND subject_key = $3
           AND project_id IS NOT DISTINCT FROM $4
           AND (expires_at IS NULL OR expires_at > $5)
         ORDER BY updated_at DESC
         FOR UPDATE`,
        [this.tenantId, memory.type, subjectKey, memory.projectId, now],
      );
      const comparable = selected.rows.map((row) => memoryFromRow(row, this.cipher))
        .filter((item) => memoryFactKey(item) === factKey);
      const duplicate = comparable.find(
        (item) => item.statement.trim() === statement,
      );
      if (duplicate) {
        return { created: false, id: duplicate.id, reason: "duplicate" };
      }
      const id = `memory_${randomUUID()}`;
      await client.query(
        `INSERT INTO memory_items(
          id, tenant_id, type, subject_key, subject_ciphertext, project_id,
          statement_ciphertext, source_type, source_id_ciphertext,
          source_version, source_access_status, source_access_reason,
          scope_ciphertext, confidence, status,
          sensitivity, expires_at, created_by, updated_by, supersedes_id,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'not_required',NULL,$11,$12,'proposed',$13,$14,$15,$15,NULL,$16,$16)`,
        [
          id,
          this.tenantId,
          memory.type,
          subjectKey,
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
          now,
        ],
      );
      await this.audit(client, {
        eventType: "memory.proposed",
        actor: memory.createdBy,
        details: {
          memoryId: id,
          type: memory.type,
          projectId: memory.projectId,
          automatic: true,
        },
      });
      return {
        created: true,
        id,
        status: "proposed",
        conflictCount: comparable.filter(
          (item) => item.status === "confirmed" && item.statement.trim() !== statement,
        ).length,
      };
    });
  }

  async confirmMemory(id, actor, now = new Date(), { supersedesId = null } = {}) {
    return this.transaction(async (client) => {
      const identityResult = await client.query(
        `SELECT * FROM memory_items
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id],
      );
      if (identityResult.rowCount === 0) throw new Error(`Memory not found: ${id}`);
      const identity = identityResult.rows[0];
      const identityFactKey = memoryFactKey(memoryFromRow(identity, this.cipher));
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        memoryFactLockKey({
          tenantId: this.tenantId,
          type: identity.type,
          subjectKey: identity.subject_key,
          projectId: identity.project_id,
          factKey: identityFactKey,
        }),
      ]);
      const selected = await client.query(
        `SELECT * FROM memory_items
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [this.tenantId, id],
      );
      if (selected.rowCount === 0) throw new Error(`Memory not found: ${id}`);
      const memory = selected.rows[0];
      if (memory.status !== "proposed") throw new Error("Memory is not proposed");
      if (
        memory.source_type === "gbrain" &&
        (memory.source_access_status !== "verified" ||
          !memory.source_access_expires_at ||
          new Date(memory.source_access_expires_at) <= now)
      ) {
        throw new Error("gbrain memory source access must be verified before confirmation");
      }
      if (memory.source_type === "dingtalk_message") {
        const sourceTask = await client.query(
          `SELECT payload_ciphertext FROM tasks
           WHERE tenant_id = $1 AND id = $2
             AND privacy_erased_at IS NULL
           FOR SHARE`,
          [this.tenantId, memory.source_version],
        );
        const sourcePayload = sourceTask.rows[0]?.payload_ciphertext
          ? JSON.parse(this.cipher.decrypt(sourceTask.rows[0].payload_ciphertext))
          : null;
        const sourceId = this.cipher.decrypt(memory.source_id_ciphertext);
        if (!(sourcePayload?.messages ?? []).some(
          (message) => String(message.id) === sourceId,
        )) {
          throw new Error("DingTalk memory source must remain verifiable before confirmation");
        }
      }
      const candidate = memoryFromRow(memory, this.cipher);
      const factKey = memoryFactKey(candidate);
      if (factKey !== identityFactKey) {
        throw new Error("Memory fact identity changed during confirmation");
      }
      const activeResult = await client.query(
        `SELECT * FROM memory_items
         WHERE tenant_id = $1 AND status = 'confirmed' AND deleted_at IS NULL
           AND type = $2 AND subject_key = $3
           AND project_id IS NOT DISTINCT FROM $4
           AND (expires_at IS NULL OR expires_at > $5)
           AND (source_type <> 'gbrain' OR (
             source_access_status = 'verified' AND source_access_expires_at > $5
           ))
         ORDER BY updated_at DESC FOR UPDATE`,
        [this.tenantId, memory.type, memory.subject_key, memory.project_id, now],
      );
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

  async setMemorySourceAccess(id, change, actor) {
    const normalized = validateSourceAccessChange(change);
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT source_access_status, source_access_reason, source_version
         FROM memory_items
         WHERE tenant_id = $1 AND id = $2 AND source_type = 'gbrain'
           AND deleted_at IS NULL
         FOR UPDATE`,
        [this.tenantId, id],
      );
      if (selected.rowCount !== 1) {
        throw new Error("Memory source access cannot be updated");
      }
      const result = await client.query(
        `UPDATE memory_items SET
           source_access_status = $3, source_access_reason = $4,
           source_access_checked_at = $5, source_access_expires_at = $6,
           source_version = COALESCE(source_version, $7)
         WHERE tenant_id = $1 AND id = $2 AND source_type = 'gbrain'
           AND deleted_at IS NULL`,
        [
          this.tenantId,
          id,
          normalized.status,
          normalized.reason,
          normalized.checkedAt,
          normalized.expiresAt,
          normalized.sourceVersion,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error("Memory source access cannot be updated");
      }
      const previous = selected.rows[0];
      const resultingSourceVersion =
        previous.source_version ?? normalized.sourceVersion;
      const statusChanged =
        previous.source_access_status !== normalized.status ||
        previous.source_access_reason !== normalized.reason ||
        previous.source_version !== resultingSourceVersion;
      if (statusChanged) {
        await this.audit(client, {
          eventType: "memory.source_access_checked",
          actor,
          details: {
            memoryId: id,
            status: normalized.status,
            reason: normalized.reason,
            expiresAt: normalized.expiresAt?.toISOString() ?? null,
          },
        });
      }
      return normalized.status;
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
           source_access_status = 'revoked', source_access_reason = 'deleted',
           source_access_checked_at = $8, source_access_expires_at = NULL,
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

  async getMemory(id) {
    const result = await this.pool.query(
      `SELECT * FROM memory_items
       WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [this.tenantId, id],
    );
    return result.rows[0] ? memoryFromRow(result.rows[0], this.cipher) : null;
  }

  async listMemories({
    type,
    subject,
    projectId,
    status,
    statuses,
    sensitivity,
    sourceType,
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
    if (statuses) {
      if (!Array.isArray(statuses) || statuses.length === 0) {
        throw new Error("Memory statuses must be a non-empty array");
      }
      add("status = ANY(", statuses);
      clauses[clauses.length - 1] += ")";
    }
    if (sensitivity) add("sensitivity =", sensitivity);
    if (sourceType) add("source_type =", sourceType);
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
    const capabilityBudgetJson = capabilityBudgetSnapshot(
      assessment.capabilityBudget,
    );
    const capabilityBudget = JSON.parse(capabilityBudgetJson);
    if (
      capabilityBudget.projectId !== assessment.plan.projectId ||
      capabilityBudget.authorizationHash !== assessment.authorizationHash
    ) {
      throw new Error("Work plan capability budget is not bound to its authorization");
    }
    const id = `plan_${assessment.planHash.slice(0, 24)}`;
    await this.transaction(async (client) => {
      if (assessment.plan.sourceTaskId) {
        const sourceTask = await client.query(
          `SELECT status, privacy_erased_at FROM tasks
           WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
          [this.tenantId, assessment.plan.sourceTaskId],
        );
        const source = sourceTask.rows[0];
        if (
          !source ||
          source.privacy_erased_at ||
          ["cancelled_manual", "cancelled_operator"].includes(source.status)
        ) {
          throw new Error("Work plan source task is no longer actionable");
        }
      }
      const erased = await client.query(
        `SELECT privacy_erased_at FROM work_plans
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id],
      );
      if (erased.rows[0]?.privacy_erased_at) {
        throw new Error("Erased work plan content cannot be recreated unchanged");
      }
      const inserted = await client.query(
        `INSERT INTO work_plans(
          id, tenant_id, project_id, requester_key, requester_ciphertext,
          objective_ciphertext, plan_ciphertext, plan_hash,
          authorization_hash, capability_budget_ciphertext, max_level,
          policy_decision, status, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
        ON CONFLICT (tenant_id, plan_hash) DO NOTHING
        RETURNING id`,
        [
          id,
          this.tenantId,
          assessment.plan.projectId,
          this.cipher.fingerprint(assessment.plan.requesterId),
          this.cipher.encrypt(assessment.plan.requesterId),
          this.cipher.encrypt(assessment.plan.objective),
          this.cipher.encrypt(JSON.stringify(assessment.plan)),
          assessment.planHash,
          assessment.authorizationHash,
          this.cipher.encrypt(capabilityBudgetJson),
          assessment.maxLevel,
          assessment.decision,
          assessment.decision === "ALLOW" ? "ready" : "awaiting_approval",
          now,
        ],
      );
      const legacyResult = inserted.rowCount === 0
        ? await client.query(
            `SELECT status, approval_version, cancel_requested_by,
                    authorization_hash, capability_budget_ciphertext,
                    privacy_erased_at
             FROM work_plans
             WHERE tenant_id = $1 AND id = $2 AND plan_hash = $3
             FOR UPDATE`,
            [this.tenantId, id, assessment.planHash],
          )
        : null;
      const legacyPlan = legacyResult?.rows[0];
      if (legacyPlan?.privacy_erased_at) {
        throw new Error("Erased work plan content cannot be recreated unchanged");
      }
      const restoringLegacyPlan = legacyPlan?.status === "cancelled" &&
        legacyPlan.cancel_requested_by === "system:migration-018" &&
        (!legacyPlan.authorization_hash || !legacyPlan.capability_budget_ciphertext);
      if (restoringLegacyPlan) {
        const latestApproval = await client.query(
          `SELECT MAX(approval_version) AS approval_version
           FROM work_plan_approvals
           WHERE tenant_id = $1 AND work_plan_id = $2`,
          [this.tenantId, id],
        );
        const approvalVersion = Math.max(
          Number(legacyPlan.approval_version ?? 1),
          Number(latestApproval.rows[0]?.approval_version ?? 0),
        ) + 1;
        const restored = await client.query(
          `UPDATE work_plans
           SET project_id = $4, requester_key = $5, requester_ciphertext = $6,
               objective_ciphertext = $7, plan_ciphertext = $8,
               authorization_hash = $9, capability_budget_ciphertext = $10,
               max_level = $11, policy_decision = $12, status = $13,
               approval_version = $14, execution_owner = NULL,
               lease_expires_at = NULL, cancel_requested_at = NULL,
               cancel_requested_by = NULL, updated_at = $15
           WHERE tenant_id = $1 AND id = $2 AND plan_hash = $3
             AND status = 'cancelled'
             AND cancel_requested_by = 'system:migration-018'
             AND privacy_erased_at IS NULL
             AND (authorization_hash IS NULL OR capability_budget_ciphertext IS NULL)
           RETURNING id`,
          [
            this.tenantId,
            id,
            assessment.planHash,
            assessment.plan.projectId,
            this.cipher.fingerprint(assessment.plan.requesterId),
            this.cipher.encrypt(assessment.plan.requesterId),
            this.cipher.encrypt(assessment.plan.objective),
            this.cipher.encrypt(JSON.stringify(assessment.plan)),
            assessment.authorizationHash,
            this.cipher.encrypt(capabilityBudgetJson),
            assessment.maxLevel,
            assessment.decision,
            assessment.decision === "ALLOW" ? "ready" : "awaiting_approval",
            approvalVersion,
            now,
          ],
        );
        if (restored.rowCount !== 1) {
          throw new Error("Legacy work plan could not be registered safely");
        }
      }
      for (const [position, step] of assessment.plan.steps.entries()) {
        await client.query(
          `INSERT INTO work_plan_steps(
            tenant_id, work_plan_id, step_id, position,
            capability, status, updated_at
          ) VALUES ($1,$2,$3,$4,$5,'pending',$6)
          ON CONFLICT (tenant_id, work_plan_id, step_id) DO ${
            restoringLegacyPlan
              ? `UPDATE SET position = EXCLUDED.position,
                   capability = EXCLUDED.capability, status = 'pending',
                   evidence_ciphertext = NULL, error_ciphertext = NULL,
                   started_at = NULL, completed_at = NULL,
                   updated_at = EXCLUDED.updated_at`
              : "NOTHING"
          }`,
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
      if (assessment.plan.sourceTaskId) {
        const sourceTask = await client.query(
          `SELECT status, privacy_erased_at FROM tasks
           WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
          [this.tenantId, assessment.plan.sourceTaskId],
        );
        const source = sourceTask.rows[0];
        if (
          !source ||
          source.privacy_erased_at ||
          ["cancelled_manual", "cancelled_operator"].includes(source.status)
        ) {
          throw new Error("Work plan source task is no longer actionable");
        }
      }
      const capabilityBudgetJson = capabilityBudgetSnapshot(
        assessment.capabilityBudget,
      );
      const capabilityBudget = JSON.parse(capabilityBudgetJson);
      if (
        capabilityBudget.projectId !== assessment.plan.projectId ||
        capabilityBudget.authorizationHash !== assessment.authorizationHash
      ) {
        throw new Error("Work plan capability budget is not bound to its authorization");
      }
      const duplicate = await client.query(
        `SELECT 1 FROM work_plans
         WHERE tenant_id = $1 AND (id = $2 OR plan_hash = $3)`,
        [this.tenantId, revisedId, assessment.planHash],
      );
      if (duplicate.rowCount > 0) throw new Error("Revised work plan already exists");
      await client.query(
        `INSERT INTO work_plans(
          id, tenant_id, project_id, requester_key, requester_ciphertext,
          objective_ciphertext, plan_ciphertext, plan_hash,
          authorization_hash, capability_budget_ciphertext, max_level,
          policy_decision, status, supersedes_work_plan_id, revision_actor,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'awaiting_approval',$13,$14,$15,$15)`,
        [
          revisedId,
          this.tenantId,
          assessment.plan.projectId,
          this.cipher.fingerprint(assessment.plan.requesterId),
          this.cipher.encrypt(assessment.plan.requesterId),
          this.cipher.encrypt(assessment.plan.objective),
          this.cipher.encrypt(JSON.stringify(assessment.plan)),
          assessment.planHash,
          assessment.authorizationHash,
          this.cipher.encrypt(capabilityBudgetJson),
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
      "SELECT * FROM work_plans WHERE tenant_id = $1 AND id = $2 AND privacy_erased_at IS NULL",
      [this.tenantId, id],
    );
    return workPlanFromRow(result.rows[0], this.cipher);
  }

  async listWorkPlans({ status, limit = 100 } = {}) {
    const result = status
      ? await this.pool.query(
          `SELECT * FROM work_plans
           WHERE tenant_id = $1 AND privacy_erased_at IS NULL AND status = $2
           ORDER BY updated_at DESC, id DESC LIMIT $3`,
          [this.tenantId, status, limit],
        )
      : await this.pool.query(
          `SELECT * FROM work_plans
           WHERE tenant_id = $1 AND privacy_erased_at IS NULL
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
    { owner = null, leaseExpiresAt = null, capabilityBudget = null } = {},
  ) {
    if (owner && !(leaseExpiresAt instanceof Date && leaseExpiresAt > now)) {
      throw new Error("Execution lease expiry must be in the future");
    }
    return this.transaction(async (client) => {
      const peeked = await client.query(
        `SELECT * FROM work_plans
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id],
      );
      const peekedPlan = peeked.rows[0];
      if (!peekedPlan) throw new Error("Work plan not found");
      let sourceTaskId;
      try {
        sourceTaskId = JSON.parse(
          this.cipher.decrypt(peekedPlan.plan_ciphertext),
        )?.sourceTaskId;
      } catch {
        throw new Error("Stored work plan is invalid");
      }
      if (sourceTaskId) {
        const sourceTask = await client.query(
          `SELECT status, privacy_erased_at FROM tasks
           WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
          [this.tenantId, sourceTaskId],
        );
        const source = sourceTask.rows[0];
        if (
          !source ||
          source.privacy_erased_at ||
          ["cancelled_manual", "cancelled_operator"].includes(source.status)
        ) {
          throw new Error("Work plan source task is no longer actionable");
        }
      }
      const selected = await client.query(
        `SELECT * FROM work_plans
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [this.tenantId, id],
      );
      const plan = selected.rows[0];
      if (!plan) throw new Error("Work plan not found");
      if (plan.privacy_erased_at) {
        throw new Error("Work plan source task is no longer actionable");
      }
      let lockedSourceTaskId;
      try {
        lockedSourceTaskId = JSON.parse(
          this.cipher.decrypt(plan.plan_ciphertext),
        )?.sourceTaskId;
      } catch {
        throw new Error("Stored work plan is invalid");
      }
      if (lockedSourceTaskId !== sourceTaskId) {
        throw new Error("Work plan changed while acquiring authorization");
      }
      if (!plan.authorization_hash || !plan.capability_budget_ciphertext) {
        throw new Error("Work plan capability budget is not bound; register a new plan");
      }
      let budget;
      try {
        budget = normalizeCapabilityBudget(JSON.parse(
          this.cipher.decrypt(plan.capability_budget_ciphertext),
        ));
      } catch {
        throw new Error("Stored work plan capability budget is invalid");
      }
      if (
        budget.projectId !== plan.project_id ||
        budget.authorizationHash !== plan.authorization_hash
      ) {
        throw new Error("Stored capability budget does not match work plan authorization");
      }
      if (
        capabilityBudget != null &&
        capabilityBudgetSnapshot(capabilityBudget) !== capabilityBudgetSnapshot(budget)
      ) {
        throw new Error("Capability budget does not match the registered work plan");
      }
      const consumeBudget = async () => {
        const projectKey = this.cipher.fingerprint(budget.projectId);
        for (const entry of budget.entries) {
          await client.query(
            `INSERT INTO capability_budget_usage(
               tenant_id, project_key, project_id_ciphertext,
               authorization_hash, capability, limit_count,
               used_count, created_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$7)
             ON CONFLICT (tenant_id, project_key, authorization_hash, capability)
             DO NOTHING`,
            [
              this.tenantId,
              projectKey,
              this.cipher.encrypt(budget.projectId),
              budget.authorizationHash,
              entry.capability,
              entry.limit,
              now,
            ],
          );
          const consumed = await client.query(
             `UPDATE capability_budget_usage
             SET used_count = used_count + $5, updated_at = $6
             WHERE tenant_id = $1 AND project_key = $2
               AND authorization_hash = $3 AND capability = $4
               AND limit_count = $7
               AND used_count + $5 <= limit_count
             RETURNING used_count`,
            [
              this.tenantId,
              projectKey,
              budget.authorizationHash,
              entry.capability,
              entry.amount,
              now,
              entry.limit,
            ],
          );
          if (consumed.rowCount !== 1) {
            throw new Error(`Capability authorization budget exhausted: ${entry.capability}`);
          }
        }
      };
      if (plan.status === "ready" && plan.policy_decision === "ALLOW") {
        await consumeBudget();
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
      await consumeBudget();
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

  async listCapabilityBudgetUsage({ projectId = null } = {}) {
    const parameters = [this.tenantId];
    const projectClause = projectId ? "AND project_key = $2" : "";
    if (projectId) parameters.push(this.cipher.fingerprint(projectId));
    const result = await this.pool.query(
      `SELECT project_key, project_id_ciphertext, authorization_hash, capability,
              limit_count, used_count, updated_at
       FROM capability_budget_usage
       WHERE tenant_id = $1 ${projectClause}
       ORDER BY project_key, capability`,
      parameters,
    );
    return result.rows.map((row) => ({
      projectId: this.cipher.decrypt(row.project_id_ciphertext) || null,
      authorizationHash: row.authorization_hash,
      capability: row.capability,
      limit: row.limit_count,
      used: row.used_count,
      remaining: row.limit_count - row.used_count,
      updatedAt: row.updated_at,
    }));
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
             AND t.privacy_erased_at IS NULL
           ORDER BY r.updated_at DESC LIMIT $3`,
          [this.tenantId, taskId, limit],
        )
      : await this.pool.query(
          `SELECT r.*, t.result_ciphertext, t.payload_ciphertext,
                  t.sender_user_id_ciphertext, t.conversation_id_ciphertext
           FROM decision_reviews r
           JOIN tasks t ON t.tenant_id = r.tenant_id AND t.id = r.task_id
           WHERE r.tenant_id = $1 AND t.privacy_erased_at IS NULL
           ORDER BY r.updated_at DESC LIMIT $2`,
          [this.tenantId, limit],
        );
    return result.rows.map((row) => {
      const taskResult = row.result_ciphertext
        ? JSON.parse(this.cipher.decrypt(row.result_ciphertext))
        : {};
      const taskPayload = row.payload_ciphertext
        ? JSON.parse(this.cipher.decrypt(row.payload_ciphertext))
        : {};
      const note = this.cipher.decrypt(row.note_ciphertext);
      const currentDraft = String(taskResult.reply ?? "");
      const currentDraftSha256 = draftSha256(currentDraft);
      const reviewedDraftSha256 = parseDraftSha256(note);
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
        draftPresent: currentDraft.trim().length > 0,
        currentDraftSha256,
        draftCurrent: parseDraftAssessment(note) == null
          ? null
          : reviewedDraftSha256 != null &&
            reviewedDraftSha256 === currentDraftSha256,
        senderName: taskPayload.senderName ?? null,
        senderUserId: this.cipher.decrypt(row.sender_user_id_ciphertext),
        conversationId: this.cipher.decrypt(row.conversation_id_ciphertext),
        reviewer: row.reviewer,
        note,
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
        `SELECT * FROM tasks WHERE tenant_id = $1 AND privacy_erased_at IS NULL
           AND created_at >= $2 AND created_at <= $3
         ORDER BY created_at DESC LIMIT $4`,
        [this.tenantId, since, now, limit + 1],
      ),
      this.pool.query(
        `SELECT e.task_id AS "taskId", e.capability, e.status,
                e.receipt_ciphertext IS NOT NULL AS "receiptPresent"
         FROM side_effects e
         JOIN tasks t ON t.tenant_id = e.tenant_id AND t.id = e.task_id
         WHERE e.tenant_id = $1 AND t.privacy_erased_at IS NULL
           AND e.created_at >= $2 AND e.created_at <= $3
         ORDER BY e.created_at DESC LIMIT $4`,
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
          WHERE tenant_id = $1 AND privacy_erased_at IS NULL
          GROUP BY status
        `,
          [this.tenantId],
        ),
        this.pool.query(
          `SELECT status, COUNT(*)::bigint AS count FROM work_plans
           WHERE tenant_id = $1 AND privacy_erased_at IS NULL GROUP BY status`,
          [this.tenantId],
        ),
        this.pool.query(
          `SELECT COUNT(*)::bigint AS count FROM work_plans
           WHERE tenant_id = $1 AND privacy_erased_at IS NULL
             AND status IN ('executing','verifying')
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

  async _privacyErasureCandidates(input, now = new Date(), client = this.pool, { lock = false } = {}) {
    const selector = validatePrivacySelector(input, now);
    const suffix = lock ? " FOR UPDATE" : "";
    const taskStatus = new Set(erasableTaskStatuses);
    const planStatus = new Set(erasableWorkPlanStatuses);
    let planResult;
    if (selector.type === "person") {
      planResult = await client.query(
        `SELECT * FROM work_plans WHERE tenant_id = $1 AND privacy_erased_at IS NULL
         AND requester_key = $2${suffix}`,
        [this.tenantId, this.cipher.fingerprint(selector.value)],
      );
    } else if (selector.type === "project") {
      planResult = await client.query(
        `SELECT * FROM work_plans WHERE tenant_id = $1 AND privacy_erased_at IS NULL
         AND project_id = $2${suffix}`,
        [this.tenantId, selector.value],
      );
    } else {
      planResult = await client.query(
        `SELECT * FROM work_plans WHERE tenant_id = $1 AND privacy_erased_at IS NULL
         AND updated_at < $2${suffix}`,
        [this.tenantId, selector.value],
      );
    }
    const planRows = planResult.rows;
    const sourceTaskIds = new Set();
    for (const row of planRows) {
      try {
        const sourceTaskId = JSON.parse(this.cipher.decrypt(row.plan_ciphertext))?.sourceTaskId;
        if (sourceTaskId) sourceTaskIds.add(sourceTaskId);
      } catch {
        // A malformed stored plan remains in scope but cannot expand task scope.
      }
    }
    let taskResult;
    if (selector.type === "person") {
      taskResult = await client.query(
        `SELECT * FROM tasks WHERE tenant_id = $1 AND privacy_erased_at IS NULL
         AND sender_key = $2${suffix}`,
        [this.tenantId, this.cipher.fingerprint(selector.value)],
      );
    } else if (selector.type === "project") {
      taskResult = sourceTaskIds.size === 0
        ? { rows: [] }
        : await client.query(
          `SELECT * FROM tasks WHERE tenant_id = $1 AND privacy_erased_at IS NULL
           AND id = ANY($2::text[])${suffix}`,
          [this.tenantId, [...sourceTaskIds]],
        );
    } else {
      taskResult = await client.query(
        `SELECT * FROM tasks WHERE tenant_id = $1 AND privacy_erased_at IS NULL
         AND updated_at < $2${suffix}`,
        [this.tenantId, selector.value],
      );
    }
    const taskRows = taskResult.rows;
    let memoryResult;
    if (selector.type === "person") {
      memoryResult = await client.query(
        `SELECT * FROM memory_items WHERE tenant_id = $1 AND deleted_at IS NULL
         AND subject_key = $2${suffix}`,
        [this.tenantId, this.cipher.fingerprint(selector.value)],
      );
    } else if (selector.type === "project") {
      memoryResult = await client.query(
        `SELECT * FROM memory_items WHERE tenant_id = $1 AND deleted_at IS NULL
         AND project_id = $2${suffix}`,
        [this.tenantId, selector.value],
      );
    } else {
      memoryResult = await client.query(
        `SELECT * FROM memory_items WHERE tenant_id = $1 AND deleted_at IS NULL
         AND updated_at < $2${suffix}`,
        [this.tenantId, selector.value],
      );
    }
    let memoryRows = memoryResult.rows;
    if (taskRows.length > 0) {
      const sourceMemories = await client.query(
        `SELECT * FROM memory_items
         WHERE tenant_id = $1 AND deleted_at IS NULL
           AND source_type = 'dingtalk_message'
           AND source_version = ANY($2::text[])${suffix}`,
        [this.tenantId, taskRows.map((row) => row.id)],
      );
      memoryRows = [...new Map(
        [...memoryRows, ...sourceMemories.rows].map((row) => [row.id, row]),
      ).values()];
    }
    let capabilityBudgetResult;
    if (selector.type === "project") {
      capabilityBudgetResult = await client.query(
        `SELECT * FROM capability_budget_usage
         WHERE tenant_id = $1 AND project_key = $2${suffix}`,
        [this.tenantId, this.cipher.fingerprint(selector.value)],
      );
    } else {
      capabilityBudgetResult = { rows: [] };
    }
    const capabilityBudgetRows = capabilityBudgetResult.rows;
    const taskById = new Map(taskRows.map((row) => [row.id, row]));
    const eligibleTaskIds = new Set(
      taskRows.filter((row) => taskStatus.has(row.status)).map((row) => row.id),
    );
    let messageResult;
    if (selector.type === "person") {
      messageResult = await client.query(
        `SELECT * FROM messages WHERE tenant_id = $1 AND sender_key = $2${suffix}`,
        [this.tenantId, this.cipher.fingerprint(selector.value)],
      );
    } else if (selector.type === "project") {
      messageResult = sourceTaskIds.size === 0
        ? { rows: [] }
        : await client.query(
          `SELECT * FROM messages WHERE tenant_id = $1 AND task_id = ANY($2::text[])${suffix}`,
          [this.tenantId, [...sourceTaskIds]],
        );
    } else {
      messageResult = await client.query(
        `SELECT * FROM messages WHERE tenant_id = $1 AND ingested_at < $2${suffix}`,
        [this.tenantId, selector.value],
      );
    }
    const eligibleMessages = [];
    const blockedMessages = [];
    for (const row of messageResult.rows) {
      const linkedTask = row.task_id ? taskById.get(row.task_id) : null;
      if (
        (linkedTask && eligibleTaskIds.has(linkedTask.id)) ||
        (!row.task_id && row.status !== "pending")
      ) eligibleMessages.push(row);
      else blockedMessages.push(row);
    }
    const checkpointResult = await client.query(
      `SELECT key, value, updated_at FROM checkpoints
       WHERE tenant_id = $1 AND left(key, 13) = 'scoped_pause:'${suffix}`,
      [this.tenantId],
    );
    const blockedCheckpoints = [];
    const checkpointRewrites = [];
    const targetCheckpointKey = selector.type === "person"
      ? scopedPauseKey(this.cipher, "contact", selector.value)
      : selector.type === "project"
        ? scopedPauseKey(this.cipher, "project", selector.value)
        : null;
    for (const row of checkpointResult.rows) {
      if (
        row.key === targetCheckpointKey ||
        (selector.type === "time" && row.updated_at < selector.value)
      ) blockedCheckpoints.push(row);
      if (selector.type === "person") {
        try {
          const value = JSON.parse(this.cipher.decrypt(row.value));
          if (value.actor === selector.value && row.key !== targetCheckpointKey) {
            checkpointRewrites.push({ key: row.key, value: { ...value, actor: "deleted", reason: "" } });
          }
        } catch {
          // Invalid operational checkpoints are left unchanged and do not widen erasure.
        }
      }
    }
    const identityReferences = [];
    if (selector.type === "person") {
      const referenceQueries = [
        ["tasks.approved_by", "SELECT id FROM tasks WHERE tenant_id = $1 AND approved_by = $2"],
        ["approvals.actor", "SELECT id FROM approvals WHERE tenant_id = $1 AND actor = $2"],
        ["reviews.reviewer", "SELECT id FROM decision_reviews WHERE tenant_id = $1 AND reviewer = $2"],
        ["review_events.reviewer", "SELECT id FROM decision_review_events WHERE tenant_id = $1 AND reviewer = $2"],
        ["plans.revision_actor", "SELECT id FROM work_plans WHERE tenant_id = $1 AND revision_actor = $2"],
        ["plans.cancel_requested_by", "SELECT id FROM work_plans WHERE tenant_id = $1 AND cancel_requested_by = $2"],
        ["plan_approvals.actor", "SELECT id FROM work_plan_approvals WHERE tenant_id = $1 AND actor = $2"],
        ["memories.created_by", "SELECT id FROM memory_items WHERE tenant_id = $1 AND created_by = $2"],
        ["memories.updated_by", "SELECT id FROM memory_items WHERE tenant_id = $1 AND updated_by = $2"],
      ];
      for (const [kind, sql] of referenceQueries) {
        const result = await client.query(`${sql}${suffix}`, [this.tenantId, selector.value]);
        for (const row of result.rows) identityReferences.push(`${kind}:${row.id}`);
      }
      for (const row of checkpointRewrites) identityReferences.push(`checkpoint.actor:${row.key}`);
    }
    const allAudit = await client.query(
      `SELECT id, task_id, event_type, actor, details_ciphertext, occurred_at
       FROM audit_events WHERE tenant_id = $1${
        selector.type === "time" ? " AND occurred_at < $2" : ""
      }${suffix}`,
      selector.type === "time" ? [this.tenantId, selector.value] : [this.tenantId],
    );
    const relatedValues = new Set([
      ...taskRows.map((row) => row.id),
      ...planRows.map((row) => row.id),
      ...memoryRows.map((row) => row.id),
    ]);
    if (selector.type !== "time") relatedValues.add(selector.value);
    const auditRows = selector.type === "time"
      ? allAudit.rows
      : allAudit.rows.filter((row) => {
        if (row.task_id && relatedValues.has(row.task_id)) return true;
        if (selector.type === "person" && row.actor === selector.value) return true;
        try {
          return jsonContainsAny(JSON.parse(this.cipher.decrypt(row.details_ciphertext)), relatedValues);
        } catch {
          return false;
        }
      });
    const token = (row, id = row.id) =>
      `${id}:${row.status ?? row.event_type ?? ""}:${
        row.updated_at?.toISOString?.() ?? row.ingested_at?.toISOString?.() ??
        row.occurred_at?.toISOString?.() ?? row.updated_at ?? ""
      }`;
    const eligible = {
      tasks: taskRows.filter((row) => taskStatus.has(row.status)).map(token),
      messages: eligibleMessages.map((row) => token(row, row.platform_message_id)),
      workPlans: planRows.filter((row) => planStatus.has(row.status)).map(token),
      memories: memoryRows.map(token),
      capabilityBudgets: capabilityBudgetRows.map((row) => token(
        row,
        `${row.project_key}:${row.authorization_hash}:${row.capability}`,
      )),
      auditEvents: auditRows.map(token),
      identityReferences: [...new Set(identityReferences)],
    };
    const blocked = {
      tasks: taskRows.filter((row) => !taskStatus.has(row.status)).map(token),
      messages: blockedMessages.map((row) => token(row, row.platform_message_id)),
      workPlans: planRows.filter((row) => !planStatus.has(row.status)).map(token),
      scopedPauses: blockedCheckpoints.map((row) => `${row.key}:${row.updated_at.toISOString()}`),
    };
    return {
      selector,
      preview: buildPrivacyErasurePreview({
        selector,
        selectorFingerprint: privacySelectorFingerprint(this.cipher, selector),
        eligible,
        blocked,
      }),
      ids: {
        tasks: taskRows.filter((row) => taskStatus.has(row.status)).map((row) => row.id),
        messages: eligibleMessages.map((row) => row.platform_message_id),
        workPlans: planRows.filter((row) => planStatus.has(row.status)).map((row) => row.id),
        memories: memoryRows.map((row) => row.id),
        capabilityBudgets: capabilityBudgetRows.map((row) => ({
          projectKey: row.project_key,
          authorizationHash: row.authorization_hash,
          capability: row.capability,
        })),
        auditEvents: auditRows.map((row) => row.id),
        checkpointRewrites,
      },
    };
  }

  async previewPrivacyErasure(selector, now = new Date()) {
    return (await this._privacyErasureCandidates(selector, now)).preview;
  }

  async erasePrivacyData(selector, confirmation, actor, now = new Date()) {
    if (!String(actor ?? "").trim()) throw new Error("Privacy erasure actor is required");
    return this.transaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await client.query(
        `LOCK TABLE tasks, messages, privacy_erased_messages, approvals, side_effects, decision_reviews,
           decision_review_events, work_plans, work_plan_approvals,
           work_plan_steps, capability_budget_usage, memory_items, checkpoints, audit_events
         IN SHARE ROW EXCLUSIVE MODE`,
      );
      const candidates = await this._privacyErasureCandidates(selector, now, client, { lock: true });
      if (candidates.preview.blockedTotal > 0) {
        throw new Error("Privacy erasure is blocked by active or unresolved records");
      }
      if (!candidates.preview.confirmation) {
        throw new Error("Privacy erasure has no eligible data");
      }
      if (confirmation !== candidates.preview.confirmation) {
        throw new Error("Privacy erasure confirmation does not match the current snapshot");
      }
      const encryptedEmpty = this.cipher.encrypt("");
      const encryptedObject = this.cipher.encrypt("{}");
      const taskIds = candidates.ids.tasks;
      if (taskIds.length > 0) {
        await client.query(
          `UPDATE tasks SET sender_key = $3, sender_user_id_ciphertext = $4,
             conversation_key = $5, conversation_id_ciphertext = $4,
             payload_ciphertext = $6, result_ciphertext = NULL,
             last_error_ciphertext = NULL,
             approved_by = CASE WHEN approved_by IS NULL THEN NULL ELSE 'deleted' END,
             privacy_erased_at = $2, updated_at = $2
           WHERE tenant_id = $1 AND id = ANY($7::text[]) AND privacy_erased_at IS NULL`,
          [
            this.tenantId,
            now,
            this.cipher.fingerprint(`deleted-tasks:${randomUUID()}`),
            encryptedEmpty,
            this.cipher.fingerprint(`deleted-conversations:${randomUUID()}`),
            encryptedObject,
            taskIds,
          ],
        );
        await client.query(
          `UPDATE approvals SET actor = 'deleted', reason_ciphertext = $3
           WHERE tenant_id = $1 AND task_id = ANY($2::text[])`,
          [this.tenantId, taskIds, encryptedEmpty],
        );
        await client.query(
          `UPDATE side_effects SET receipt_ciphertext = NULL, last_error_ciphertext = NULL
           WHERE tenant_id = $1 AND task_id = ANY($2::text[])`,
          [this.tenantId, taskIds],
        );
        await client.query(
          `DELETE FROM decision_review_events
           WHERE tenant_id = $1 AND task_id = ANY($2::text[])`,
          [this.tenantId, taskIds],
        );
        await client.query(
          `DELETE FROM decision_reviews
           WHERE tenant_id = $1 AND task_id = ANY($2::text[])`,
          [this.tenantId, taskIds],
        );
      }
      if (candidates.ids.messages.length > 0) {
        for (const id of candidates.ids.messages) {
          await client.query(
            `INSERT INTO privacy_erased_messages(tenant_id, message_key, erased_at)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [this.tenantId, this.cipher.fingerprint(`message:${id}`), now],
          );
        }
        await client.query(
          `DELETE FROM messages WHERE tenant_id = $1
           AND platform_message_id = ANY($2::text[])`,
          [this.tenantId, candidates.ids.messages],
        );
      }
      for (const id of candidates.ids.workPlans) {
        await client.query(
          `UPDATE work_plans SET project_id = 'deleted', requester_key = $3,
             requester_ciphertext = $4, objective_ciphertext = $4,
             plan_ciphertext = $5, plan_hash = $6, authorization_hash = NULL,
             capability_budget_ciphertext = $5, execution_owner = NULL,
             lease_expires_at = NULL, cancel_requested_at = NULL,
             cancel_requested_by = NULL,
             revision_actor = CASE WHEN revision_actor IS NULL THEN NULL ELSE 'deleted' END,
             privacy_erased_at = $7, updated_at = $7
           WHERE tenant_id = $1 AND id = $2 AND privacy_erased_at IS NULL`,
          [
            this.tenantId,
            id,
            this.cipher.fingerprint(`deleted:${id}:${randomUUID()}`),
            encryptedEmpty,
            encryptedObject,
            this.cipher.fingerprint(`deleted-plan:${id}:${randomUUID()}`),
            now,
          ],
        );
        await client.query(
          `UPDATE work_plan_approvals SET actor = 'deleted', reason_ciphertext = $3
           WHERE tenant_id = $1 AND work_plan_id = $2`,
          [this.tenantId, id, encryptedEmpty],
        );
        await client.query(
          `UPDATE work_plan_steps SET evidence_ciphertext = NULL, error_ciphertext = NULL
           WHERE tenant_id = $1 AND work_plan_id = $2`,
          [this.tenantId, id],
        );
      }
      for (const budget of candidates.ids.capabilityBudgets) {
        await client.query(
          `UPDATE capability_budget_usage
           SET project_id_ciphertext = $2, updated_at = $3
           WHERE tenant_id = $1 AND project_key = $4
             AND authorization_hash = $5 AND capability = $6`,
          [
            this.tenantId,
            encryptedEmpty,
            now,
            budget.projectKey,
            budget.authorizationHash,
            budget.capability,
          ],
        );
      }
      for (const id of candidates.ids.memories) {
        await client.query(
          `UPDATE memory_items SET supersedes_id = NULL
           WHERE tenant_id = $1 AND supersedes_id = $2`,
          [this.tenantId, id],
        );
        await client.query(
          `UPDATE memory_items SET subject_key = $3, subject_ciphertext = $4,
             project_id = NULL, statement_ciphertext = $4, source_type = 'deleted',
             source_id_ciphertext = $4, source_version = NULL,
             source_access_status = 'revoked', source_access_reason = 'deleted',
             source_access_checked_at = $5, source_access_expires_at = NULL,
             scope_ciphertext = $6, confidence = 0, status = 'revoked',
             sensitivity = 'internal', valid_from = NULL, expires_at = NULL,
             created_by = 'deleted', updated_by = 'deleted', supersedes_id = NULL,
             created_at = $5, updated_at = $5, deleted_at = $5
           WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [
            this.tenantId,
            id,
            this.cipher.fingerprint(`deleted:${id}:${randomUUID()}`),
            encryptedEmpty,
            now,
            encryptedObject,
          ],
        );
      }
      for (const checkpoint of candidates.ids.checkpointRewrites) {
        await client.query(
          `UPDATE checkpoints SET value = $3, updated_at = $4
           WHERE tenant_id = $1 AND key = $2`,
          [this.tenantId, checkpoint.key, this.cipher.encrypt(JSON.stringify(checkpoint.value)), now],
        );
      }
      if (candidates.ids.auditEvents.length > 0) {
        await client.query(
          `UPDATE audit_events SET details_ciphertext = $3, actor = 'deleted'
           WHERE tenant_id = $1 AND id = ANY($2::bigint[])`,
          [
            this.tenantId,
            candidates.ids.auditEvents,
            this.cipher.encrypt(JSON.stringify({ erased: true })),
          ],
        );
      }
      if (candidates.selector.type === "person") {
        const value = candidates.selector.value;
        const actorUpdates = [
          ["UPDATE tasks SET approved_by = 'deleted' WHERE tenant_id = $1 AND approved_by = $2", []],
          ["UPDATE approvals SET actor = 'deleted', reason_ciphertext = $3 WHERE tenant_id = $1 AND actor = $2", [encryptedEmpty]],
          ["UPDATE decision_reviews SET reviewer = 'deleted', note_ciphertext = $3 WHERE tenant_id = $1 AND reviewer = $2", [encryptedEmpty]],
          ["UPDATE decision_review_events SET reviewer = 'deleted', note_ciphertext = $3 WHERE tenant_id = $1 AND reviewer = $2", [encryptedEmpty]],
          ["UPDATE work_plans SET revision_actor = 'deleted' WHERE tenant_id = $1 AND revision_actor = $2", []],
          ["UPDATE work_plans SET cancel_requested_by = 'deleted' WHERE tenant_id = $1 AND cancel_requested_by = $2", []],
          ["UPDATE work_plan_approvals SET actor = 'deleted', reason_ciphertext = $3 WHERE tenant_id = $1 AND actor = $2", [encryptedEmpty]],
          ["UPDATE memory_items SET created_by = 'deleted' WHERE tenant_id = $1 AND created_by = $2", []],
          ["UPDATE memory_items SET updated_by = 'deleted' WHERE tenant_id = $1 AND updated_by = $2", []],
          ["UPDATE audit_events SET actor = 'deleted', details_ciphertext = $3 WHERE tenant_id = $1 AND actor = $2", [this.cipher.encrypt(JSON.stringify({ erased: true }))]],
        ];
        for (const [sql, extra] of actorUpdates) {
          await client.query(sql, [this.tenantId, value, ...extra]);
        }
      }
      await this.audit(client, {
        eventType: "privacy.erased",
        actor: "system:privacy",
        details: {
          selector: candidates.preview.selector,
          counts: candidates.preview.counts,
          requestedByFingerprint: this.cipher.fingerprint(actor).slice(0, 24),
        },
      });
      return {
        erased: true,
        selector: candidates.preview.selector,
        counts: candidates.preview.counts,
        erasedAt: now.toISOString(),
      };
    });
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
            'cancelled_operator', 'expired', 'continued'
          )
          AND updated_at < $2
        FOR UPDATE SKIP LOCKED
      `,
        [this.tenantId, timestamp],
      );
      const ids = selected.rows.map((row) => row.id);
      if (ids.length === 0) return 0;
      const messages = await client.query(
        `SELECT platform_message_id FROM messages
         WHERE tenant_id = $1 AND task_id = ANY($2::text[]) FOR UPDATE`,
        [this.tenantId, ids],
      );
      for (const message of messages.rows) {
        await client.query(
          `INSERT INTO privacy_erased_messages(tenant_id, message_key, erased_at)
           VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
          [
            this.tenantId,
            this.cipher.fingerprint(`message:${message.platform_message_id}`),
          ],
        );
      }
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
