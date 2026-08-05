import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { DataCipher } from "./crypto.mjs";
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

const projectRoot = new URL("../", import.meta.url);
const defaultDatabaseUrl = new URL(".runtime/ai-employee.sqlite", projectRoot);

function nowIso(now = new Date()) {
  return now.toISOString();
}

function taskFromRow(row, cipher) {
  if (!row) return null;
  return {
    ...row,
    payload: row.payload_json
      ? JSON.parse(cipher.decrypt(row.payload_json))
      : null,
    result: row.result_json
      ? JSON.parse(cipher.decrypt(row.result_json))
      : null,
    last_error: row.last_error ? cipher.decrypt(row.last_error) : null,
    payload_json: undefined,
    result_json: undefined,
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

export class Store {
  constructor(databasePath) {
    this.path = databasePath ?? fileURLToPath(defaultDatabaseUrl);
    this.db = null;
    this.cipher = null;
  }

  async open() {
    if (this.db) return this;
    process.umask(process.umask() | 0o077);
    if (this.path !== ":memory:") {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.path), 0o700);
    }
    this.cipher = await DataCipher.create({
      encodedKey: process.env.AI_EMPLOYEE_DATA_KEY,
      keyPath:
        this.path === ":memory:"
          ? ""
          : `${this.path}.key`,
      ephemeral: this.path === ":memory:",
    });
    this.db = new DatabaseSync(this.path);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender_user_id TEXT NOT NULL,
        sender_name TEXT,
        conversation_id TEXT NOT NULL,
        create_time TEXT NOT NULL,
        content TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        task_id TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS messages_pending
      ON messages(status, conversation_id, sender_user_id, ingested_at);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        sender_user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        available_at TEXT NOT NULL,
        lease_until TEXT,
        last_error TEXT,
        draft_ready_at TEXT,
        decision_at TEXT,
        approved_at TEXT,
        approved_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_claimable
      ON tasks(status, available_at, lease_until);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        decision TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS side_effects (
        idempotency_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        status TEXT NOT NULL,
        receipt_json TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        subject_ciphertext TEXT NOT NULL,
        project_id TEXT,
        statement_ciphertext TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id_ciphertext TEXT NOT NULL,
        source_version TEXT,
        scope_ciphertext TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        valid_from TEXT,
        expires_at TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        supersedes_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY(supersedes_id) REFERENCES memory_items(id)
      );

      CREATE INDEX IF NOT EXISTS memory_items_active
      ON memory_items(status, project_id, type, subject_key, updated_at);

      CREATE TABLE IF NOT EXISTS work_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        requester_key TEXT NOT NULL,
        requester_ciphertext TEXT NOT NULL,
        objective_ciphertext TEXT NOT NULL,
        plan_ciphertext TEXT NOT NULL,
        plan_hash TEXT NOT NULL UNIQUE,
        max_level TEXT NOT NULL,
        policy_decision TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_version INTEGER NOT NULL DEFAULT 1,
        execution_owner TEXT,
        lease_expires_at TEXT,
        cancel_requested_at TEXT,
        cancel_requested_by TEXT,
        supersedes_work_plan_id TEXT,
        revision_actor TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(supersedes_work_plan_id) REFERENCES work_plans(id)
      );

      CREATE TABLE IF NOT EXISTS work_plan_approvals (
        id TEXT PRIMARY KEY,
        work_plan_id TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        approval_version INTEGER NOT NULL,
        decision TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason_ciphertext TEXT NOT NULL,
        expires_at TEXT,
        max_consumptions INTEGER NOT NULL DEFAULT 1,
        consumed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(work_plan_id, approval_version),
        FOREIGN KEY(work_plan_id) REFERENCES work_plans(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS work_plan_steps (
        work_plan_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        capability TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence_ciphertext TEXT,
        error_ciphertext TEXT,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(work_plan_id, step_id),
        FOREIGN KEY(work_plan_id) REFERENCES work_plans(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS decision_reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        expected_should_reply INTEGER NOT NULL,
        reviewer TEXT NOT NULL,
        note_ciphertext TEXT NOT NULL,
        decision_sha256 TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS decision_review_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        expected_should_reply INTEGER NOT NULL,
        reviewer TEXT NOT NULL,
        note_ciphertext TEXT NOT NULL,
        decision_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS availability_samples (
        bucket_at TEXT PRIMARY KEY,
        ready INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const workPlanColumns = new Set(
      this.db.prepare("PRAGMA table_info(work_plans)").all().map((row) => row.name),
    );
    const taskColumns = new Set(
      this.db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name),
    );
    const reviewColumns = new Set(
      this.db.prepare("PRAGMA table_info(decision_reviews)").all().map((row) => row.name),
    );
    if (!reviewColumns.has("decision_sha256")) {
      this.db.exec("ALTER TABLE decision_reviews ADD COLUMN decision_sha256 TEXT");
    }
    if (!taskColumns.has("draft_ready_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN draft_ready_at TEXT");
    }
    if (!taskColumns.has("decision_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN decision_at TEXT");
    }
    if (!workPlanColumns.has("execution_owner")) {
      this.db.exec("ALTER TABLE work_plans ADD COLUMN execution_owner TEXT");
    }
    if (!workPlanColumns.has("lease_expires_at")) {
      this.db.exec("ALTER TABLE work_plans ADD COLUMN lease_expires_at TEXT");
    }
    if (!workPlanColumns.has("cancel_requested_at")) {
      this.db.exec("ALTER TABLE work_plans ADD COLUMN cancel_requested_at TEXT");
    }
    if (!workPlanColumns.has("cancel_requested_by")) {
      this.db.exec("ALTER TABLE work_plans ADD COLUMN cancel_requested_by TEXT");
    }
    if (!workPlanColumns.has("supersedes_work_plan_id")) {
      this.db.exec("ALTER TABLE work_plans ADD COLUMN supersedes_work_plan_id TEXT");
    }
    if (!workPlanColumns.has("revision_actor")) {
      this.db.exec("ALTER TABLE work_plans ADD COLUMN revision_actor TEXT");
    }
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS work_plans_single_revision_idx
       ON work_plans(supersedes_work_plan_id)
       WHERE supersedes_work_plan_id IS NOT NULL`,
    );
    const sentinel = this.db
      .prepare("SELECT value FROM settings WHERE key = 'encryption_sentinel'")
      .get();
    if (!sentinel) {
      this.db
        .prepare(
          `
          INSERT OR IGNORE INTO settings(key, value, updated_at)
          VALUES ('encryption_sentinel', ?, ?)
        `,
        )
        .run(this.cipher.encrypt("ai-employee-v1"), nowIso());
    }
    const storedSentinel = this.db
      .prepare("SELECT value FROM settings WHERE key = 'encryption_sentinel'")
      .get();
    let sentinelValue;
    try {
      sentinelValue = this.cipher.decrypt(storedSentinel.value);
    } catch {
      this.db.close();
      this.db = null;
      throw new Error("The configured data key does not match this database");
    }
    if (sentinelValue !== "ai-employee-v1") {
      this.db.close();
      this.db = null;
      throw new Error("The configured data key does not match this database");
    }
    if (this.path !== ":memory:") {
      await chmod(this.path, 0o600);
      await Promise.all(
        [`${this.path}-wal`, `${this.path}-shm`].map((path) =>
          chmod(path, 0o600).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          }),
        ),
      );
    }
    return this;
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ingestMessages(messages, now = new Date()) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO messages (
        id, sender_user_id, sender_name, conversation_id,
        create_time, content, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    this.transaction(() => {
      for (const message of messages) {
        if (
          !message.id ||
          !message.senderUserId ||
          !message.conversationId ||
          !message.createTime
        ) {
          continue;
        }
        const result = insert.run(
          message.id,
          message.senderUserId,
          this.cipher.encrypt(message.senderName ?? ""),
          message.conversationId,
          String(message.createTime),
          this.cipher.encrypt(String(message.content ?? "")),
          nowIso(now),
        );
        inserted += Number(result.changes);
      }
    });
    return inserted;
  }

  createReadyTasks({
    quietWindowMs,
    bundleGapMs = 120_000,
    maxMessagesPerTask = 20,
    maxAttempts = 5,
    now = new Date(),
  }) {
    const cutoff = new Date(now.getTime() - quietWindowMs).toISOString();
    const groups = this.db
      .prepare(
        `
        SELECT conversation_id, sender_user_id, MAX(ingested_at) AS last_ingested
        FROM messages
        WHERE status = 'pending'
        GROUP BY conversation_id, sender_user_id
        HAVING last_ingested <= ?
        ORDER BY last_ingested
      `,
      )
      .all(cutoff);
    const created = [];

    this.transaction(() => {
      const selectMessages = this.db.prepare(`
        SELECT * FROM messages
        WHERE status = 'pending'
          AND conversation_id = ?
          AND sender_user_id = ?
        ORDER BY create_time, id
      `);
      const insertTask = this.db.prepare(`
        INSERT OR IGNORE INTO tasks (
          id, kind, status, sender_user_id, conversation_id, payload_json,
          max_attempts, available_at, created_at, updated_at
        ) VALUES (?, 'reply', 'queued', ?, ?, ?, ?, ?, ?, ?)
      `);
      const markBundled = this.db.prepare(`
        UPDATE messages SET status = 'bundled', task_id = ?
        WHERE id = ? AND status = 'pending'
      `);

      for (const group of groups) {
        const pendingMessages = selectMessages.all(
          group.conversation_id,
          group.sender_user_id,
        );
        if (pendingMessages.length === 0) continue;
        const bursts = splitMessageBursts(pendingMessages, {
          gapMs: bundleGapMs,
          maxMessages: maxMessagesPerTask,
        });
        for (const messages of bursts) {
          const digest = createHash("sha256")
            .update(messages.map((message) => message.id).join("\n"))
            .digest("hex")
            .slice(0, 24);
          const taskId = `reply_${digest}`;
          const payload = {
            messageIds: messages.map((message) => message.id),
            latestMessageId: messages.at(-1).id,
            latestCreateTime: messages.at(-1).create_time,
            senderName: this.cipher.decrypt(messages.at(-1).sender_name),
            content: messages
              .map((message) => this.cipher.decrypt(message.content))
              .join("\n"),
            messages: messages.map((message) => ({
              id: message.id,
              createTime: message.create_time,
              content: this.cipher.decrypt(message.content),
            })),
          };
          const timestamp = nowIso(now);
          const result = insertTask.run(
            taskId,
            group.sender_user_id,
            group.conversation_id,
            this.cipher.encrypt(JSON.stringify(payload)),
            maxAttempts,
            timestamp,
            timestamp,
            timestamp,
          );
          if (result.changes === 0) continue;
          for (const message of messages) markBundled.run(taskId, message.id);
          created.push(taskId);
        }
      }
    });
    return created;
  }

  claimTask({ leaseMs = 120_000, now = new Date() } = {}) {
    return this.transaction(() => {
      const timestamp = nowIso(now);
      this.db
        .prepare(
          `
          UPDATE tasks
          SET status = 'dead', lease_until = NULL,
              last_error = COALESCE(last_error, 'processing lease exhausted'),
              updated_at = ?
          WHERE status = 'processing'
            AND lease_until <= ?
            AND attempts >= max_attempts
        `,
        )
        .run(timestamp, timestamp);
      const row = this.db
        .prepare(
          `
          SELECT * FROM tasks
          WHERE (
            status = 'queued'
            OR (status = 'processing' AND lease_until <= ?)
          )
            AND available_at <= ?
            AND attempts < max_attempts
          ORDER BY created_at
          LIMIT 1
        `,
        )
        .get(timestamp, timestamp);
      if (!row) return null;
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      this.db
        .prepare(
          `
          UPDATE tasks
          SET status = 'processing', attempts = attempts + 1,
              lease_until = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(leaseUntil, timestamp, row.id);
      return taskFromRow(
        this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(row.id),
        this.cipher,
      );
    });
  }

  deferTaskForPause(taskId, retryAfterMs = 30_000, now = new Date()) {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 1_000) {
      throw new Error("Pause retry delay must be at least 1000ms");
    }
    const result = this.db.prepare(
      `UPDATE tasks SET status = 'queued',
       attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
       available_at = ?, lease_until = NULL, last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'processing'`,
    ).run(
      new Date(now.getTime() + retryAfterMs).toISOString(),
      nowIso(now),
      taskId,
    );
    if (result.changes !== 1) throw new Error("Task is not processing");
    return "queued";
  }

  completeDraft(taskId, draft, now = new Date()) {
    const status = draft.shouldReply ? "awaiting_approval" : "no_reply";
    this.db
      .prepare(
        `
        UPDATE tasks
        SET status = ?, result_json = ?, draft_ready_at = ?, lease_until = NULL,
            last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing'
      `,
      )
      .run(
        status,
        this.cipher.encrypt(JSON.stringify(draft)),
        nowIso(now),
        nowIso(now),
        taskId,
      );
  }

  failTask(taskId, error, now = new Date()) {
    return this.transaction(() => {
      const task = this.db
        .prepare("SELECT attempts, max_attempts FROM tasks WHERE id = ?")
        .get(taskId);
      if (!task) return null;
      const dead = task.attempts >= task.max_attempts;
      const delayMs = Math.min(300_000, 1_000 * 2 ** Math.max(0, task.attempts - 1));
      const availableAt = new Date(now.getTime() + delayMs).toISOString();
      const status = dead ? "dead" : "queued";
      this.db
        .prepare(
          `
          UPDATE tasks
          SET status = ?, available_at = ?, lease_until = NULL,
              last_error = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(
          status,
          availableAt,
          this.cipher.encrypt(String(error?.message ?? error)),
          nowIso(now),
          taskId,
        );
      return status;
    });
  }

  decideTask(taskId, { decision, actor, reason = "" }, now = new Date()) {
    if (!["approved", "rejected"].includes(decision)) {
      throw new Error("decision must be approved or rejected");
    }
    return this.transaction(() => {
      const task = this.db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(taskId);
      if (!task) throw new Error(`task not found: ${taskId}`);
      if (task.status !== "awaiting_approval") {
        throw new Error(`task is not awaiting approval: ${task.status}`);
      }
      const timestamp = nowIso(now);
      this.db
        .prepare(
          `
          INSERT INTO approvals(id, task_id, decision, actor, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          randomUUID(),
          taskId,
          decision,
          actor,
          this.cipher.encrypt(reason),
          timestamp,
        );
      this.db
        .prepare(
          `
          UPDATE tasks
          SET status = ?, decision_at = ?, approved_at = ?, approved_by = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(
          decision,
          timestamp,
          decision === "approved" ? timestamp : null,
          actor,
          timestamp,
          taskId,
        );
      return decision;
    });
  }

  claimApprovedTask({ leaseMs = 120_000, now = new Date() } = {}) {
    return this.transaction(() => {
      const timestamp = nowIso(now);
      const row = this.db
        .prepare(
          `
          SELECT * FROM tasks
          WHERE (
            status = 'approved'
            OR (status = 'sending' AND lease_until <= ?)
          )
            AND available_at <= ?
          ORDER BY approved_at
          LIMIT 1
        `,
      )
        .get(timestamp, timestamp);
      if (!row) return null;
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      this.db
        .prepare(
          `
          UPDATE tasks
          SET status = 'sending', lease_until = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(leaseUntil, timestamp, row.id);
      return taskFromRow(
        this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(row.id),
        this.cipher,
      );
    });
  }

  beginSideEffect(taskId, capability, now = new Date()) {
    const key = `${capability}:${taskId}`;
    return this.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM side_effects WHERE idempotency_key = ?")
        .get(key);
      if (existing) {
        return {
          ...existing,
          receipt_json: existing.receipt_json
            ? this.cipher.decrypt(existing.receipt_json)
            : null,
        };
      }
      const timestamp = nowIso(now);
      this.db
        .prepare(
          `
          INSERT INTO side_effects(
            idempotency_key, task_id, capability, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'started', ?, ?)
        `,
        )
        .run(key, taskId, capability, timestamp, timestamp);
      const created = this.db
        .prepare("SELECT * FROM side_effects WHERE idempotency_key = ?")
        .get(key);
      return { ...created, receipt_json: null };
    });
  }

  completeSideEffect(taskId, capability, receipt, now = new Date()) {
    const key = `${capability}:${taskId}`;
    this.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE side_effects
          SET status = 'completed', receipt_json = ?, last_error = NULL, updated_at = ?
          WHERE idempotency_key = ?
        `,
        )
        .run(this.cipher.encrypt(JSON.stringify(receipt)), nowIso(now), key);
      this.db
        .prepare(
          `
          UPDATE tasks
          SET status = 'completed', lease_until = NULL, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(nowIso(now), taskId);
    });
  }

  markSideEffectUnknown(taskId, capability, error, now = new Date()) {
    const key = `${capability}:${taskId}`;
    this.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE side_effects
          SET status = 'unknown', last_error = ?, updated_at = ?
          WHERE idempotency_key = ?
        `,
        )
        .run(
          this.cipher.encrypt(String(error?.message ?? error)),
          nowIso(now),
          key,
        );
      this.db
        .prepare(
          `
          UPDATE tasks
          SET status = 'send_unknown', lease_until = NULL,
              last_error = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(
          this.cipher.encrypt(String(error?.message ?? error)),
          nowIso(now),
          taskId,
        );
    });
  }

  returnApprovedTask(taskId, reason, now = new Date(), retryAfterMs = 30_000) {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 1_000) {
      throw new Error("Send retry delay must be at least 1000ms");
    }
    this.db
      .prepare(
        `
        UPDATE tasks SET status = 'approved', lease_until = NULL,
            available_at = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'sending'
      `,
      )
      .run(
        new Date(now.getTime() + retryAfterMs).toISOString(),
        this.cipher.encrypt(reason),
        nowIso(now),
        taskId,
      );
  }

  cancelForManualReply(taskId, now = new Date()) {
    this.db
      .prepare(
        `
        UPDATE tasks
        SET status = 'cancelled_manual', lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending'
      `,
      )
      .run(nowIso(now), taskId);
  }

  cancelDraftForManualReply(taskId, now = new Date()) {
    const result = this.db
      .prepare(
        `
        UPDATE tasks
        SET status = 'cancelled_manual', updated_at = ?
        WHERE id = ? AND status = 'awaiting_approval'
      `,
      )
      .run(nowIso(now), taskId);
    return result.changes === 1;
  }

  getTask(taskId) {
    return taskFromRow(
      this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId),
      this.cipher,
    );
  }

  listTasks({
    limit = 50,
    offset = 0,
    status,
    beforeCreatedAt,
    beforeId,
  } = {}) {
    let rows;
    if (status && beforeCreatedAt && beforeId) {
      rows = this.db
        .prepare(
          `
          SELECT * FROM tasks
          WHERE status = ?
            AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
        )
        .all(status, beforeCreatedAt, beforeCreatedAt, beforeId, limit);
    } else if (status) {
      rows = this.db
          .prepare(
            "SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
          )
          .all(status, limit, offset);
    } else {
      rows = this.db
        .prepare(
          "SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
        )
        .all(limit, offset);
    }
    return rows.map((row) => taskFromRow(row, this.cipher));
  }

  expireAwaitingDrafts({ before, now = new Date() }) {
    const result = this.db
      .prepare(
        `
        UPDATE tasks
        SET status = 'expired', updated_at = ?
        WHERE status = 'awaiting_approval' AND updated_at < ?
      `,
      )
      .run(nowIso(now), nowIso(before));
    return result.changes;
  }

  retryTask(taskId, now = new Date()) {
    const result = this.db
      .prepare(
        `
        UPDATE tasks
        SET status = 'queued', attempts = 0, available_at = ?,
            lease_until = NULL, last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'dead'
      `,
      )
      .run(nowIso(now), nowIso(now), taskId);
    if (result.changes === 0) {
      throw new Error("Only dead tasks can be retried");
    }
  }

  dismissDeadTask(taskId, actor, reason = "", now = new Date()) {
    if (!String(actor ?? "").trim()) throw new Error("actor is required");
    const result = this.db
      .prepare(
        `
        UPDATE tasks
        SET status = 'cancelled_operator', lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'dead'
      `,
      )
      .run(nowIso(now), taskId);
    if (result.changes !== 1) {
      throw new Error("Only dead tasks can be dismissed");
    }
    return "cancelled_operator";
  }

  resolveUnknownSend(taskId, resolution, actor, now = new Date()) {
    if (!["sent", "not_sent"].includes(resolution)) {
      throw new Error("resolution must be sent or not_sent");
    }
    this.transaction(() => {
      const task = this.db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(taskId);
      if (task?.status !== "send_unknown") {
        throw new Error("Task is not in send_unknown state");
      }
      const timestamp = nowIso(now);
      if (resolution === "sent") {
        this.db
          .prepare(
            `
            UPDATE side_effects
            SET status = 'completed', receipt_json = ?, last_error = NULL,
                updated_at = ?
            WHERE task_id = ? AND capability = 'send_message'
          `,
          )
          .run(
            this.cipher.encrypt(
              JSON.stringify({ manuallyConfirmedBy: actor }),
            ),
            timestamp,
            taskId,
          );
        this.db
          .prepare(
            `
            UPDATE tasks
            SET status = 'completed', last_error = NULL, updated_at = ?
            WHERE id = ?
          `,
          )
          .run(timestamp, taskId);
      } else {
        this.db
          .prepare(
            "DELETE FROM side_effects WHERE task_id = ? AND capability = 'send_message'",
          )
          .run(taskId);
        this.db
          .prepare(
            `
            UPDATE tasks
            SET status = 'approved', last_error = NULL, updated_at = ?
            WHERE id = ?
          `,
          )
          .run(timestamp, taskId);
      }
    });
  }

  getCheckpoint(key) {
    return this.db
      .prepare("SELECT value FROM checkpoints WHERE key = ?")
      .get(key)?.value;
  }

  knownMessageIds(ids) {
    const unique = [...new Set(ids.map(String))];
    const found = new Set();
    for (let offset = 0; offset < unique.length; offset += 500) {
      const batch = unique.slice(offset, offset + 500);
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(",");
      for (const row of this.db.prepare(
        `SELECT id FROM messages WHERE id IN (${placeholders})`,
      ).all(...batch)) found.add(String(row.id));
    }
    return found;
  }

  setCheckpoint(key, value, now = new Date()) {
    this.db
      .prepare(
        `
        INSERT INTO checkpoints(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `,
      )
      .run(key, value, nowIso(now));
  }

  setScopedPause(change, now = new Date()) {
    const normalized = normalizePauseChange(change);
    const key = scopedPauseKey(
      this.cipher,
      normalized.type,
      normalized.value,
    );
    if (!normalized.paused) {
      this.db.prepare("DELETE FROM checkpoints WHERE key = ?").run(key);
      return false;
    }
    this.setCheckpoint(
      key,
      this.cipher.encrypt(JSON.stringify({
        type: normalized.type,
        value: normalized.value,
        actor: normalized.actor,
        reason: normalized.reason,
        pausedAt: nowIso(now),
      })),
      now,
    );
    return true;
  }

  isScopedPaused(type, value) {
    const scope = normalizePauseScope(type, value);
    const key = scopedPauseKey(this.cipher, scope.type, scope.value);
    return Boolean(
      this.db.prepare("SELECT 1 FROM checkpoints WHERE key = ?").get(key),
    );
  }

  listScopedPauses() {
    return this.db
      .prepare(
        "SELECT value, updated_at FROM checkpoints WHERE substr(key, 1, 13) = 'scoped_pause:' ORDER BY updated_at DESC",
      )
      .all()
      .map((row) => ({
        ...JSON.parse(this.cipher.decrypt(row.value)),
        updatedAt: row.updated_at,
      }));
  }

  proposeMemory(input, now = new Date()) {
    const memory = validateMemoryProposal(input);
    const id = `memory_${randomUUID()}`;
    const timestamp = nowIso(now);
    this.db
      .prepare(
        `
        INSERT INTO memory_items(
          id, type, subject_key, subject_ciphertext, project_id,
          statement_ciphertext, source_type, source_id_ciphertext,
          source_version, scope_ciphertext, confidence, status,
          sensitivity, expires_at, created_by, updated_by, supersedes_id,
          created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'proposed',?,?,?,?,?,?,?)
      `,
      )
      .run(
        id,
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
        memory.expiresAt?.toISOString() ?? null,
        memory.createdBy,
        memory.createdBy,
        memory.supersedesId,
        timestamp,
        timestamp,
      );
    return id;
  }

  confirmMemory(id, actor, now = new Date(), { supersedesId = null } = {}) {
    return this.transaction(() => {
      const memory = this.db
        .prepare("SELECT * FROM memory_items WHERE id = ?")
        .get(id);
      if (!memory) throw new Error(`Memory not found: ${id}`);
      if (memory.status !== "proposed") throw new Error("Memory is not proposed");
      const active = this.db.prepare(
        `SELECT * FROM memory_items
         WHERE status = 'confirmed' AND deleted_at IS NULL
           AND type = ? AND subject_key = ? AND project_id IS ?
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY updated_at DESC`,
      ).all(memory.type, memory.subject_key, memory.project_id, nowIso(now));
      const candidate = memoryFromRow(memory, this.cipher);
      const factKey = memoryFactKey(candidate);
      const comparable = factKey
        ? active.filter((item) => memoryFactKey(memoryFromRow(item, this.cipher)) === factKey)
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
      if (conflicts.length === 0 && replacementId && !active.some((item) => item.id === replacementId)) {
        throw new Error("Superseded memory is not an active conflicting fact");
      }
      const timestamp = nowIso(now);
      this.db
        .prepare(
          `UPDATE memory_items
           SET status = 'confirmed', supersedes_id = ?, valid_from = ?, updated_at = ?, updated_by = ?
           WHERE id = ?`,
        )
        .run(replacementId, timestamp, timestamp, actor, id);
      if (replacementId) {
        this.db
          .prepare(
            `UPDATE memory_items SET status = 'revoked', updated_at = ?, updated_by = ?
             WHERE id = ? AND status = 'confirmed'`,
          )
          .run(timestamp, actor, replacementId);
      }
      return "confirmed";
    });
  }

  revokeMemory(id, actor, now = new Date()) {
    const result = this.db
      .prepare(
        `UPDATE memory_items SET status = 'revoked', updated_at = ?, updated_by = ?
         WHERE id = ? AND status IN ('proposed', 'confirmed')`,
      )
      .run(nowIso(now), actor, id);
    if (result.changes !== 1) throw new Error("Memory cannot be revoked");
    return "revoked";
  }

  deleteMemory(id, actor, confirmation, now = new Date()) {
    if (confirmation !== memoryDeletionConfirmation(id)) {
      throw new Error("Memory deletion confirmation does not match");
    }
    return this.transaction(() => {
      const current = this.db
        .prepare("SELECT id FROM memory_items WHERE id = ? AND deleted_at IS NULL")
        .get(id);
      if (!current) throw new Error("Memory cannot be deleted");
      const timestamp = nowIso(now);
      const result = this.db.prepare(
        `UPDATE memory_items SET
           subject_key = ?, subject_ciphertext = ?, project_id = NULL,
           statement_ciphertext = ?, source_type = 'deleted',
           source_id_ciphertext = ?, source_version = NULL,
           scope_ciphertext = ?, confidence = 0, status = 'revoked',
           sensitivity = 'internal', valid_from = NULL, expires_at = NULL,
           created_by = 'deleted', updated_by = 'deleted', supersedes_id = NULL,
           created_at = ?, updated_at = ?, deleted_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      ).run(
        this.cipher.fingerprint(`deleted:${id}:${randomUUID()}`),
        this.cipher.encrypt(""),
        this.cipher.encrypt(""),
        this.cipher.encrypt(""),
        this.cipher.encrypt("{}"),
        timestamp,
        timestamp,
        timestamp,
        id,
      );
      if (result.changes !== 1) throw new Error("Memory cannot be deleted");
      return "deleted";
    });
  }

  recordMemoryExport() {
    return "recorded";
  }

  listMemories({
    type,
    subject,
    projectId,
    status,
    sensitivity,
    limit = 100,
  } = {}) {
    const clauses = ["deleted_at IS NULL"];
    const parameters = [];
    if (type) {
      clauses.push("type = ?");
      parameters.push(type);
    }
    if (subject) {
      clauses.push("subject_key = ?");
      parameters.push(this.cipher.fingerprint(subject));
    }
    if (projectId) {
      clauses.push("project_id = ?");
      parameters.push(projectId);
    }
    if (status) {
      clauses.push("status = ?");
      parameters.push(status);
    }
    if (sensitivity) {
      clauses.push("sensitivity = ?");
      parameters.push(sensitivity);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items WHERE ${clauses.join(" AND ")}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters, limit);
    return rows.map((row) => memoryFromRow(row, this.cipher));
  }

  memoryConflictMetrics(now = new Date()) {
    return analyzeMemoryConflicts(this.listMemories({ limit: 1_000 }), now);
  }

  searchMemories({ query = "", now = new Date(), limit = 20, ...filters } = {}) {
    const needle = String(query).trim().toLowerCase();
    return this.listMemories({ ...filters, status: "confirmed", limit: 500 })
      .filter((memory) => memoryIsUsable(memory, now))
      .filter(
        (memory) =>
          !needle ||
          memory.statement.toLowerCase().includes(needle) ||
          memory.subject.toLowerCase().includes(needle),
      )
      .slice(0, limit);
  }

  registerWorkPlan(assessment, now = new Date()) {
    if (!assessment?.planHash || !assessment?.plan) {
      throw new Error("Assessed work plan is required");
    }
    if (!["ALLOW", "REQUIRE_APPROVAL"].includes(assessment.decision)) {
      throw new Error("Denied work plan cannot be registered");
    }
    const id = `plan_${assessment.planHash.slice(0, 24)}`;
    const timestamp = nowIso(now);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO work_plans(
          id, project_id, requester_key, requester_ciphertext,
          objective_ciphertext, plan_ciphertext, plan_hash, max_level,
          policy_decision, status, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        assessment.plan.projectId,
        this.cipher.fingerprint(assessment.plan.requesterId),
        this.cipher.encrypt(assessment.plan.requesterId),
        this.cipher.encrypt(assessment.plan.objective),
        this.cipher.encrypt(JSON.stringify(assessment.plan)),
        assessment.planHash,
        assessment.maxLevel,
        assessment.decision,
        assessment.decision === "ALLOW" ? "ready" : "awaiting_approval",
        timestamp,
        timestamp,
      );
    const insertStep = this.db.prepare(
      `INSERT OR IGNORE INTO work_plan_steps(
        work_plan_id, step_id, position, capability, status, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?)`,
    );
    assessment.plan.steps.forEach((step, position) => {
      insertStep.run(id, step.id, position, step.capability, timestamp);
    });
    return this.getWorkPlan(id);
  }

  reviseWorkPlan(id, assessment, actor, now = new Date()) {
    if (!String(actor ?? "").trim()) {
      throw new Error("Work plan revision actor is required");
    }
    return this.transaction(() => {
      const currentRow = this.db
        .prepare("SELECT * FROM work_plans WHERE id = ?")
        .get(id);
      if (!currentRow || !["awaiting_approval", "rejected"].includes(currentRow.status)) {
        throw new Error("Work plan can no longer be revised");
      }
      validateWorkPlanRevision({
        currentPlan: JSON.parse(this.cipher.decrypt(currentRow.plan_ciphertext)),
        currentPlanHash: currentRow.plan_hash,
        assessment,
      });
      const revisedId = `plan_${assessment.planHash.slice(0, 24)}`;
      if (this.db.prepare("SELECT 1 FROM work_plans WHERE id = ?").get(revisedId)) {
        throw new Error("Revised work plan already exists");
      }
      const timestamp = nowIso(now);
      this.db.prepare(
        `INSERT INTO work_plans(
          id, project_id, requester_key, requester_ciphertext,
          objective_ciphertext, plan_ciphertext, plan_hash, max_level,
          policy_decision, status, supersedes_work_plan_id, revision_actor,
          created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,'awaiting_approval',?,?,?,?)`,
      ).run(
        revisedId,
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
        timestamp,
        timestamp,
      );
      const insertStep = this.db.prepare(
        `INSERT INTO work_plan_steps(
          work_plan_id, step_id, position, capability, status, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?)`,
      );
      assessment.plan.steps.forEach((step, position) => {
        insertStep.run(revisedId, step.id, position, step.capability, timestamp);
      });
      const updated = this.db.prepare(
        `UPDATE work_plans SET status = 'superseded', updated_at = ?
         WHERE id = ? AND status IN ('awaiting_approval','rejected')`,
      ).run(timestamp, id);
      if (updated.changes !== 1) throw new Error("Work plan revision race detected");
      return this.getWorkPlan(revisedId);
    });
  }

  getWorkPlan(id) {
    return workPlanFromRow(
      this.db.prepare("SELECT * FROM work_plans WHERE id = ?").get(id),
      this.cipher,
    );
  }

  listWorkPlans({ status, limit = 100 } = {}) {
    const rows = status
      ? this.db
          .prepare(
            "SELECT * FROM work_plans WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
          )
          .all(status, limit)
      : this.db
          .prepare(
            "SELECT * FROM work_plans ORDER BY updated_at DESC, id DESC LIMIT ?",
          )
          .all(limit);
    return rows.map((row) => workPlanFromRow(row, this.cipher));
  }

  decideWorkPlan(
    id,
    { decision, actor, reason = "", expiresAt, maxConsumptions = 1 },
    now = new Date(),
  ) {
    if (!["approved", "rejected"].includes(decision)) {
      throw new Error("decision must be approved or rejected");
    }
    return this.transaction(() => {
      const plan = this.db
        .prepare("SELECT * FROM work_plans WHERE id = ?")
        .get(id);
      if (!plan || plan.status !== "awaiting_approval") {
        throw new Error("Work plan is not awaiting approval");
      }
      const expiry = expiresAt ? new Date(expiresAt) : new Date(now.getTime() + 2 * 60 * 60 * 1000);
      if (decision === "approved" && (!Number.isFinite(expiry.getTime()) || expiry <= now)) {
        throw new Error("Approval expiry must be in the future");
      }
      if (!Number.isSafeInteger(maxConsumptions) || maxConsumptions <= 0) {
        throw new Error("maxConsumptions must be a positive integer");
      }
      const timestamp = nowIso(now);
      this.db.prepare(
        `INSERT INTO work_plan_approvals(
          id, work_plan_id, plan_hash, approval_version, decision,
          actor, reason_ciphertext, expires_at, max_consumptions, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        randomUUID(), id, plan.plan_hash, plan.approval_version, decision,
        actor, this.cipher.encrypt(reason),
        decision === "approved" ? expiry.toISOString() : null,
        maxConsumptions, timestamp,
      );
      this.db.prepare(
        "UPDATE work_plans SET status = ?, updated_at = ? WHERE id = ?",
      ).run(decision, timestamp, id);
      return decision;
    });
  }

  consumeWorkPlanAuthorization(
    id,
    now = new Date(),
    { owner = null, leaseExpiresAt = null } = {},
  ) {
    if (owner && !(leaseExpiresAt instanceof Date && leaseExpiresAt > now)) {
      throw new Error("Execution lease expiry must be in the future");
    }
    return this.transaction(() => {
      const plan = this.db
        .prepare("SELECT * FROM work_plans WHERE id = ?")
        .get(id);
      if (!plan) throw new Error("Work plan not found");
      if (plan.status === "ready" && plan.policy_decision === "ALLOW") {
        this.db.prepare(
          `UPDATE work_plans SET status = 'executing', execution_owner = ?,
           lease_expires_at = ?, updated_at = ? WHERE id = ?`,
        ).run(owner, leaseExpiresAt?.toISOString() ?? null, nowIso(now), id);
        return true;
      }
      if (plan.status !== "approved") throw new Error("Work plan is not authorized");
      const approval = this.db.prepare(
        `SELECT * FROM work_plan_approvals
         WHERE work_plan_id = ? AND approval_version = ?
           AND decision = 'approved' AND plan_hash = ?
           AND expires_at > ? AND consumed < max_consumptions`,
      ).get(id, plan.approval_version, plan.plan_hash, nowIso(now));
      if (!approval) throw new Error("Work plan approval is invalid or expired");
      this.db.prepare(
        "UPDATE work_plan_approvals SET consumed = consumed + 1 WHERE id = ?",
      ).run(approval.id);
      this.db.prepare(
        `UPDATE work_plans SET status = 'executing', execution_owner = ?,
         lease_expires_at = ?, updated_at = ? WHERE id = ?`,
      ).run(owner, leaseExpiresAt?.toISOString() ?? null, nowIso(now), id);
      return true;
    });
  }

  renewWorkPlanLease(id, owner, leaseExpiresAt, now = new Date()) {
    if (!owner || !(leaseExpiresAt instanceof Date && leaseExpiresAt > now)) {
      throw new Error("Valid execution owner and future lease expiry are required");
    }
    const result = this.db.prepare(
      `UPDATE work_plans SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND execution_owner = ?
         AND status IN ('executing','verifying')`,
    ).run(leaseExpiresAt.toISOString(), nowIso(now), id, owner);
    if (result.changes !== 1) throw new Error("Work plan execution lease was lost");
    return true;
  }

  requestWorkPlanCancellation(id, actor, now = new Date()) {
    if (!String(actor ?? "").trim()) throw new Error("Cancellation actor is required");
    return this.transaction(() => {
      const plan = this.db.prepare("SELECT status FROM work_plans WHERE id = ?").get(id);
      if (!plan) throw new Error("Work plan not found");
      if (plan.status === "cancelled") return "cancelled";
      if (["ready", "awaiting_approval", "approved"].includes(plan.status)) {
        this.db.prepare(
          `UPDATE work_plan_steps SET status = 'cancelled', completed_at = ?, updated_at = ?
           WHERE work_plan_id = ? AND status = 'pending'`,
        ).run(nowIso(now), nowIso(now), id);
        this.db.prepare(
          `UPDATE work_plans SET status = 'cancelled', cancel_requested_at = ?,
           cancel_requested_by = ?, updated_at = ? WHERE id = ?`,
        ).run(nowIso(now), actor, nowIso(now), id);
        return "cancelled";
      }
      if (!["executing", "verifying"].includes(plan.status)) {
        throw new Error("Work plan can no longer be cancelled");
      }
      this.db.prepare(
        `UPDATE work_plans SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
         cancel_requested_by = COALESCE(cancel_requested_by, ?), updated_at = ?
         WHERE id = ?`,
      ).run(nowIso(now), actor, nowIso(now), id);
      return "cancellation_requested";
    });
  }

  isWorkPlanCancellationRequested(id) {
    return Boolean(
      this.db.prepare(
        `SELECT 1 AS requested FROM work_plans
         WHERE id = ? AND cancel_requested_at IS NOT NULL
           AND status IN ('executing','verifying')`,
      ).get(id),
    );
  }

  finalizeWorkPlanCancellation(id, now = new Date()) {
    return this.transaction(() => {
      const result = this.db.prepare(
        `UPDATE work_plans SET status = 'cancelled', execution_owner = NULL,
         lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND cancel_requested_at IS NOT NULL
           AND status IN ('executing','verifying')`,
      ).run(nowIso(now), id);
      if (result.changes !== 1) throw new Error("Work plan has no active cancellation request");
      this.db.prepare(
        `UPDATE work_plan_steps SET status = 'cancelled', completed_at = ?, updated_at = ?
         WHERE work_plan_id = ? AND status IN ('pending','executing','verifying')`,
      ).run(nowIso(now), nowIso(now), id);
      return "cancelled";
    });
  }

  recoverExpiredWorkPlans(now = new Date()) {
    return this.transaction(() => {
      const expired = this.db.prepare(
        `SELECT id FROM work_plans
         WHERE status IN ('executing','verifying')
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      ).all(nowIso(now));
      for (const { id } of expired) {
        this.db.prepare(
          `UPDATE work_plan_steps SET status = 'failed',
           error_ciphertext = ?, completed_at = ?, updated_at = ?
           WHERE work_plan_id = ? AND status IN ('executing','verifying')`,
        ).run(
          this.cipher.encrypt("execution_interrupted"),
          nowIso(now),
          nowIso(now),
          id,
        );
        this.db.prepare(
          `UPDATE work_plans SET status = 'failed', execution_owner = NULL,
           lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(nowIso(now), id);
      }
      return expired.length;
    });
  }

  listWorkPlanSteps(id) {
    return this.db
      .prepare(
        "SELECT * FROM work_plan_steps WHERE work_plan_id = ? ORDER BY position",
      )
      .all(id)
      .map((row) => ({
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

  updateWorkPlanStep(
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
    const timestamp = nowIso(now);
    const result = this.db
      .prepare(
        `UPDATE work_plan_steps SET
          status = ?, evidence_ciphertext = COALESCE(?, evidence_ciphertext),
          error_ciphertext = ?,
          started_at = CASE WHEN ? = 'executing' THEN COALESCE(started_at, ?) ELSE started_at END,
          completed_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE completed_at END,
          updated_at = ?
         WHERE work_plan_id = ? AND step_id = ?`,
      )
      .run(
        status,
        evidence == null ? null : this.cipher.encrypt(JSON.stringify(evidence)),
        error == null ? null : this.cipher.encrypt(String(error)),
        status,
        timestamp,
        status,
        timestamp,
        timestamp,
        id,
        stepId,
      );
    if (result.changes !== 1) throw new Error("Work plan step not found");
  }

  finishWorkPlan(id, { success, error = null }, now = new Date()) {
    const status = success ? "completed" : "failed";
    const result = this.db
      .prepare(
        `UPDATE work_plans SET status = ?, execution_owner = NULL,
         lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('executing','verifying')`,
      )
      .run(status, nowIso(now), id);
    if (result.changes !== 1) throw new Error("Work plan is not executing");
    return { status, error };
  }

  ensureWorkPlanResultDraft(planId, now = new Date()) {
    return this.transaction(() => {
      const plan = this.getWorkPlan(planId);
      if (!plan) throw new Error("Work plan not found");
      const draft = buildPlanResultDraft({
        plan,
        steps: this.listWorkPlanSteps(planId),
        now,
      });
      if (!draft) return null;
      const source = this.getTask(draft.sourceTaskId);
      if (!source) return null;
      const timestamp = nowIso(now);
      const payload = {
        ...draft.payload,
        senderName: source.payload?.senderName ?? null,
      };
      this.db.prepare(
        `INSERT OR IGNORE INTO tasks(
          id, kind, status, sender_user_id, conversation_id,
          payload_json, result_json, max_attempts, available_at,
          draft_ready_at, created_at, updated_at
        ) VALUES (?, 'reply', 'awaiting_approval', ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      ).run(
        draft.id,
        source.sender_user_id,
        source.conversation_id,
        this.cipher.encrypt(JSON.stringify(payload)),
        this.cipher.encrypt(JSON.stringify(draft.result)),
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      );
      return this.getTask(draft.id);
    });
  }

  upsertDecisionReview(
    taskId,
    { expectedShouldReply, reviewer, note = "" },
    now = new Date(),
  ) {
    if (typeof expectedShouldReply !== "boolean") {
      throw new Error("expectedShouldReply must be boolean");
    }
    if (!String(reviewer ?? "").trim()) throw new Error("reviewer is required");
    const task = this.getTask(taskId);
    if (!task || typeof task.result?.shouldReply !== "boolean") {
      throw new Error("Task has no completed reply decision");
    }
    if (expectedShouldReply !== task.result.shouldReply && !String(note).trim()) {
      throw new Error("note is required when human and AI decisions differ");
    }
    const timestamp = nowIso(now);
    const fingerprint = decisionSha256(task.result);
    return this.transaction(() => {
      this.db.prepare(
        `INSERT INTO decision_review_events(
          id, task_id, expected_should_reply, reviewer,
          note_ciphertext, decision_sha256, created_at
        ) VALUES (?,?,?,?,?,?,?)`,
      ).run(
        randomUUID(),
        taskId,
        expectedShouldReply ? 1 : 0,
        String(reviewer).trim(),
        this.cipher.encrypt(String(note)),
        fingerprint,
        timestamp,
      );
      this.db.prepare(
      `INSERT INTO decision_reviews(
        id, task_id, expected_should_reply, reviewer,
        note_ciphertext, decision_sha256, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET
        expected_should_reply = excluded.expected_should_reply,
        reviewer = excluded.reviewer,
        note_ciphertext = excluded.note_ciphertext,
        decision_sha256 = excluded.decision_sha256,
        updated_at = excluded.updated_at`,
      ).run(
        randomUUID(),
        taskId,
        expectedShouldReply ? 1 : 0,
        String(reviewer).trim(),
        this.cipher.encrypt(String(note)),
        fingerprint,
        timestamp,
        timestamp,
      );
      return this.listDecisionReviews({ taskId, limit: 1 })[0];
    });
  }

  listDecisionReviews({ taskId, limit = 1_000 } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new Error("Decision review limit must be between 1 and 10000");
    }
    const rows = taskId
      ? this.db.prepare(
          `SELECT r.*, t.result_json, t.payload_json,
                  t.sender_user_id, t.conversation_id
           FROM decision_reviews r
           JOIN tasks t ON t.id = r.task_id
           WHERE r.task_id = ? ORDER BY r.updated_at DESC LIMIT ?`,
        ).all(taskId, limit)
      : this.db.prepare(
          `SELECT r.*, t.result_json, t.payload_json,
                  t.sender_user_id, t.conversation_id
           FROM decision_reviews r
           JOIN tasks t ON t.id = r.task_id
           ORDER BY r.updated_at DESC LIMIT ?`,
        ).all(limit);
    return rows.map((row) => {
      const result = row.result_json
        ? JSON.parse(this.cipher.decrypt(row.result_json))
        : {};
      const payload = row.payload_json
        ? JSON.parse(this.cipher.decrypt(row.payload_json))
        : {};
      return {
        id: row.id,
        taskId: row.task_id,
        expectedShouldReply: Boolean(row.expected_should_reply),
        predictedShouldReply: result.shouldReply,
        riskLevel: result.riskLevel ?? null,
        decisionSource: result.decisionSource ?? null,
        decisionKind: result.decisionKind ?? null,
        decisionSha256: row.decision_sha256 ?? null,
        decisionCurrent:
          row.decision_sha256 != null &&
          row.decision_sha256 === decisionSha256(result),
        senderName: payload.senderName ?? null,
        senderUserId: row.sender_user_id,
        conversationId: row.conversation_id,
        reviewer: row.reviewer,
        note: this.cipher.decrypt(row.note_ciphertext),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  isPaused() {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key = 'paused'").get()
        ?.value === "true"
    );
  }

  setPaused(paused, now = new Date()) {
    this.db
      .prepare(
        `
        INSERT INTO settings(key, value, updated_at) VALUES ('paused', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `,
      )
      .run(String(Boolean(paused)), nowIso(now));
  }

  recordAvailabilitySample(
    ready,
    {
      now = new Date(),
      intervalMs = 60_000,
      retentionMs = 45 * 24 * 60 * 60 * 1000,
    } = {},
  ) {
    const bucket = availabilityBucket(now, intervalMs).toISOString();
    const cutoff = new Date(new Date(now).getTime() - retentionMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO availability_samples(bucket_at, ready, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(bucket_at) DO UPDATE SET
           ready = availability_samples.ready AND excluded.ready`,
      ).run(bucket, Number(Boolean(ready)), nowIso(now));
      this.db.prepare(
        "DELETE FROM availability_samples WHERE bucket_at < ?",
      ).run(cutoff);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return bucket;
  }

  availabilityMetrics({
    now = new Date(),
    intervalMs = 60_000,
    windowMs = 30 * 24 * 60 * 60 * 1000,
  } = {}) {
    const end = availabilityBucket(now, intervalMs);
    const start = new Date(end.getTime() - windowMs);
    const aggregate = this.db.prepare(
      `SELECT COUNT(*) AS sampleCount,
              COALESCE(SUM(ready), 0) AS readyCount,
              MAX(bucket_at) AS lastSampleAt
       FROM availability_samples
       WHERE bucket_at >= ? AND bucket_at < ?`,
    ).get(start.toISOString(), end.toISOString());
    const first = this.db.prepare(
      "SELECT MIN(bucket_at) AS firstTrackedAt FROM availability_samples",
    ).get();
    return buildAvailabilityMetrics({
      sampleCount: Number(aggregate.sampleCount),
      readyCount: Number(aggregate.readyCount),
      firstTrackedAt: first.firstTrackedAt,
      lastSampleAt: aggregate.lastSampleAt,
    }, { now, intervalMs, windowMs });
  }

  operationalMetrics({
    since,
    now = new Date(),
    limit = 10_000,
    availabilityIntervalMs = 60_000,
    availabilityWindowMs = 30 * 24 * 60 * 60 * 1000,
  } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100_000) {
      throw new Error("Operational metrics limit must be between 1 and 100000");
    }
    const start = since instanceof Date ? since.toISOString() : String(since);
    const end = nowIso(now);
    const messageRows = this.db.prepare(
      `SELECT create_time AS occurredAt, ingested_at AS ingestedAt
       FROM messages WHERE ingested_at >= ? AND ingested_at <= ?
       ORDER BY ingested_at DESC LIMIT ?`,
    ).all(start, end, limit + 1);
    const taskRows = this.db.prepare(
      `SELECT * FROM tasks WHERE created_at >= ? AND created_at <= ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(start, end, limit + 1).map((row) => taskFromRow(row, this.cipher));
    const effectRows = this.db.prepare(
      `SELECT task_id AS taskId, capability, status,
              receipt_json IS NOT NULL AS receiptPresent
       FROM side_effects WHERE created_at >= ? AND created_at <= ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(start, end, limit + 1).map((row) => ({
      ...row,
      receiptPresent: Boolean(row.receiptPresent),
    }));
    return buildOperationalMetrics({
      messages: messageRows.slice(0, limit),
      tasks: taskRows.slice(0, limit),
      sideEffects: effectRows.slice(0, limit),
      messageCoverage: this.getCheckpoint(messageCoverageCheckpointKey),
      availability: this.availabilityMetrics({
        now,
        intervalMs: availabilityIntervalMs,
        windowMs: availabilityWindowMs,
      }),
      memoryConflicts: this.memoryConflictMetrics(),
      truncated: {
        messages: messageRows.length > limit,
        tasks: taskRows.length > limit,
        sideEffects: effectRows.length > limit,
      },
    }, { since: start, now });
  }

  health() {
    const taskCounts = Object.fromEntries(
      this.db
        .prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status")
        .all()
        .map((row) => [row.status, Number(row.count)]),
    );
    const checkpoints = this.db
      .prepare(
        "SELECT key, value, updated_at FROM checkpoints ORDER BY updated_at DESC",
      )
      .all();
    const workPlanCounts = Object.fromEntries(
      this.db
        .prepare("SELECT status, COUNT(*) AS count FROM work_plans GROUP BY status")
        .all()
        .map((row) => [row.status, Number(row.count)]),
    );
    const heartbeatRows = this.db
      .prepare("SELECT key, value FROM settings WHERE key LIKE 'heartbeat:%'")
      .all();
    return {
      paused: this.isPaused(),
      tasks: taskCounts,
      workPlans: workPlanCounts,
      expiredExecutionLeases: Number(
        this.db.prepare(
          `SELECT COUNT(*) AS count FROM work_plans
           WHERE status IN ('executing','verifying')
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        ).get(nowIso()).count,
      ),
      pendingMessages: Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM messages WHERE status = 'pending'",
          )
          .get().count,
      ),
      checkpoints,
      heartbeats: Object.fromEntries(
        heartbeatRows.map((row) => [row.key.slice("heartbeat:".length), row.value]),
      ),
    };
  }

  purgeCompleted({ before }) {
    const timestamp = before instanceof Date ? before.toISOString() : String(before);
    return this.transaction(() => {
      const taskRows = this.db
        .prepare(
          `
          SELECT id FROM tasks
          WHERE status IN (
            'completed', 'no_reply', 'rejected', 'cancelled_manual',
            'cancelled_operator', 'expired'
          )
            AND updated_at < ?
        `,
        )
        .all(timestamp);
      const deleteMessages = this.db.prepare(
        "DELETE FROM messages WHERE task_id = ?",
      );
      const deleteEffects = this.db.prepare(
        "DELETE FROM side_effects WHERE task_id = ?",
      );
      const deleteApprovals = this.db.prepare(
        "DELETE FROM approvals WHERE task_id = ?",
      );
      const deleteTask = this.db.prepare("DELETE FROM tasks WHERE id = ?");
      for (const { id } of taskRows) {
        deleteMessages.run(id);
        deleteEffects.run(id);
        deleteApprovals.run(id);
        deleteTask.run(id);
      }
      return taskRows.length;
    });
  }
}
