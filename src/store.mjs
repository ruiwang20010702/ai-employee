import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { DataCipher } from "./crypto.mjs";

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
    `);
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
        const messages = selectMessages.all(
          group.conversation_id,
          group.sender_user_id,
        );
        if (messages.length === 0) continue;
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

  completeDraft(taskId, draft, now = new Date()) {
    const status = draft.shouldReply ? "awaiting_approval" : "no_reply";
    this.db
      .prepare(
        `
        UPDATE tasks
        SET status = ?, result_json = ?, lease_until = NULL,
            last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing'
      `,
      )
      .run(
        status,
        this.cipher.encrypt(JSON.stringify(draft)),
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
          SET status = ?, approved_at = ?, approved_by = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(decision, decision === "approved" ? timestamp : null, actor, timestamp, taskId);
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
          WHERE status = 'approved'
             OR (status = 'sending' AND lease_until <= ?)
          ORDER BY approved_at
          LIMIT 1
        `,
        )
        .get(timestamp);
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
      if (existing) return existing;
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
      return this.db
        .prepare("SELECT * FROM side_effects WHERE idempotency_key = ?")
        .get(key);
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

  returnApprovedTask(taskId, reason, now = new Date()) {
    this.db
      .prepare(
        `
        UPDATE tasks SET status = 'approved', lease_until = NULL,
            last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'sending'
      `,
      )
      .run(this.cipher.encrypt(reason), nowIso(now), taskId);
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

  getTask(taskId) {
    return taskFromRow(
      this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId),
      this.cipher,
    );
  }

  listTasks({ limit = 50, status } = {}) {
    const rows = status
      ? this.db
          .prepare(
            "SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(status, limit)
      : this.db
          .prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?")
          .all(limit);
    return rows.map((row) => taskFromRow(row, this.cipher));
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
    return {
      paused: this.isPaused(),
      tasks: taskCounts,
      pendingMessages: Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM messages WHERE status = 'pending'",
          )
          .get().count,
      ),
      checkpoints,
    };
  }

  purgeCompleted({ before }) {
    const timestamp = before instanceof Date ? before.toISOString() : String(before);
    return this.transaction(() => {
      const taskRows = this.db
        .prepare(
          `
          SELECT id FROM tasks
          WHERE status IN ('completed', 'no_reply', 'rejected', 'cancelled_manual')
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
