import { createHash, randomUUID } from "node:crypto";
import { DataCipher } from "./crypto.mjs";
import { checkPostgres, createPostgresPool } from "./postgres.mjs";

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
        const rows = selected.rows;
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

  async completeDraft(taskId, draft, now = new Date()) {
    const status = draft.shouldReply ? "awaiting_approval" : "no_reply";
    return this.transaction(async (client) => {
      const result = await client.query(
        `
        UPDATE tasks
        SET status = $3, result_ciphertext = $4, lease_until = NULL,
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
        SET status = $3, approved_at = $4, approved_by = $5, updated_at = $4
        WHERE id = $1 AND tenant_id = $2
      `,
        [
          taskId,
          this.tenantId,
          decision,
          decision === "approved" ? now : null,
          actor,
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

  async returnApprovedTask(taskId, reason, now = new Date()) {
    await this.pool.query(
      `
      UPDATE tasks
      SET status = 'approved', lease_until = NULL,
          last_error_ciphertext = $3, updated_at = $4
      WHERE id = $1 AND tenant_id = $2 AND status = 'sending'
    `,
      [taskId, this.tenantId, this.cipher.encrypt(reason), now],
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

  async getTask(taskId) {
    const result = await this.pool.query(
      "SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2",
      [taskId, this.tenantId],
    );
    return taskFromRow(result.rows[0], this.cipher);
  }

  async listTasks({ limit = 50, status } = {}) {
    const result = status
      ? await this.pool.query(
          `
          SELECT * FROM tasks
          WHERE tenant_id = $1 AND status = $2
          ORDER BY created_at DESC
          LIMIT $3
        `,
          [this.tenantId, status, limit],
        )
      : await this.pool.query(
          `
          SELECT * FROM tasks
          WHERE tenant_id = $1
          ORDER BY created_at DESC
          LIMIT $2
        `,
          [this.tenantId, limit],
        );
    return result.rows.map((row) => taskFromRow(row, this.cipher));
  }

  async retryTask(taskId, now = new Date()) {
    const result = await this.pool.query(
      `
      UPDATE tasks
      SET status = 'queued', attempts = 0, available_at = $3,
          lease_until = NULL, last_error_ciphertext = NULL, updated_at = $3
      WHERE id = $1 AND tenant_id = $2 AND status = 'dead'
    `,
      [taskId, this.tenantId, now],
    );
    if (result.rowCount !== 1) throw new Error("Only dead tasks can be retried");
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

  async health() {
    const [database, taskCounts, pendingMessages, checkpoints] =
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
      ]);
    return {
      database,
      paused: await this.isPaused(),
      tasks: Object.fromEntries(
        taskCounts.rows.map((row) => [row.status, Number(row.count)]),
      ),
      pendingMessages: Number(pendingMessages.rows[0].count),
      checkpoints: checkpoints.rows,
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
          AND status IN ('completed', 'no_reply', 'rejected', 'cancelled_manual')
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
