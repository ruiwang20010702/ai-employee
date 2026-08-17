import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { DataCipher } from "./crypto.mjs";
import {
  capabilityBudgetSnapshot,
  normalizeCapabilityBudget,
} from "./capability-budget.mjs";
import {
  shouldFlushMessageBundleEarly,
  splitMessageBursts,
} from "./message-bundling.mjs";
import { memoryIsUsable, validateMemoryProposal } from "./memory-policy.mjs";
import { assertWorkPlanMemoryEvidence } from "./work-evidence.mjs";
import { validateAutomaticMemoryProposal } from "./memory-candidate.mjs";
import {
  historicalMemoryId,
  validateHistoricalMemoryProposals,
} from "./historical-memory.mjs";
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
  buildConfirmedShadowTimeReturn,
  buildTimeReturnProposal,
} from "./time-return.mjs";
import { nextScheduledRun, validateWorkTrigger } from "./work-trigger.mjs";
import { buildGraphProjection } from "./governed-work-graph.mjs";
import {
  buildPrivacyErasurePreview,
  erasableTaskStatuses,
  erasableWorkPlanStatuses,
  privacySelectorFingerprint,
  validatePrivacySelector,
} from "./privacy-erasure.mjs";

const projectRoot = new URL("../", import.meta.url);
const foursdayDatabaseUrl = new URL(".runtime/foursday.sqlite", projectRoot);
const legacyDatabaseUrl = new URL(".runtime/ai-employee.sqlite", projectRoot);
const defaultDatabaseUrl = existsSync(fileURLToPath(legacyDatabaseUrl))
  ? legacyDatabaseUrl
  : foursdayDatabaseUrl;

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
    capability_budget: row.capability_budget_ciphertext
      ? JSON.parse(cipher.decrypt(row.capability_budget_ciphertext))
      : null,
    requester_ciphertext: undefined,
    objective_ciphertext: undefined,
    plan_ciphertext: undefined,
    capability_budget_ciphertext: undefined,
  };
}

function timeReturnFromRow(row, cipher) {
  if (!row) return null;
  return {
    id: row.id,
    workPlanId: row.work_plan_id,
    sourceType: "work_plan",
    sourceId: row.work_plan_id,
    projectId: row.project_id,
    recipeId: row.recipe_id,
    baselineMinutes: row.baseline_minutes,
    humanActiveMinutes: row.human_active_minutes,
    returnedMinutes: row.returned_minutes,
    baselineMethod: row.baseline_method,
    outcomeEvidence: JSON.parse(cipher.decrypt(row.outcome_evidence_ciphertext)),
    status: row.status,
    proposedBy: row.proposed_by,
    confirmedBy: row.confirmed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.status === "confirmed" ? row.updated_at : null,
  };
}

function shadowTimeReturnFromRow(row, cipher) {
  if (!row) return null;
  return {
    id: row.id,
    workPlanId: null,
    sourceType: "shadow_evidence",
    sourceId: row.evidence_sha256,
    projectId: row.project_id,
    recipeId: row.recipe_id,
    planHash: row.plan_hash,
    repositoryCommit: row.repository_commit,
    baselineMinutes: row.baseline_minutes,
    humanActiveMinutes: row.human_active_minutes,
    returnedMinutes: row.returned_minutes,
    baselineMethod: row.baseline_method,
    outcomeEvidence: JSON.parse(cipher.decrypt(row.outcome_evidence_ciphertext)),
    status: "confirmed",
    proposedBy: row.confirmed_by,
    confirmedBy: row.confirmed_by,
    createdAt: row.imported_at,
    updatedAt: row.confirmed_at,
    confirmedAt: row.confirmed_at,
  };
}

function graphPayload(ciphertext, cipher) {
  return JSON.parse(cipher.decrypt(ciphertext));
}

function graphNodeRevisionPayload(node) {
  const { observedAt: _observedAt, ...revision } = node;
  return revision;
}

function sameGraphNodeRevision(left, right) {
  return JSON.stringify(graphNodeRevisionPayload(left)) ===
    JSON.stringify(graphNodeRevisionPayload(right));
}

function graphLimit(value) {
  const limit = Number(value ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Graph query limit must be between 1 and 500");
  }
  return limit;
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

      CREATE TABLE IF NOT EXISTS privacy_erased_messages (
        message_key TEXT PRIMARY KEY,
        erased_at TEXT NOT NULL
      );

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
        privacy_erased_at TEXT,
        continuation_of_task_id TEXT,
        waiting_information_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(continuation_of_task_id) REFERENCES tasks(id) ON DELETE SET NULL
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
        source_access_status TEXT NOT NULL DEFAULT 'not_required',
        source_access_reason TEXT,
        source_access_checked_at TEXT,
        source_access_expires_at TEXT,
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
        authorization_hash TEXT,
        capability_budget_ciphertext TEXT,
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
        privacy_erased_at TEXT,
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
      CREATE TABLE IF NOT EXISTS time_return_entries (
        id TEXT PRIMARY KEY,
        work_plan_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        recipe_id TEXT NOT NULL,
        baseline_minutes INTEGER NOT NULL CHECK(baseline_minutes BETWEEN 1 AND 2400),
        human_active_minutes INTEGER NOT NULL CHECK(human_active_minutes BETWEEN 0 AND baseline_minutes),
        returned_minutes INTEGER NOT NULL CHECK(returned_minutes = baseline_minutes - human_active_minutes),
        baseline_method TEXT NOT NULL CHECK(baseline_method IN ('measured','user_confirmed')),
        outcome_evidence_ciphertext TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('proposed','confirmed','rejected')),
        proposed_by TEXT NOT NULL,
        confirmed_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(work_plan_id) REFERENCES work_plans(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS time_return_entries_project
      ON time_return_entries(project_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS shadow_time_return_entries (
        id TEXT PRIMARY KEY,
        evidence_sha256 TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        recipe_id TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        repository_commit TEXT NOT NULL,
        baseline_minutes INTEGER NOT NULL CHECK(baseline_minutes BETWEEN 1 AND 2400),
        human_active_minutes INTEGER NOT NULL CHECK(human_active_minutes BETWEEN 0 AND baseline_minutes),
        returned_minutes INTEGER NOT NULL CHECK(returned_minutes = baseline_minutes - human_active_minutes),
        baseline_method TEXT NOT NULL CHECK(baseline_method IN ('measured','user_confirmed')),
        outcome_evidence_ciphertext TEXT NOT NULL,
        confirmed_by TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shadow_time_return_entries_project
      ON shadow_time_return_entries(project_id, confirmed_at DESC);
      CREATE TABLE IF NOT EXISTS work_triggers (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('schedule','event')),
        status TEXT NOT NULL CHECK(status IN ('enabled','disabled')),
        definition_ciphertext TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS work_triggers_due
      ON work_triggers(status, next_run_at) WHERE kind = 'schedule';
      CREATE TABLE IF NOT EXISTS work_trigger_runs (
        trigger_id TEXT NOT NULL,
        run_key TEXT NOT NULL,
        work_plan_id TEXT,
        owner TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('claimed','completed','failed')),
        error_ciphertext TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(trigger_id, run_key),
        FOREIGN KEY(trigger_id) REFERENCES work_triggers(id) ON DELETE CASCADE,
        FOREIGN KEY(work_plan_id) REFERENCES work_plans(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS governed_graph_nodes (
        tenant_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        node_key TEXT NOT NULL,
        project_id TEXT NOT NULL,
        graph_version INTEGER NOT NULL CHECK(graph_version = 1),
        node_type TEXT NOT NULL,
        revision TEXT NOT NULL,
        payload_ciphertext TEXT NOT NULL,
        sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public','internal','confidential')),
        expires_at TEXT,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, node_id),
        UNIQUE(tenant_id, project_id, node_key, revision)
      );
      CREATE INDEX IF NOT EXISTS governed_graph_nodes_project_type
      ON governed_graph_nodes(tenant_id, project_id, node_type, observed_at DESC);
      CREATE TABLE IF NOT EXISTS governed_graph_edges (
        tenant_id TEXT NOT NULL,
        edge_id TEXT NOT NULL,
        relation_key TEXT NOT NULL,
        project_id TEXT NOT NULL,
        graph_version INTEGER NOT NULL CHECK(graph_version = 1),
        edge_type TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('intended','runtime')),
        from_node_id TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        authorization_hash TEXT,
        payload_ciphertext TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','invalidated')),
        sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public','internal','confidential')),
        expires_at TEXT,
        valid_from TEXT NOT NULL,
        invalidated_at TEXT,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, edge_id),
        FOREIGN KEY(tenant_id, from_node_id)
          REFERENCES governed_graph_nodes(tenant_id, node_id),
        FOREIGN KEY(tenant_id, to_node_id)
          REFERENCES governed_graph_nodes(tenant_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS governed_graph_edges_project_type
      ON governed_graph_edges(tenant_id, project_id, edge_type, phase, observed_at DESC);
      CREATE INDEX IF NOT EXISTS governed_graph_edges_relation
      ON governed_graph_edges(tenant_id, project_id, relation_key, observed_at DESC);
      CREATE INDEX IF NOT EXISTS governed_graph_edges_from
      ON governed_graph_edges(tenant_id, project_id, from_node_id, observed_at DESC);
      CREATE INDEX IF NOT EXISTS governed_graph_edges_to
      ON governed_graph_edges(tenant_id, project_id, to_node_id, observed_at DESC);
    `);
    const workTriggerRunColumns = new Set(
      this.db.prepare("PRAGMA table_info(work_trigger_runs)").all().map((row) => row.name),
    );
    if (!workTriggerRunColumns.has("owner")) {
      this.db.exec("ALTER TABLE work_trigger_runs ADD COLUMN owner TEXT NOT NULL DEFAULT 'legacy'");
    }
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
    if (!taskColumns.has("privacy_erased_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN privacy_erased_at TEXT");
    }
    if (!taskColumns.has("continuation_of_task_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN continuation_of_task_id TEXT");
    }
    if (!taskColumns.has("waiting_information_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN waiting_information_at TEXT");
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS tasks_waiting_information_at
       ON tasks(conversation_id, sender_user_id, waiting_information_at DESC)
       WHERE status = 'waiting_information'`,
    );
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
    if (!workPlanColumns.has("privacy_erased_at")) {
      this.db.exec("ALTER TABLE work_plans ADD COLUMN privacy_erased_at TEXT");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!workPlanColumns.has("authorization_hash")) {
        this.db.exec("ALTER TABLE work_plans ADD COLUMN authorization_hash TEXT");
      }
      if (!workPlanColumns.has("capability_budget_ciphertext")) {
        this.db.exec("ALTER TABLE work_plans ADD COLUMN capability_budget_ciphertext TEXT");
      }
      const unsafeLegacyPlan = this.db.prepare(
        `SELECT id FROM work_plans
         WHERE status IN ('executing', 'verifying')
           AND (authorization_hash IS NULL OR capability_budget_ciphertext IS NULL)
         LIMIT 1`,
      ).get();
      if (unsafeLegacyPlan) {
        throw new Error(
          "Cannot migrate capability budgets while legacy work plans are executing",
        );
      }
      const migrationTimestamp = nowIso();
      const migrationError = this.cipher.encrypt(
        "Cancelled by system:migration-018 because capability-budget authorization is missing",
      );
      this.db.prepare(
        `UPDATE work_plan_steps
         SET status = 'cancelled', error_ciphertext = COALESCE(error_ciphertext, ?),
             completed_at = ?, updated_at = ?
         WHERE status = 'pending'
           AND work_plan_id IN (
             SELECT id FROM work_plans
             WHERE status IN ('ready', 'awaiting_approval', 'approved')
               AND (authorization_hash IS NULL OR capability_budget_ciphertext IS NULL)
           )`,
      ).run(migrationError, migrationTimestamp, migrationTimestamp);
      this.db.prepare(
        `UPDATE work_plans
         SET status = 'cancelled',
             cancel_requested_at = COALESCE(cancel_requested_at, ?),
             cancel_requested_by = COALESCE(cancel_requested_by, 'system:migration-018'),
             updated_at = ?
         WHERE status IN ('ready', 'awaiting_approval', 'approved')
           AND (authorization_hash IS NULL OR capability_budget_ciphertext IS NULL)`,
      ).run(migrationTimestamp, migrationTimestamp);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS capability_budget_usage (
          project_key TEXT NOT NULL,
          project_id_ciphertext TEXT NOT NULL,
          authorization_hash TEXT NOT NULL,
          capability TEXT NOT NULL,
          limit_count INTEGER NOT NULL CHECK(limit_count > 0),
          used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(project_key, authorization_hash, capability)
        );
      `);
      const capabilityBudgetColumns = new Set(
        this.db.prepare("PRAGMA table_info(capability_budget_usage)").all()
          .map((row) => row.name),
      );
      if (
        capabilityBudgetColumns.has("project_id") &&
        !capabilityBudgetColumns.has("project_key")
      ) {
        const legacyRows = this.db.prepare(
          "SELECT * FROM capability_budget_usage",
        ).all();
        this.db.exec(`
          ALTER TABLE capability_budget_usage
          RENAME TO capability_budget_usage_legacy;
          CREATE TABLE capability_budget_usage (
            project_key TEXT NOT NULL,
            project_id_ciphertext TEXT NOT NULL,
            authorization_hash TEXT NOT NULL,
            capability TEXT NOT NULL,
            limit_count INTEGER NOT NULL CHECK(limit_count > 0),
            used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count >= 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(project_key, authorization_hash, capability)
          );
        `);
        const migrateBudget = this.db.prepare(
          `INSERT INTO capability_budget_usage(
             project_key, project_id_ciphertext, authorization_hash,
             capability, limit_count, used_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const row of legacyRows) {
          migrateBudget.run(
            this.cipher.fingerprint(row.project_id),
            this.cipher.encrypt(row.project_id),
            row.authorization_hash,
            row.capability,
            row.limit_count,
            row.used_count,
            row.created_at,
            row.updated_at,
          );
        }
        this.db.exec("DROP TABLE capability_budget_usage_legacy");
      }
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS work_plans_capability_budget_insert_guard
        BEFORE INSERT ON work_plans
        WHEN NEW.status IN (
          'ready', 'awaiting_approval', 'approved', 'executing', 'verifying'
        ) AND (
          NEW.authorization_hash IS NULL
          OR NEW.capability_budget_ciphertext IS NULL
        )
        BEGIN
          SELECT RAISE(
            ABORT,
            'work plan capability budget authorization is required'
          );
        END;

        CREATE TRIGGER IF NOT EXISTS work_plans_capability_budget_update_guard
        BEFORE UPDATE OF status, authorization_hash, capability_budget_ciphertext
        ON work_plans
        WHEN NEW.status IN (
          'ready', 'awaiting_approval', 'approved', 'executing', 'verifying'
        ) AND (
          NEW.authorization_hash IS NULL
          OR NEW.capability_budget_ciphertext IS NULL
        )
        BEGIN
          SELECT RAISE(
            ABORT,
            'work plan capability budget authorization is required'
          );
        END;
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      this.db = null;
      throw error;
    }
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS work_plans_single_revision_idx
       ON work_plans(supersedes_work_plan_id)
       WHERE supersedes_work_plan_id IS NOT NULL`,
    );
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
    const wasErased = this.db.prepare(
      "SELECT 1 FROM privacy_erased_messages WHERE message_key = ?",
    );
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
        if (wasErased.get(this.cipher.fingerprint(`message:${message.id}`))) {
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

  nextPendingBundleAt({ quietWindowMs, bundleMaxWaitMs = 8_000, now = new Date() }) {
    if (
      !Number.isFinite(quietWindowMs) ||
      quietWindowMs <= 0 ||
      !Number.isFinite(bundleMaxWaitMs) ||
      bundleMaxWaitMs > 8_000 ||
      bundleMaxWaitMs < quietWindowMs
    ) {
      throw new Error("Pending bundle timing configuration is invalid");
    }
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) throw new Error("Pending bundle current time is invalid");
    const row = this.db.prepare(
      `WITH pending_groups AS (
         SELECT MIN(ingested_at) AS first_ingested,
                MAX(ingested_at) AS last_ingested,
                conversation_id,
                sender_user_id
         FROM messages
         WHERE status = 'pending'
         GROUP BY conversation_id, sender_user_id
       ), deadlines AS (
         SELECT first_ingested, last_ingested,
                MIN(
                  (julianday(first_ingested) - 2440587.5) * 86400000 + ?,
                  (julianday(last_ingested) - 2440587.5) * 86400000 + ?
                ) AS deadline_ms,
                EXISTS(
                  SELECT 1 FROM tasks
                  WHERE tasks.status = 'continuation_pending'
                    AND tasks.conversation_id = pending_groups.conversation_id
                    AND tasks.sender_user_id = pending_groups.sender_user_id
                ) AS continuation_blocked
         FROM pending_groups
       )
       SELECT first_ingested, last_ingested, deadline_ms, continuation_blocked
       FROM deadlines
       ORDER BY CASE
         WHEN continuation_blocked = 1 AND deadline_ms <= ? THEN ?
         ELSE deadline_ms
       END
       LIMIT 1`,
    ).get(bundleMaxWaitMs, quietWindowMs, nowMs, nowMs + 1_000);
    if (!row) return null;
    const first = new Date(row.first_ingested).getTime();
    const last = new Date(row.last_ingested).getTime();
    if (!Number.isFinite(first) || !Number.isFinite(last)) {
      throw new Error("Pending bundle timestamps are invalid");
    }
    const deadline = Math.min(first + bundleMaxWaitMs, last + quietWindowMs);
    return new Date(
      row.continuation_blocked && deadline <= nowMs
        ? nowMs + 1_000
        : deadline,
    );
  }

  createReadyTasks({
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
    const cutoff = new Date(now.getTime() - quietWindowMs).toISOString();
    const maximumWaitCutoff = new Date(
      now.getTime() - bundleMaxWaitMs,
    ).toISOString();
    const waitingCutoff = new Date(
      now.getTime() - waitingInformationTtlMs,
    ).toISOString();
    const groups = this.db
      .prepare(
        `
        SELECT * FROM (
          SELECT conversation_id, sender_user_id,
                 MIN(ingested_at) AS first_ingested,
                 MAX(ingested_at) AS last_ingested
          FROM messages
          WHERE status = 'pending'
          GROUP BY conversation_id, sender_user_id
        ) pending_groups
        ORDER BY MIN(
          (julianday(first_ingested) - 2440587.5) * 86400000 + ?,
          (julianday(last_ingested) - 2440587.5) * 86400000 + ?
        )
        LIMIT 500
      `,
      )
      .all(bundleMaxWaitMs, quietWindowMs);
    const created = [];

    this.transaction(() => {
      this.db.prepare(
        `UPDATE tasks
         SET status = 'expired', updated_at = ?
         WHERE status = 'waiting_information'
           AND COALESCE(waiting_information_at, updated_at) < ?`,
      ).run(nowIso(now), waitingCutoff);
      const selectMessages = this.db.prepare(`
        SELECT * FROM messages
        WHERE status = 'pending'
          AND conversation_id = ?
          AND sender_user_id = ?
        ORDER BY create_time, id
      `);
      const selectLatestMessage = this.db.prepare(`
        SELECT content FROM messages
        WHERE status = 'pending'
          AND conversation_id = ?
          AND sender_user_id = ?
        ORDER BY ingested_at DESC, create_time DESC, id DESC
        LIMIT 1
      `);
      const insertTask = this.db.prepare(`
        INSERT OR IGNORE INTO tasks (
          id, kind, status, sender_user_id, conversation_id, payload_json,
          max_attempts, continuation_of_task_id,
          available_at, created_at, updated_at
        ) VALUES (?, 'reply', 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const selectWaitingTask = this.db.prepare(`
        SELECT id, payload_json, result_json,
               COALESCE(waiting_information_at, updated_at) AS waiting_at
        FROM tasks
        WHERE status = 'waiting_information'
          AND conversation_id = ?
          AND sender_user_id = ?
          AND COALESCE(waiting_information_at, updated_at) >= ?
        ORDER BY COALESCE(waiting_information_at, updated_at) DESC, id DESC
        LIMIT 2
      `);
      const hasContinuationPending = this.db.prepare(`
        SELECT 1
        FROM tasks
        WHERE status = 'continuation_pending'
          AND conversation_id = ?
          AND sender_user_id = ?
        LIMIT 1
      `);
      const reserveWaitingTask = this.db.prepare(`
        UPDATE tasks
        SET status = 'continuation_pending', updated_at = ?
        WHERE id = ? AND status = 'waiting_information'
      `);
      const markBundled = this.db.prepare(`
        UPDATE messages SET status = 'bundled', task_id = ?
        WHERE id = ? AND status = 'pending'
      `);

      for (const group of groups) {
        const timingReady = group.last_ingested <= cutoff ||
          group.first_ingested <= maximumWaitCutoff;
        if (!timingReady) {
          const latest = selectLatestMessage.get(
            group.conversation_id,
            group.sender_user_id,
          );
          if (!latest) continue;
          const content = this.cipher.decrypt(latest.content);
          if (!shouldFlushMessageBundleEarly([{ content }])) continue;
        }
        if (hasContinuationPending.get(
          group.conversation_id,
          group.sender_user_id,
        )) {
          continue;
        }
        const pendingMessages = selectMessages.all(
          group.conversation_id,
          group.sender_user_id,
        );
        if (pendingMessages.length === 0) continue;
        const waitingRows = selectWaitingTask.all(
          group.conversation_id,
          group.sender_user_id,
          waitingCutoff,
        );
        let waitingTask = waitingRows.length === 1
          ? {
              id: waitingRows[0].id,
              payload: JSON.parse(this.cipher.decrypt(waitingRows[0].payload_json)),
              result: waitingRows[0].result_json
                ? JSON.parse(this.cipher.decrypt(waitingRows[0].result_json))
                : null,
              waitingAt: waitingRows[0].waiting_at,
            }
          : null;
        const bursts = splitMessageBursts(pendingMessages, {
          gapMs: bundleGapMs,
          maxMessages: maxMessagesPerTask,
          boundaryAt: waitingTask?.waitingAt ?? null,
        });
        for (const messages of bursts) {
          const firstMessageAt = new Date(messages[0].create_time).getTime();
          const waitingAt = waitingTask
            ? new Date(waitingTask.waitingAt).getTime()
            : null;
          const continuationTask = waitingTask &&
            Number.isFinite(firstMessageAt) &&
            Number.isFinite(waitingAt) &&
            firstMessageAt > waitingAt
            ? waitingTask
            : null;
          const reservesWaitingTask = Boolean(continuationTask);
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
            waitingTask: continuationTask
              ? {
                  originalRequest: String(continuationTask.payload?.content ?? "").slice(0, 4_000),
                  clarificationQuestion: String(continuationTask.result?.reply ?? "").slice(0, 1_000),
                  waitingAt: continuationTask.waitingAt,
                }
              : null,
          };
          const timestamp = nowIso(now);
          const result = insertTask.run(
            taskId,
            group.sender_user_id,
            group.conversation_id,
            this.cipher.encrypt(JSON.stringify(payload)),
            maxAttempts,
            continuationTask?.id ?? null,
            timestamp,
            timestamp,
            timestamp,
          );
          if (result.changes === 0) continue;
          if (continuationTask) {
            const reserved = reserveWaitingTask.run(timestamp, continuationTask.id);
            if (reserved.changes !== 1) {
              throw new Error("Waiting task could not be reserved");
            }
            waitingTask = null;
          }
          for (const message of messages) markBundled.run(taskId, message.id);
          created.push(taskId);
          if (reservesWaitingTask) break;
        }
      }
    });
    return created;
  }

  claimTask({ leaseMs = 120_000, now = new Date() } = {}) {
    return this.transaction(() => {
      const timestamp = nowIso(now);
      const exhausted = this.db.prepare(
        `SELECT id, continuation_of_task_id FROM tasks
         WHERE status = 'processing' AND lease_until <= ? AND attempts >= max_attempts`,
      ).all(timestamp);
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
      const restoreWaitingTask = this.db.prepare(
        `UPDATE tasks SET status = 'waiting_information', updated_at = ?
         WHERE id = ? AND status = 'continuation_pending'`,
      );
      for (const task of exhausted) {
        if (task.continuation_of_task_id) {
          restoreWaitingTask.run(timestamp, task.continuation_of_task_id);
        }
      }
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

  completeDraft(
    taskId,
    draft,
    now = new Date(),
    { supersedeWindowMs = 0 } = {},
  ) {
    if (
      !Number.isFinite(supersedeWindowMs) ||
      supersedeWindowMs < 0 ||
      supersedeWindowMs > 10 * 60 * 1_000
    ) {
      throw new Error("Draft supersede window must be between 0 and 600000 ms");
    }
    const status = draft.shouldReply ? "awaiting_approval" : "no_reply";
    return this.transaction(() => {
      const task = this.db.prepare(
        `SELECT continuation_of_task_id, sender_user_id, conversation_id, created_at
         FROM tasks WHERE id = ? AND status = 'processing'`,
      ).get(taskId);
      if (!task) throw new Error(`Task is not processing: ${taskId}`);
      if (draft.relatedToWaitingTask && !task.continuation_of_task_id) {
        throw new Error("Draft cannot continue a missing waiting task");
      }
      const episodeEnabled =
        supersedeWindowMs > 0 && task.continuation_of_task_id == null;
      const episodeStart = episodeEnabled
        ? new Date(new Date(task.created_at).getTime() - supersedeWindowMs).toISOString()
        : null;
      const episodeEnd = episodeEnabled
        ? new Date(new Date(task.created_at).getTime() + supersedeWindowMs).toISOString()
        : null;
      const newerTask = episodeEnabled && draft.shouldReply
        ? this.db.prepare(
          `SELECT id FROM tasks
           WHERE id <> ? AND sender_user_id = ? AND conversation_id = ?
             AND continuation_of_task_id IS NULL
             AND created_at > ? AND created_at <= ?
             AND status IN ('queued','processing','awaiting_approval','no_reply')
           ORDER BY created_at DESC LIMIT 1`,
        ).get(
          taskId,
          task.sender_user_id,
          task.conversation_id,
          task.created_at,
          episodeEnd,
        )
        : null;
      const finalStatus = newerTask ? "expired" : status;
      const result = this.db
        .prepare(
        `
        UPDATE tasks
        SET status = ?, result_json = ?, draft_ready_at = ?, lease_until = NULL,
            last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing'
      `,
      )
      .run(
        finalStatus,
        this.cipher.encrypt(JSON.stringify(draft)),
        nowIso(now),
        nowIso(now),
        taskId,
      );
      if (result.changes !== 1) throw new Error(`Task is not processing: ${taskId}`);
      const supersededTaskIds = [];
      if (episodeEnabled && !newerTask) {
        const previous = this.db.prepare(
          `SELECT id FROM tasks
           WHERE id <> ? AND sender_user_id = ? AND conversation_id = ?
             AND continuation_of_task_id IS NULL
             AND created_at >= ? AND created_at < ?
             AND status = 'awaiting_approval'
           ORDER BY created_at`,
        ).all(
          taskId,
          task.sender_user_id,
          task.conversation_id,
          episodeStart,
          task.created_at,
        );
        for (const previousTask of previous) {
          const expired = this.db.prepare(
            `UPDATE tasks SET status = 'expired', updated_at = ?
             WHERE id = ? AND status = 'awaiting_approval'`,
          ).run(nowIso(now), previousTask.id);
          if (expired.changes !== 1) continue;
          supersededTaskIds.push(previousTask.id);
          this._cancelWorkPlansForSourceTask(
            previousTask.id,
            now,
            "system:conversation-followup",
          );
        }
      }
      if (task.continuation_of_task_id) {
        const hasPendingFollowup = draft.relatedToWaitingTask && this.db.prepare(
          `SELECT 1 FROM messages
           WHERE status = 'pending'
             AND sender_user_id = ? AND conversation_id = ?
           LIMIT 1`,
        ).get(task.sender_user_id, task.conversation_id);
        const parentStatus = draft.decisionKind === "manual_reply"
          ? "cancelled_manual"
          : draft.relatedToWaitingTask
            ? hasPendingFollowup
              ? "waiting_information"
              : "continued"
            : "waiting_information";
        const parent = this.db.prepare(
          `UPDATE tasks SET status = ?, updated_at = ?
           WHERE id = ? AND status = 'continuation_pending'`,
        ).run(parentStatus, nowIso(now), task.continuation_of_task_id);
        if (parent.changes !== 1) {
          throw new Error("Waiting task continuation is no longer available");
        }
      }
      return { status: finalStatus, supersededTaskIds };
    });
  }

  failTask(taskId, error, now = new Date()) {
    return this.transaction(() => {
      const task = this.db
        .prepare("SELECT status, attempts, max_attempts, continuation_of_task_id FROM tasks WHERE id = ?")
        .get(taskId);
      if (!task) return null;
      if (task.status !== "processing") return task.status;
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
          WHERE id = ? AND status = 'processing'
        `,
        )
        .run(
          status,
          availableAt,
          this.cipher.encrypt(String(error?.message ?? error)),
          nowIso(now),
          taskId,
        );
      if (dead && task.continuation_of_task_id) {
        this.db.prepare(
          `UPDATE tasks SET status = 'waiting_information', updated_at = ?
           WHERE id = ? AND status = 'continuation_pending'`,
        ).run(nowIso(now), task.continuation_of_task_id);
      }
      return status;
    });
  }

  decideTask(taskId, { decision, actor, reason = "" }, now = new Date()) {
    if (!["approved", "rejected"].includes(decision)) {
      throw new Error("decision must be approved or rejected");
    }
    return this.transaction(() => {
      const task = this.db
        .prepare("SELECT status, result_json FROM tasks WHERE id = ?")
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
      const task = this.db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(taskId);
      if (task?.status !== "sending") {
        throw new Error("Task is not sending");
      }
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
      const task = this.db.prepare(
        "SELECT result_json FROM tasks WHERE id = ? AND status = 'sending'",
      ).get(taskId);
      if (!task) throw new Error("Task is not sending");
      const draft = task.result_json
        ? JSON.parse(this.cipher.decrypt(task.result_json))
        : null;
      const taskStatus = draft?.needsInformation
        ? "waiting_information"
        : "completed";
      const effect = this.db
        .prepare(
          `
          UPDATE side_effects
          SET status = 'completed', receipt_json = ?, last_error = NULL, updated_at = ?
          WHERE idempotency_key = ?
        `,
        )
        .run(this.cipher.encrypt(JSON.stringify(receipt)), nowIso(now), key);
      if (effect.changes !== 1) {
        throw new Error("Side effect was not started");
      }
      this.db
        .prepare(
          `
          UPDATE tasks
          SET status = ?, waiting_information_at = ?,
              lease_until = NULL, updated_at = ?
          WHERE id = ?
        `,
      )
        .run(
          taskStatus,
          taskStatus === "waiting_information" ? nowIso(now) : null,
          nowIso(now),
          taskId,
        );
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

  _cancelWorkPlansForSourceTask(
    taskId,
    now = new Date(),
    actor = "system:manual-reply",
  ) {
    const timestamp = nowIso(now);
    const rows = this.db.prepare(
      `SELECT id, status, plan_ciphertext FROM work_plans
       WHERE privacy_erased_at IS NULL
         AND status IN ('ready','awaiting_approval','approved','executing','verifying')`,
    ).all();
    let cancelled = 0;
    let cancellationRequested = 0;
    for (const row of rows) {
      let sourceTaskId;
      try {
        sourceTaskId = JSON.parse(
          this.cipher.decrypt(row.plan_ciphertext),
        )?.sourceTaskId;
      } catch {
        continue;
      }
      if (sourceTaskId !== taskId) continue;
      if (["ready", "awaiting_approval", "approved"].includes(row.status)) {
        this.db.prepare(
          `UPDATE work_plan_steps SET status = 'cancelled',
           completed_at = ?, updated_at = ?
           WHERE work_plan_id = ? AND status = 'pending'`,
        ).run(timestamp, timestamp, row.id);
        this.db.prepare(
          `UPDATE work_plans SET status = 'cancelled',
           cancel_requested_at = ?, cancel_requested_by = ?, updated_at = ?
           WHERE id = ? AND status IN ('ready','awaiting_approval','approved')`,
        ).run(timestamp, actor, timestamp, row.id);
        cancelled += 1;
      } else {
        this.db.prepare(
          `UPDATE work_plans
           SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
               cancel_requested_by = COALESCE(cancel_requested_by, ?),
               updated_at = ?
           WHERE id = ? AND status IN ('executing','verifying')`,
        ).run(timestamp, actor, timestamp, row.id);
        cancellationRequested += 1;
      }
    }
    return { cancelled, cancellationRequested };
  }

  cancelForManualReply(taskId, now = new Date()) {
    return this.transaction(() => {
      const task = this.db.prepare(
        "SELECT continuation_of_task_id, result_json FROM tasks WHERE id = ?",
      ).get(taskId);
      const result = this.db
        .prepare(
        `
        UPDATE tasks
        SET status = 'cancelled_manual', lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending'
      `,
      )
      .run(nowIso(now), taskId);
      if (result.changes === 1 && task?.continuation_of_task_id) {
        const draft = task.result_json
          ? JSON.parse(this.cipher.decrypt(task.result_json))
          : null;
        if (draft?.relatedToWaitingTask) {
          this.db.prepare(
            `UPDATE tasks SET status = 'cancelled_manual', updated_at = ?
             WHERE id = ? AND status = 'continued'`,
          ).run(nowIso(now), task.continuation_of_task_id);
        } else {
          this.db.prepare(
            `UPDATE tasks SET status = 'cancelled_manual', updated_at = ?
             WHERE id = ? AND status = 'continuation_pending'`,
          ).run(nowIso(now), task.continuation_of_task_id);
        }
      }
      this._cancelWorkPlansForSourceTask(taskId, now);
      return result.changes === 1;
    });
  }

  cancelDraftForManualReply(taskId, now = new Date()) {
    return this.transaction(() => {
      const task = this.db.prepare(
        "SELECT continuation_of_task_id, result_json FROM tasks WHERE id = ?",
      ).get(taskId);
      const result = this.db
        .prepare(
        `
        UPDATE tasks
        SET status = 'cancelled_manual', updated_at = ?
        WHERE id = ? AND status IN (
          'processing', 'awaiting_approval', 'waiting_information'
        )
      `,
      )
      .run(nowIso(now), taskId);
      if (result.changes === 1 && task?.continuation_of_task_id) {
        const draft = task.result_json
          ? JSON.parse(this.cipher.decrypt(task.result_json))
          : null;
        if (draft?.relatedToWaitingTask) {
          this.db.prepare(
            `UPDATE tasks SET status = 'cancelled_manual', updated_at = ?
             WHERE id = ? AND status = 'continued'`,
          ).run(nowIso(now), task.continuation_of_task_id);
        } else {
          this.db.prepare(
            `UPDATE tasks SET status = 'cancelled_manual', updated_at = ?
             WHERE id = ? AND status = 'continuation_pending'`,
          ).run(nowIso(now), task.continuation_of_task_id);
        }
      }
      this._cancelWorkPlansForSourceTask(taskId, now);
      return result.changes === 1;
    });
  }

  getTask(taskId) {
    return taskFromRow(
      this.db.prepare("SELECT * FROM tasks WHERE id = ? AND privacy_erased_at IS NULL").get(taskId),
      this.cipher,
    );
  }

  listAutomatedSendEvidence({
    since = new Date(0),
    until = new Date(),
  } = {}) {
    const rows = this.db.prepare(
      `SELECT t.id AS task_id, t.conversation_id, t.result_json,
              e.idempotency_key, e.status AS effect_status,
              e.receipt_json, e.created_at, e.updated_at
       FROM side_effects e
       JOIN tasks t ON t.id = e.task_id
       WHERE e.capability = 'send_message'
         AND e.status IN ('started', 'completed', 'unknown')
         AND e.created_at >= ? AND e.created_at <= ?
         AND t.privacy_erased_at IS NULL
       ORDER BY e.created_at`,
    ).all(nowIso(since), nowIso(until));
    return rows.flatMap((row) => {
      const draft = row.result_json
        ? JSON.parse(this.cipher.decrypt(row.result_json))
        : null;
      const content = String(draft?.reply ?? "").trim();
      if (!content) return [];
      return [{
        taskId: row.task_id,
        idempotencyKey: row.idempotency_key,
        conversationId: row.conversation_id,
        content,
        status: row.effect_status,
        startedAt: row.created_at,
        updatedAt: row.updated_at,
        receipt: row.receipt_json
          ? JSON.parse(this.cipher.decrypt(row.receipt_json))
          : null,
      }];
    });
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
          WHERE privacy_erased_at IS NULL AND status = ?
            AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
        )
        .all(status, beforeCreatedAt, beforeCreatedAt, beforeId, limit);
    } else if (status) {
      rows = this.db
          .prepare(
            "SELECT * FROM tasks WHERE privacy_erased_at IS NULL AND status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
          )
          .all(status, limit, offset);
    } else {
      rows = this.db
        .prepare(
          "SELECT * FROM tasks WHERE privacy_erased_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
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
    return this.transaction(() => {
      const task = this.db.prepare(
        `SELECT status, continuation_of_task_id
         FROM tasks WHERE id = ?`,
      ).get(taskId);
      if (task?.status !== "dead") {
        throw new Error("Only dead tasks can be retried");
      }
      if (task.continuation_of_task_id) {
        const parent = this.db.prepare(
          `UPDATE tasks SET status = 'continuation_pending', updated_at = ?
           WHERE id = ? AND status = 'waiting_information'`,
        ).run(nowIso(now), task.continuation_of_task_id);
        if (parent.changes !== 1) {
          throw new Error("Waiting task continuation cannot be retried");
        }
      }
      const result = this.db.prepare(
        `UPDATE tasks
         SET status = 'queued', attempts = 0, available_at = ?,
             lease_until = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND status = 'dead'`,
      ).run(nowIso(now), nowIso(now), taskId);
      if (result.changes !== 1) {
        throw new Error("Only dead tasks can be retried");
      }
    });
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
        .prepare("SELECT status, result_json FROM tasks WHERE id = ?")
        .get(taskId);
      if (task?.status !== "send_unknown") {
        throw new Error("Task is not in send_unknown state");
      }
      const sideEffect = this.db.prepare(
        `SELECT created_at FROM side_effects
         WHERE task_id = ? AND capability = 'send_message'`,
      ).get(taskId);
      if (!sideEffect?.created_at) {
        throw new Error("Unknown send side effect ledger is missing");
      }
      const timestamp = nowIso(now);
      if (resolution === "sent") {
        const draft = task.result_json
          ? JSON.parse(this.cipher.decrypt(task.result_json))
          : null;
        const taskStatus = draft?.needsInformation
          ? "waiting_information"
          : "completed";
        const completedEffect = this.db
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
        if (completedEffect.changes !== 1) {
          throw new Error("Unknown send side effect ledger is missing");
        }
        this.db
          .prepare(
            `
            UPDATE tasks
            SET status = ?, waiting_information_at = ?,
                last_error = NULL, updated_at = ?
            WHERE id = ?
          `,
          )
          .run(
            taskStatus,
            taskStatus === "waiting_information" ? sideEffect.created_at : null,
            timestamp,
            taskId,
          );
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
          source_version, source_access_status, source_access_reason,
          scope_ciphertext, confidence, status,
          sensitivity, expires_at, created_by, updated_by, supersedes_id,
          created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'proposed',?,?,?,?,?,?,?)
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
        memory.sourceType === "gbrain" ? "unverified" : "not_required",
        memory.sourceType === "gbrain" ? "awaiting_source_check" : null,
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

  proposeWorkPlanMemory(input, now = new Date()) {
    const memory = validateMemoryProposal({ ...input, sourceType: "work_plan" });
    if (!memory.projectId || !/^[a-f0-9]{64}$/u.test(memory.sourceId)) {
      throw new Error("Work plan memory requires a project and plan hash source");
    }
    return this.transaction(() => {
      const plan = this.db.prepare(
        `SELECT id FROM work_plans
         WHERE plan_hash = ? AND project_id = ? AND privacy_erased_at IS NULL`,
      ).get(memory.sourceId, memory.projectId);
      if (!plan) throw new Error("Work plan memory source is not verifiable");
      const factKey = String(memory.scope.factKey ?? "").trim();
      const evidenceStepId = String(memory.scope.evidenceStepId ?? "").trim();
      const evidenceRow = this.db.prepare(
        `SELECT status, evidence_ciphertext FROM work_plan_steps
         WHERE work_plan_id = ? AND step_id = ?`,
      ).get(plan.id, evidenceStepId);
      if (!evidenceRow?.evidence_ciphertext) {
        throw new Error("Work plan memory evidence is not verifiable");
      }
      assertWorkPlanMemoryEvidence(memory.scope, {
        stepId: evidenceStepId,
        status: evidenceRow.status,
        evidence: JSON.parse(this.cipher.decrypt(evidenceRow.evidence_ciphertext)),
      });
      const id = `memory_plan_${createHash("sha256").update(`${memory.sourceId}\n${factKey}`).digest("hex").slice(0, 32)}`;
      const existing = this.getMemory(id);
      if (existing) return { created: false, id, status: existing.status };
      const timestamp = nowIso(now);
      this.db.prepare(
        `INSERT INTO memory_items(
          id, type, subject_key, subject_ciphertext, project_id,
          statement_ciphertext, source_type, source_id_ciphertext,
          source_version, source_access_status, source_access_reason,
          scope_ciphertext, confidence, status,
          sensitivity, expires_at, created_by, updated_by, supersedes_id,
          created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?, 'not_required',NULL,?,?,'proposed',?,?,?,?,NULL,?,?)`,
      ).run(
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
        timestamp,
        timestamp,
      );
      return { created: true, id, status: "proposed", sourcePlanId: plan.id };
    });
  }

  proposeMemoryCandidate(input, now = new Date()) {
    validateAutomaticMemoryProposal(input, now);
    const memory = validateMemoryProposal(input);
    const subjectKey = this.cipher.fingerprint(memory.subject);
    const factKey = memory.scope.factKey;
    const statement = memory.statement.trim();
    return this.transaction(() => {
      const sourceTask = this.db.prepare(
        "SELECT payload_json FROM tasks WHERE id = ?",
      ).get(memory.sourceVersion);
      const sourcePayload = sourceTask?.payload_json
        ? JSON.parse(this.cipher.decrypt(sourceTask.payload_json))
        : null;
      if (!(sourcePayload?.messages ?? []).some(
        (message) => String(message.id) === memory.sourceId,
      )) {
        throw new Error("Automatic memory source does not belong to its source task");
      }
      const comparable = this.db.prepare(
        `SELECT * FROM memory_items
         WHERE deleted_at IS NULL
           AND status IN ('proposed', 'confirmed')
           AND type = ? AND subject_key = ? AND project_id IS ?
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY updated_at DESC`,
      ).all(
        memory.type,
        subjectKey,
        memory.projectId,
        nowIso(now),
      ).map((row) => memoryFromRow(row, this.cipher))
        .filter((item) => memoryFactKey(item) === factKey);
      const duplicate = comparable.find(
        (item) => item.statement.trim() === statement,
      );
      if (duplicate) {
        return { created: false, id: duplicate.id, reason: "duplicate" };
      }
      const id = `memory_${randomUUID()}`;
      const timestamp = nowIso(now);
      this.db.prepare(
        `INSERT INTO memory_items(
          id, type, subject_key, subject_ciphertext, project_id,
          statement_ciphertext, source_type, source_id_ciphertext,
          source_version, source_access_status, source_access_reason,
          scope_ciphertext, confidence, status,
          sensitivity, expires_at, created_by, updated_by, supersedes_id,
          created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'proposed',?,?,?,?,?,?,?)`,
      ).run(
        id,
        memory.type,
        subjectKey,
        this.cipher.encrypt(memory.subject),
        memory.projectId,
        this.cipher.encrypt(memory.statement),
        memory.sourceType,
        this.cipher.encrypt(memory.sourceId),
        memory.sourceVersion,
        "not_required",
        null,
        this.cipher.encrypt(JSON.stringify(memory.scope)),
        memory.confidence,
        memory.sensitivity,
        memory.expiresAt.toISOString(),
        memory.createdBy,
        memory.createdBy,
        null,
        timestamp,
        timestamp,
      );
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

  proposeHistoricalProjectMemories(inputs, now = new Date()) {
    const memories = validateHistoricalMemoryProposals(inputs, now);
    return this.transaction(() => {
      const results = [];
      for (const memory of memories) {
        const subjectKey = this.cipher.fingerprint(memory.subject);
        const factKey = memory.scope.factKey;
        const comparable = this.db.prepare(
          `SELECT * FROM memory_items
           WHERE deleted_at IS NULL
             AND status IN ('proposed', 'confirmed')
             AND type = ? AND subject_key = ? AND project_id IS ?
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY updated_at DESC`,
        ).all(
          memory.type,
          subjectKey,
          memory.projectId,
          nowIso(now),
        ).map((row) => memoryFromRow(row, this.cipher))
          .filter((item) => memoryFactKey(item) === factKey);
        const duplicate = comparable.find(
          (item) => item.statement.trim() === memory.statement.trim(),
        );
        if (duplicate) {
          results.push({
            created: false,
            id: duplicate.id,
            reason: "duplicate",
            conflictCount: 0,
          });
          continue;
        }
        const id = historicalMemoryId(memory);
        const existing = this.getMemory(id);
        if (existing) {
          results.push({
            created: false,
            id,
            reason: "existing_import_record",
            conflictCount: 0,
          });
          continue;
        }
        const timestamp = nowIso(now);
        this.db.prepare(
          `INSERT INTO memory_items(
            id, type, subject_key, subject_ciphertext, project_id,
            statement_ciphertext, source_type, source_id_ciphertext,
            source_version, source_access_status, source_access_reason,
            scope_ciphertext, confidence, status,
            sensitivity, expires_at, created_by, updated_by, supersedes_id,
            created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,'not_required',NULL,?,?, 'proposed',?,?,?,?,NULL,?,?)`,
        ).run(
          id,
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
          memory.expiresAt.toISOString(),
          memory.createdBy,
          memory.createdBy,
          timestamp,
          timestamp,
        );
        results.push({
          created: true,
          id,
          status: "proposed",
          conflictCount: comparable.filter(
            (item) => item.status === "confirmed" &&
              item.statement.trim() !== memory.statement.trim(),
          ).length,
        });
      }
      return results;
    });
  }

  confirmMemory(id, actor, now = new Date(), { supersedesId = null } = {}) {
    return this.transaction(() => {
      const memory = this.db
        .prepare("SELECT * FROM memory_items WHERE id = ?")
        .get(id);
      if (!memory) throw new Error(`Memory not found: ${id}`);
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
        const sourceTask = this.db.prepare(
          `SELECT payload_json FROM tasks
           WHERE id = ? AND privacy_erased_at IS NULL`,
        ).get(memory.source_version);
        const sourcePayload = sourceTask?.payload_json
          ? JSON.parse(this.cipher.decrypt(sourceTask.payload_json))
          : null;
        const sourceId = this.cipher.decrypt(memory.source_id_ciphertext);
        if (!(sourcePayload?.messages ?? []).some(
          (message) => String(message.id) === sourceId,
        )) {
          throw new Error("DingTalk memory source must remain verifiable before confirmation");
        }
      }
      if (memory.source_type === "work_plan") {
        const sourceId = this.cipher.decrypt(memory.source_id_ciphertext);
        const sourcePlan = this.db.prepare(
          `SELECT 1 FROM work_plans
           WHERE plan_hash = ? AND project_id IS ? AND privacy_erased_at IS NULL`,
        ).get(sourceId, memory.project_id);
        if (!sourcePlan) throw new Error("Work plan memory source must remain verifiable before confirmation");
      }
      const active = this.db.prepare(
        `SELECT * FROM memory_items
         WHERE status = 'confirmed' AND deleted_at IS NULL
           AND type = ? AND subject_key = ? AND project_id IS ?
           AND (expires_at IS NULL OR expires_at > ?)
           AND (source_type <> 'gbrain' OR (
             source_access_status = 'verified' AND source_access_expires_at > ?
           ))
         ORDER BY updated_at DESC`,
      ).all(
        memory.type,
        memory.subject_key,
        memory.project_id,
        nowIso(now),
        nowIso(now),
      );
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

  setMemorySourceAccess(id, change) {
    const normalized = validateSourceAccessChange(change);
    const result = this.db.prepare(
      `UPDATE memory_items SET
         source_access_status = ?, source_access_reason = ?,
         source_access_checked_at = ?, source_access_expires_at = ?,
         source_version = COALESCE(?, source_version)
       WHERE id = ? AND source_type = 'gbrain' AND deleted_at IS NULL`,
    ).run(
      normalized.status,
      normalized.reason,
      normalized.checkedAt.toISOString(),
      normalized.expiresAt?.toISOString() ?? null,
      normalized.sourceVersion,
      id,
    );
    if (result.changes !== 1) throw new Error("Memory source access cannot be updated");
    return normalized.status;
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
           source_access_status = 'revoked', source_access_reason = 'deleted',
           source_access_checked_at = ?, source_access_expires_at = NULL,
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
        timestamp,
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

  getMemory(id) {
    const row = this.db
      .prepare("SELECT * FROM memory_items WHERE id = ? AND deleted_at IS NULL")
      .get(id);
    return row ? memoryFromRow(row, this.cipher) : null;
  }

  listMemories({
    type,
    subject,
    projectId,
    status,
    statuses,
    sensitivity,
    sourceType,
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
    if (statuses) {
      if (!Array.isArray(statuses) || statuses.length === 0) {
        throw new Error("Memory statuses must be a non-empty array");
      }
      clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
      parameters.push(...statuses);
    }
    if (sensitivity) {
      clauses.push("sensitivity = ?");
      parameters.push(sensitivity);
    }
    if (sourceType) {
      clauses.push("source_type = ?");
      parameters.push(sourceType);
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
    return this.transaction(() => {
      if (assessment.plan.sourceTaskId) {
        const sourceTask = this.db.prepare(
          `SELECT status, privacy_erased_at FROM tasks WHERE id = ?`,
        ).get(assessment.plan.sourceTaskId);
        if (
          !sourceTask ||
          sourceTask.privacy_erased_at ||
          ["cancelled_manual", "cancelled_operator"].includes(sourceTask.status)
        ) {
          throw new Error("Work plan source task is no longer actionable");
        }
      }
      const erased = this.db.prepare(
        "SELECT privacy_erased_at FROM work_plans WHERE id = ?",
      ).get(id);
      if (erased?.privacy_erased_at) {
        throw new Error("Erased work plan content cannot be recreated unchanged");
      }
      const timestamp = nowIso(now);
      const inserted = this.db.prepare(
        `INSERT OR IGNORE INTO work_plans(
          id, project_id, requester_key, requester_ciphertext,
          objective_ciphertext, plan_ciphertext, plan_hash,
          authorization_hash, capability_budget_ciphertext, max_level,
          policy_decision, status, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
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
        timestamp,
        timestamp,
      );
      const legacyPlan = inserted.changes === 0
        ? this.db.prepare(
            `SELECT status, approval_version, cancel_requested_by,
                    authorization_hash, capability_budget_ciphertext
             FROM work_plans WHERE id = ? AND plan_hash = ?`,
          ).get(id, assessment.planHash)
        : null;
      const restoringLegacyPlan = legacyPlan?.status === "cancelled" &&
        legacyPlan.cancel_requested_by === "system:migration-018" &&
        (!legacyPlan.authorization_hash || !legacyPlan.capability_budget_ciphertext);
      if (restoringLegacyPlan) {
        const latestApproval = this.db.prepare(
          `SELECT MAX(approval_version) AS approval_version
           FROM work_plan_approvals WHERE work_plan_id = ?`,
        ).get(id);
        const approvalVersion = Math.max(
          Number(legacyPlan.approval_version ?? 1),
          Number(latestApproval?.approval_version ?? 0),
        ) + 1;
        const restored = this.db.prepare(
          `UPDATE work_plans
           SET project_id = ?, requester_key = ?, requester_ciphertext = ?,
               objective_ciphertext = ?, plan_ciphertext = ?,
               authorization_hash = ?, capability_budget_ciphertext = ?,
               max_level = ?, policy_decision = ?, status = ?,
               approval_version = ?, execution_owner = NULL,
               lease_expires_at = NULL, cancel_requested_at = NULL,
               cancel_requested_by = NULL, updated_at = ?
           WHERE id = ? AND plan_hash = ? AND status = 'cancelled'
             AND cancel_requested_by = 'system:migration-018'
             AND (authorization_hash IS NULL OR capability_budget_ciphertext IS NULL)`,
        ).run(
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
          timestamp,
          id,
          assessment.planHash,
        );
        if (restored.changes !== 1) {
          throw new Error("Legacy work plan could not be registered safely");
        }
      }
      const insertStep = this.db.prepare(restoringLegacyPlan
        ? `INSERT INTO work_plan_steps(
             work_plan_id, step_id, position, capability, status, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', ?)
           ON CONFLICT(work_plan_id, step_id) DO UPDATE SET
             position = excluded.position, capability = excluded.capability,
             status = 'pending', evidence_ciphertext = NULL,
             error_ciphertext = NULL, started_at = NULL, completed_at = NULL,
             updated_at = excluded.updated_at`
        : `INSERT OR IGNORE INTO work_plan_steps(
             work_plan_id, step_id, position, capability, status, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', ?)`);
      assessment.plan.steps.forEach((step, position) => {
        insertStep.run(id, step.id, position, step.capability, timestamp);
      });
      return this.getWorkPlan(id);
    });
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
      if (assessment.plan.sourceTaskId) {
        const sourceTask = this.db.prepare(
          "SELECT status, privacy_erased_at FROM tasks WHERE id = ?",
        ).get(assessment.plan.sourceTaskId);
        if (
          !sourceTask ||
          sourceTask.privacy_erased_at ||
          ["cancelled_manual", "cancelled_operator"].includes(sourceTask.status)
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
      const revisedId = `plan_${assessment.planHash.slice(0, 24)}`;
      if (this.db.prepare("SELECT 1 FROM work_plans WHERE id = ?").get(revisedId)) {
        throw new Error("Revised work plan already exists");
      }
      const timestamp = nowIso(now);
      this.db.prepare(
        `INSERT INTO work_plans(
          id, project_id, requester_key, requester_ciphertext,
          objective_ciphertext, plan_ciphertext, plan_hash,
          authorization_hash, capability_budget_ciphertext, max_level,
          policy_decision, status, supersedes_work_plan_id, revision_actor,
          created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'awaiting_approval',?,?,?,?)`,
      ).run(
        revisedId,
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
      this.db.prepare("SELECT * FROM work_plans WHERE id = ? AND privacy_erased_at IS NULL").get(id),
      this.cipher,
    );
  }

  getWorkPlanApproval(id) {
    const plan = this.db.prepare(
      "SELECT plan_hash, approval_version FROM work_plans WHERE id = ? AND privacy_erased_at IS NULL",
    ).get(id);
    if (!plan) return null;
    const row = this.db.prepare(
      `SELECT * FROM work_plan_approvals
       WHERE work_plan_id = ? AND plan_hash = ? AND approval_version = ?
         AND decision = 'approved'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(id, plan.plan_hash, plan.approval_version);
    return row ? {
      ...row,
      reason: this.cipher.decrypt(row.reason_ciphertext),
      reason_ciphertext: undefined,
    } : null;
  }

  listWorkPlans({ status, limit = 100 } = {}) {
    const rows = status
      ? this.db
          .prepare(
            "SELECT * FROM work_plans WHERE privacy_erased_at IS NULL AND status = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
          )
          .all(status, limit)
      : this.db
          .prepare(
            "SELECT * FROM work_plans WHERE privacy_erased_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?",
          )
          .all(limit);
    return rows.map((row) => workPlanFromRow(row, this.cipher));
  }

  listProjectWorkHistory({
    projectId,
    start,
    end,
    excludePlanHash = null,
    limit = 50,
  }) {
    const from = new Date(start);
    const to = new Date(end);
    if (
      typeof projectId !== "string" || !projectId.trim() ||
      Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 101 ||
      (excludePlanHash != null && !/^[a-f0-9]{64}$/u.test(excludePlanHash))
    ) {
      throw new Error("Project work history query is invalid");
    }
    const rows = this.db.prepare(
      `SELECT * FROM work_plans
       WHERE privacy_erased_at IS NULL
         AND project_id = ?
         AND status IN ('completed','failed','cancelled')
         AND updated_at >= ? AND updated_at < ?
         AND (? IS NULL OR plan_hash <> ?)
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(
      projectId.trim(),
      from.toISOString(),
      to.toISOString(),
      excludePlanHash,
      excludePlanHash,
      limit,
    );
    return rows.map((row) => ({
      ...workPlanFromRow(row, this.cipher),
      steps: this.listWorkPlanSteps(row.id),
    }));
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
    { owner = null, leaseExpiresAt = null, capabilityBudget = null } = {},
  ) {
    if (owner && !(leaseExpiresAt instanceof Date && leaseExpiresAt > now)) {
      throw new Error("Execution lease expiry must be in the future");
    }
    return this.transaction(() => {
      const plan = this.db
        .prepare("SELECT * FROM work_plans WHERE id = ?")
        .get(id);
      if (!plan) throw new Error("Work plan not found");
      let storedPlan;
      try {
        storedPlan = JSON.parse(
          this.cipher.decrypt(plan.plan_ciphertext),
        );
      } catch {
        throw new Error("Stored work plan is invalid");
      }
      const sourceTaskId = storedPlan?.sourceTaskId;
      if (sourceTaskId) {
        const sourceTask = this.db.prepare(
          "SELECT status, privacy_erased_at FROM tasks WHERE id = ?",
        ).get(sourceTaskId);
        if (
          !sourceTask ||
          sourceTask.privacy_erased_at ||
          ["cancelled_manual", "cancelled_operator"].includes(sourceTask.status)
        ) {
          throw new Error("Work plan source task is no longer actionable");
        }
      }
      const triggerId = storedPlan?.recipe?.triggerId;
      const triggerRunKey = storedPlan?.recipe?.triggerRunKey;
      if (triggerId || triggerRunKey) {
        const completedTriggerRun = this.db.prepare(
          `SELECT 1 FROM work_trigger_runs
           WHERE trigger_id = ? AND run_key = ? AND status = 'completed'
             AND work_plan_id = ?`,
        ).get(triggerId, triggerRunKey, id);
        if (!completedTriggerRun) {
          throw new Error("Triggered work plan run is not completed");
        }
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
      const consumeBudget = () => {
        const timestamp = nowIso(now);
        const insert = this.db.prepare(
          `INSERT OR IGNORE INTO capability_budget_usage(
             project_key, project_id_ciphertext, authorization_hash,
             capability, limit_count, used_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        );
        const consume = this.db.prepare(
          `UPDATE capability_budget_usage
           SET used_count = used_count + ?, updated_at = ?
           WHERE project_key = ? AND authorization_hash = ? AND capability = ?
             AND limit_count = ? AND used_count + ? <= limit_count`,
        );
        const projectKey = this.cipher.fingerprint(budget.projectId);
        for (const entry of budget.entries) {
          insert.run(
            projectKey,
            this.cipher.encrypt(budget.projectId),
            budget.authorizationHash,
            entry.capability,
            entry.limit,
            timestamp,
            timestamp,
          );
          const result = consume.run(
            entry.amount,
            timestamp,
            projectKey,
            budget.authorizationHash,
            entry.capability,
            entry.limit,
            entry.amount,
          );
          if (result.changes !== 1) {
            throw new Error(`Capability authorization budget exhausted: ${entry.capability}`);
          }
        }
      };
      if (plan.status === "ready" && plan.policy_decision === "ALLOW") {
        consumeBudget();
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
      consumeBudget();
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

  listCapabilityBudgetUsage({ projectId = null } = {}) {
    const rows = projectId
      ? this.db.prepare(
        `SELECT project_key, project_id_ciphertext, authorization_hash, capability,
                limit_count, used_count, updated_at
         FROM capability_budget_usage
         WHERE project_key = ? ORDER BY capability`,
      ).all(this.cipher.fingerprint(projectId))
      : this.db.prepare(
        `SELECT project_key, project_id_ciphertext, authorization_hash, capability,
                limit_count, used_count, updated_at
         FROM capability_budget_usage
         ORDER BY project_key, capability`,
      ).all();
    return rows.map((row) => ({
      projectId: this.cipher.decrypt(row.project_id_ciphertext) || null,
      authorizationHash: row.authorization_hash,
      capability: row.capability,
      limit: row.limit_count,
      used: row.used_count,
      remaining: row.limit_count - row.used_count,
      updatedAt: row.updated_at,
    }));
  }

  createWorkTrigger(input, actor, now = new Date()) {
    const trigger = validateWorkTrigger(input);
    if (!String(actor ?? "").trim()) throw new Error("Work trigger actor is required");
    const timestamp = nowIso(now);
    const nextRunAt = trigger.kind === "schedule" && trigger.enabled
      ? nextScheduledRun(trigger, new Date(now.getTime() - 1)).toISOString()
      : null;
    const result = this.db.prepare(
      `INSERT INTO work_triggers(
         id, project_id, kind, status, definition_ciphertext, next_run_at,
         created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      trigger.id,
      trigger.projectId,
      trigger.kind,
      trigger.enabled ? "enabled" : "disabled",
      this.cipher.encrypt(JSON.stringify(trigger)),
      nextRunAt,
      timestamp,
      timestamp,
    );
    if (result.changes !== 1) throw new Error("Work trigger could not be created");
    return this.getWorkTrigger(trigger.id);
  }

  getWorkTrigger(id) {
    const row = this.db.prepare("SELECT * FROM work_triggers WHERE id = ?").get(id);
    if (!row) return null;
    return {
      ...JSON.parse(this.cipher.decrypt(row.definition_ciphertext)),
      status: row.status,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getWorkTriggerRun(triggerId, runKey) {
    const row = this.db.prepare(
      `SELECT * FROM work_trigger_runs
       WHERE trigger_id = ? AND run_key = ?`,
    ).get(triggerId, runKey);
    return row ? {
      ...row,
      error: row.error_ciphertext ? this.cipher.decrypt(row.error_ciphertext) : null,
      error_ciphertext: undefined,
    } : null;
  }

  listWorkTriggers({ projectId = null, status = null } = {}) {
    if (status && !["enabled", "disabled"].includes(status)) {
      throw new Error("Work trigger status is invalid");
    }
    const clauses = [];
    const values = [];
    if (projectId) { clauses.push("project_id = ?"); values.push(projectId); }
    if (status) { clauses.push("status = ?"); values.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(
      `SELECT id FROM work_triggers ${where} ORDER BY updated_at DESC, id`,
    ).all(...values).map((row) => this.getWorkTrigger(row.id));
  }

  setWorkTriggerEnabled(id, enabled, actor, now = new Date()) {
    if (typeof enabled !== "boolean" || !String(actor ?? "").trim()) {
      throw new Error("Work trigger enable change is invalid");
    }
    const current = this.getWorkTrigger(id);
    if (!current) throw new Error("Work trigger not found");
    const updated = validateWorkTrigger({ ...current, enabled });
    const nextRunAt = updated.kind === "schedule" && enabled
      ? nextScheduledRun(updated, new Date(now.getTime() - 1)).toISOString()
      : null;
    const result = this.db.prepare(
      `UPDATE work_triggers SET status = ?, definition_ciphertext = ?, next_run_at = ?,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
    ).run(
      enabled ? "enabled" : "disabled",
      this.cipher.encrypt(JSON.stringify(updated)),
      nextRunAt,
      nowIso(now),
      id,
    );
    if (result.changes !== 1) throw new Error("Work trigger could not be updated");
    return this.getWorkTrigger(id);
  }

  claimDueWorkTrigger(owner, leaseExpiresAt, now = new Date()) {
    if (!String(owner ?? "").trim() || !(leaseExpiresAt instanceof Date && leaseExpiresAt > now)) {
      throw new Error("Work trigger claim requires an owner and future lease");
    }
    return this.transaction(() => {
      const row = this.db.prepare(
        `SELECT id FROM work_triggers
         WHERE status = 'enabled' AND kind = 'schedule' AND next_run_at <= ?
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         ORDER BY next_run_at, id LIMIT 1`,
      ).get(nowIso(now), nowIso(now));
      if (!row) return null;
      const claimed = this.db.prepare(
        `UPDATE work_triggers SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'enabled'
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      ).run(owner, leaseExpiresAt.toISOString(), nowIso(now), row.id, nowIso(now));
      if (claimed.changes !== 1) return null;
      return this.getWorkTrigger(row.id);
    });
  }

  reserveWorkTriggerRun(triggerId, runKey, owner, now = new Date()) {
    if (!/^[a-f0-9]{64}$/u.test(String(runKey ?? "")) || !String(owner ?? "").trim()) {
      throw new Error("Work trigger run identity is invalid");
    }
    return this.transaction(() => {
      const trigger = this.getWorkTrigger(triggerId);
      if (!trigger || trigger.status !== "enabled") return false;
      if (trigger.kind === "schedule" && trigger.leaseOwner !== owner) return false;
      const dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);
      const recent = this.db.prepare(
        `SELECT created_at FROM work_trigger_runs
         WHERE trigger_id = ? AND created_at >= ? ORDER BY created_at DESC`,
      ).all(triggerId, dayStart.toISOString());
      if (recent.length >= trigger.maxRunsPerDay) return false;
      if (
        recent[0] &&
        new Date(recent[0].created_at).getTime() + trigger.cooldownMinutes * 60_000 > now.getTime()
      ) return false;
      const inserted = this.db.prepare(
        `INSERT OR IGNORE INTO work_trigger_runs(
           trigger_id, run_key, owner, status, created_at, updated_at
         ) VALUES (?,?,?,'claimed',?,?)`,
      ).run(triggerId, runKey, owner, nowIso(now), nowIso(now));
      return inserted.changes === 1;
    });
  }

  completeWorkTriggerRun(triggerId, runKey, workPlanId, owner, now = new Date()) {
    return this.transaction(() => {
      const run = this.db.prepare(
        `UPDATE work_trigger_runs SET status = 'completed', work_plan_id = ?, updated_at = ?
         WHERE trigger_id = ? AND run_key = ? AND status = 'claimed' AND owner = ?`,
      ).run(workPlanId, nowIso(now), triggerId, runKey, owner);
      if (run.changes !== 1) throw new Error("Work trigger run is not claimed");
      const trigger = this.getWorkTrigger(triggerId);
      if (!trigger) throw new Error("Work trigger not found");
      const nextRunAt = trigger.kind === "schedule"
        ? nextScheduledRun(trigger, now).toISOString()
        : trigger.nextRunAt;
      const updated = this.db.prepare(
        `UPDATE work_triggers SET last_run_at = ?, next_run_at = ?, lease_owner = NULL,
         lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND ((kind = 'schedule' AND lease_owner = ?)
           OR (kind = 'event' AND lease_owner IS NULL))`,
      ).run(nowIso(now), nextRunAt, nowIso(now), triggerId, owner);
      if (updated.changes !== 1) throw new Error("Work trigger lease was lost");
      return this.getWorkTrigger(triggerId);
    });
  }

  advanceWorkTrigger(triggerId, owner, now = new Date()) {
    const trigger = this.getWorkTrigger(triggerId);
    if (!trigger || trigger.kind !== "schedule") throw new Error("Schedule trigger not found");
    const result = this.db.prepare(
      `UPDATE work_triggers SET next_run_at = ?, lease_owner = NULL,
       lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND lease_owner = ?`,
    ).run(nextScheduledRun(trigger, now).toISOString(), nowIso(now), triggerId, owner);
    if (result.changes !== 1) throw new Error("Work trigger lease was lost");
    return this.getWorkTrigger(triggerId);
  }

  failWorkTriggerRun(triggerId, runKey, error, owner, now = new Date()) {
    return this.transaction(() => {
      const result = this.db.prepare(
        `UPDATE work_trigger_runs SET status = 'failed', error_ciphertext = ?, updated_at = ?
         WHERE trigger_id = ? AND run_key = ? AND status = 'claimed' AND owner = ?`,
      ).run(this.cipher.encrypt(String(error ?? "trigger_failed")), nowIso(now), triggerId, runKey, owner);
      if (result.changes !== 1) throw new Error("Work trigger run is not claimed");
      const trigger = this.getWorkTrigger(triggerId);
      if (!trigger) throw new Error("Work trigger not found");
      const nextRunAt = trigger.kind === "schedule"
        ? nextScheduledRun(trigger, now).toISOString()
        : trigger.nextRunAt;
      const updated = this.db.prepare(
        `UPDATE work_triggers SET next_run_at = ?, lease_owner = NULL,
         lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND ((kind = 'schedule' AND lease_owner = ?)
           OR (kind = 'event' AND lease_owner IS NULL))`,
      ).run(nextRunAt, nowIso(now), triggerId, owner);
      if (updated.changes !== 1) throw new Error("Work trigger lease was lost");
      return "failed";
    });
  }

  proposeTimeReturn(workPlanId, humanActiveMinutes, actor, now = new Date()) {
    const proposedBy = String(actor ?? "").trim();
    if (!proposedBy) throw new Error("Time return proposer is required");
    return this.transaction(() => {
      const plan = this.getWorkPlan(workPlanId);
      if (!plan || plan.status !== "completed") {
        throw new Error("Time return requires a completed work plan");
      }
      const recipe = plan.plan?.recipe;
      if (!recipe?.id || recipe.version !== 1) {
        throw new Error("Time return requires a versioned work recipe");
      }
      const steps = this.listWorkPlanSteps(workPlanId);
      if (
        steps.length !== plan.plan.steps.length ||
        steps.some((step) => step.status !== "completed" || !step.evidence)
      ) {
        throw new Error("Time return requires verified evidence for every work plan step");
      }
      const evidence = {
        planHash: plan.plan_hash,
        steps: steps.map((step) => ({
          stepId: step.step_id,
          kind: step.evidence.kind ?? null,
          verification: step.evidence.verification ?? null,
          sha256: step.evidence.sha256 ?? null,
        })),
      };
      const proposal = buildTimeReturnProposal({
        projectId: plan.project_id,
        workPlanId,
        recipeId: recipe.id,
        baselineMinutes: recipe.baselineMinutes,
        humanActiveMinutes,
        baselineMethod: recipe.baselineMethod,
        outcomeEvidence: evidence,
      });
      const timestamp = nowIso(now);
      const inserted = this.db.prepare(
        `INSERT OR IGNORE INTO time_return_entries(
           id, work_plan_id, project_id, recipe_id, baseline_minutes,
           human_active_minutes, returned_minutes, baseline_method,
           outcome_evidence_ciphertext, status, proposed_by, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,'proposed',?,?,?)`,
      ).run(
        `time_${workPlanId}`,
        workPlanId,
        proposal.projectId,
        proposal.recipeId,
        proposal.baselineMinutes,
        proposal.humanActiveMinutes,
        proposal.returnedMinutes,
        proposal.baselineMethod,
        this.cipher.encrypt(JSON.stringify(proposal.outcomeEvidence)),
        proposedBy,
        timestamp,
        timestamp,
      );
      if (inserted.changes !== 1) {
        throw new Error("Time return already exists for this work plan");
      }
      return this.getTimeReturn(`time_${workPlanId}`);
    });
  }

  importConfirmedShadowTimeReturn(input, actor, now = new Date()) {
    const confirmedBy = String(actor ?? "").trim();
    if (!confirmedBy) throw new Error("Shadow time return importer is required");
    const proof = buildConfirmedShadowTimeReturn(input);
    return this.transaction(() => {
      const existingRow = this.db.prepare(
        "SELECT * FROM shadow_time_return_entries WHERE evidence_sha256 = ?",
      ).get(proof.sourceId);
      if (existingRow) {
        const existing = shadowTimeReturnFromRow(existingRow, this.cipher);
        const comparable = [
          "projectId", "recipeId", "planHash", "repositoryCommit",
          "baselineMinutes", "humanActiveMinutes", "returnedMinutes",
          "baselineMethod", "confirmedAt",
        ];
        if (
          comparable.some((key) => existing[key] !== proof[key]) ||
          !isDeepStrictEqual(existing.outcomeEvidence, proof.outcomeEvidence)
        ) {
          throw new Error("Shadow time return evidence already exists with different facts");
        }
        return { entry: existing, created: false };
      }
      this.db.prepare(
        `INSERT INTO shadow_time_return_entries(
           id, evidence_sha256, project_id, recipe_id, plan_hash,
           repository_commit, baseline_minutes, human_active_minutes,
           returned_minutes, baseline_method, outcome_evidence_ciphertext,
           confirmed_by, confirmed_at, imported_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        proof.id,
        proof.sourceId,
        proof.projectId,
        proof.recipeId,
        proof.planHash,
        proof.repositoryCommit,
        proof.baselineMinutes,
        proof.humanActiveMinutes,
        proof.returnedMinutes,
        proof.baselineMethod,
        this.cipher.encrypt(JSON.stringify(proof.outcomeEvidence)),
        confirmedBy,
        proof.confirmedAt,
        nowIso(now),
      );
      return {
        entry: shadowTimeReturnFromRow(
          this.db.prepare("SELECT * FROM shadow_time_return_entries WHERE id = ?").get(proof.id),
          this.cipher,
        ),
        created: true,
      };
    });
  }

  getTimeReturn(id) {
    const regular = this.db.prepare("SELECT * FROM time_return_entries WHERE id = ?").get(id);
    if (regular) return timeReturnFromRow(regular, this.cipher);
    return shadowTimeReturnFromRow(
      this.db.prepare("SELECT * FROM shadow_time_return_entries WHERE id = ?").get(id),
      this.cipher,
    );
  }

  listTimeReturns({ projectId = null, status = null, limit = 500 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Time return limit must be between 1 and 1000");
    }
    const clauses = [];
    const values = [];
    if (projectId) {
      clauses.push("project_id = ?");
      values.push(projectId);
    }
    if (status) {
      if (!["proposed", "confirmed", "rejected"].includes(status)) {
        throw new Error("Time return status is invalid");
      }
      clauses.push("status = ?");
      values.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const regular = this.db.prepare(
      `SELECT * FROM time_return_entries ${where}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(...values, limit).map((row) => timeReturnFromRow(row, this.cipher));
    if (status && status !== "confirmed") return regular;
    const shadowClauses = projectId ? "WHERE project_id = ?" : "";
    const shadowValues = projectId ? [projectId] : [];
    const shadow = this.db.prepare(
      `SELECT * FROM shadow_time_return_entries ${shadowClauses}
       ORDER BY confirmed_at DESC, id DESC LIMIT ?`,
    ).all(...shadowValues, limit).map((row) => shadowTimeReturnFromRow(row, this.cipher));
    return [...regular, ...shadow]
      .sort((left, right) =>
        new Date(right.updatedAt) - new Date(left.updatedAt) || right.id.localeCompare(left.id)
      )
      .slice(0, limit);
  }

  decideTimeReturn(id, decision, actor, now = new Date()) {
    if (!["confirmed", "rejected"].includes(decision)) {
      throw new Error("Time return decision must be confirmed or rejected");
    }
    const confirmedBy = String(actor ?? "").trim();
    if (!confirmedBy) throw new Error("Time return decision actor is required");
    const result = this.db.prepare(
      `UPDATE time_return_entries
       SET status = ?, confirmed_by = ?, updated_at = ?
       WHERE id = ? AND status = 'proposed'`,
    ).run(decision, confirmedBy, nowIso(now), id);
    if (result.changes !== 1) throw new Error("Time return is not awaiting confirmation");
    return this.getTimeReturn(id);
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

  appendGraphProjection(input, now = new Date()) {
    const projection = buildGraphProjection(input);
    const createdAt = nowIso(now);
    return this.transaction(() => {
      let insertedNodes = 0;
      let existingNodes = 0;
      for (const node of projection.nodes) {
        const existing = this.db.prepare(
          `SELECT payload_ciphertext FROM governed_graph_nodes
           WHERE tenant_id = ? AND node_id = ?`,
        ).get(node.tenantId, node.nodeId);
        if (existing) {
          if (!sameGraphNodeRevision(graphPayload(existing.payload_ciphertext, this.cipher), node)) {
            throw new Error(`Graph node revision conflict: ${node.nodeId}`);
          }
          existingNodes += 1;
          continue;
        }
        this.db.prepare(
          `INSERT INTO governed_graph_nodes(
             tenant_id, node_id, node_key, project_id, graph_version,
             node_type, revision, payload_ciphertext, sensitivity,
             expires_at, observed_at, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          node.tenantId,
          node.nodeId,
          node.nodeKey,
          node.projectId,
          node.graphVersion,
          node.nodeType,
          node.revision,
          this.cipher.encrypt(JSON.stringify(node)),
          node.sensitivity,
          node.expiresAt,
          node.observedAt,
          createdAt,
        );
        insertedNodes += 1;
      }
      let insertedEdges = 0;
      let existingEdges = 0;
      for (const edge of projection.edges) {
        const existing = this.db.prepare(
          `SELECT payload_ciphertext FROM governed_graph_edges
           WHERE tenant_id = ? AND edge_id = ?`,
        ).get(edge.from.tenantId, edge.edgeId);
        if (existing) {
          if (JSON.stringify(graphPayload(existing.payload_ciphertext, this.cipher)) !== JSON.stringify(edge)) {
            throw new Error(`Graph edge observation conflict: ${edge.edgeId}`);
          }
          existingEdges += 1;
          continue;
        }
        this.db.prepare(
          `INSERT INTO governed_graph_edges(
             tenant_id, edge_id, relation_key, project_id, graph_version,
             edge_type, phase, from_node_id, to_node_id, authorization_hash,
             payload_ciphertext, state, sensitivity, expires_at, valid_from,
             invalidated_at, observed_at, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          edge.from.tenantId,
          edge.edgeId,
          edge.relationKey,
          edge.from.projectId,
          edge.graphVersion,
          edge.edgeType,
          edge.phase,
          edge.from.nodeId,
          edge.to.nodeId,
          edge.authorizationHash,
          this.cipher.encrypt(JSON.stringify(edge)),
          edge.state,
          edge.sensitivity,
          edge.expiresAt,
          edge.validFrom,
          edge.invalidatedAt,
          edge.observedAt,
          createdAt,
        );
        insertedEdges += 1;
      }
      return {
        graphVersion: projection.graphVersion,
        insertedNodes,
        existingNodes,
        insertedEdges,
        existingEdges,
      };
    });
  }

  listGraphNodes({ tenantId, projectId, nodeType = null, limit = 100 } = {}) {
    const tenant = String(tenantId ?? "").trim();
    const project = String(projectId ?? "").trim();
    if (!tenant || !project) throw new Error("Graph query requires tenantId and projectId");
    const bounded = graphLimit(limit);
    const rows = nodeType
      ? this.db.prepare(
          `SELECT payload_ciphertext FROM governed_graph_nodes
           WHERE tenant_id = ? AND project_id = ? AND node_type = ?
           ORDER BY observed_at DESC, node_id DESC LIMIT ?`,
        ).all(tenant, project, String(nodeType), bounded)
      : this.db.prepare(
          `SELECT payload_ciphertext FROM governed_graph_nodes
           WHERE tenant_id = ? AND project_id = ?
           ORDER BY observed_at DESC, node_id DESC LIMIT ?`,
        ).all(tenant, project, bounded);
    return rows.map((row) => graphPayload(row.payload_ciphertext, this.cipher));
  }

  listGraphEdges({
    tenantId,
    projectId,
    edgeType = null,
    phase = null,
    fromNodeId = null,
    toNodeId = null,
    limit = 100,
  } = {}) {
    const tenant = String(tenantId ?? "").trim();
    const project = String(projectId ?? "").trim();
    if (!tenant || !project) throw new Error("Graph query requires tenantId and projectId");
    const clauses = ["tenant_id = ?", "project_id = ?"];
    const parameters = [tenant, project];
    for (const [column, value] of [
      ["edge_type", edgeType],
      ["phase", phase],
      ["from_node_id", fromNodeId],
      ["to_node_id", toNodeId],
    ]) {
      if (value != null) {
        clauses.push(`${column} = ?`);
        parameters.push(String(value));
      }
    }
    parameters.push(graphLimit(limit));
    return this.db.prepare(
      `SELECT payload_ciphertext FROM governed_graph_edges
       WHERE ${clauses.join(" AND ")}
       ORDER BY observed_at DESC, edge_id DESC LIMIT ?`,
    ).all(...parameters).map((row) => graphPayload(row.payload_ciphertext, this.cipher));
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
      const note = this.cipher.decrypt(row.note_ciphertext);
      const currentDraft = String(result.reply ?? "");
      const currentDraftSha256 = draftSha256(currentDraft);
      const reviewedDraftSha256 = parseDraftSha256(note);
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
        draftPresent: currentDraft.trim().length > 0,
        currentDraftSha256,
        draftCurrent: parseDraftAssessment(note) == null
          ? null
          : reviewedDraftSha256 != null &&
            reviewedDraftSha256 === currentDraftSha256,
        senderName: payload.senderName ?? null,
        senderUserId: row.sender_user_id,
        conversationId: row.conversation_id,
        reviewer: row.reviewer,
        note,
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
      `SELECT * FROM tasks WHERE privacy_erased_at IS NULL
         AND created_at >= ? AND created_at <= ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(start, end, limit + 1).map((row) => taskFromRow(row, this.cipher));
    const effectRows = this.db.prepare(
      `SELECT e.task_id AS taskId, e.capability, e.status,
              e.receipt_json IS NOT NULL AS receiptPresent
       FROM side_effects e JOIN tasks t ON t.id = e.task_id
       WHERE t.privacy_erased_at IS NULL
         AND e.created_at >= ? AND e.created_at <= ?
       ORDER BY e.created_at DESC LIMIT ?`,
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
        .prepare("SELECT status, COUNT(*) AS count FROM tasks WHERE privacy_erased_at IS NULL GROUP BY status")
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
        .prepare("SELECT status, COUNT(*) AS count FROM work_plans WHERE privacy_erased_at IS NULL GROUP BY status")
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
           WHERE privacy_erased_at IS NULL AND status IN ('executing','verifying')
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

  _privacyErasureCandidates(input, now = new Date()) {
    const selector = validatePrivacySelector(input, now);
    const taskStatus = new Set(erasableTaskStatuses);
    const planStatus = new Set(erasableWorkPlanStatuses);
    let planRows;
    if (selector.type === "person") {
      planRows = this.db.prepare(
        "SELECT * FROM work_plans WHERE privacy_erased_at IS NULL AND requester_key = ?",
      ).all(this.cipher.fingerprint(selector.value));
    } else if (selector.type === "project") {
      planRows = this.db.prepare(
        "SELECT * FROM work_plans WHERE privacy_erased_at IS NULL AND project_id = ?",
      ).all(selector.value);
    } else {
      planRows = this.db.prepare(
        "SELECT * FROM work_plans WHERE privacy_erased_at IS NULL AND updated_at < ?",
      ).all(selector.value.toISOString());
    }
    const sourceTaskIds = new Set();
    for (const row of planRows) {
      try {
        const sourceTaskId = JSON.parse(this.cipher.decrypt(row.plan_ciphertext))?.sourceTaskId;
        if (sourceTaskId) sourceTaskIds.add(sourceTaskId);
      } catch {
        // A malformed stored plan remains in scope but cannot expand task scope.
      }
    }
    let taskRows;
    if (selector.type === "person") {
      taskRows = this.db.prepare(
        "SELECT * FROM tasks WHERE privacy_erased_at IS NULL AND sender_user_id = ?",
      ).all(selector.value);
    } else if (selector.type === "project") {
      const selectTask = this.db.prepare(
        "SELECT * FROM tasks WHERE privacy_erased_at IS NULL AND id = ?",
      );
      taskRows = [...sourceTaskIds].map((id) => selectTask.get(id)).filter(Boolean);
    } else {
      taskRows = this.db.prepare(
        "SELECT * FROM tasks WHERE privacy_erased_at IS NULL AND updated_at < ?",
      ).all(selector.value.toISOString());
    }
    let memoryRows;
    if (selector.type === "person") {
      memoryRows = this.db.prepare(
        "SELECT * FROM memory_items WHERE deleted_at IS NULL AND subject_key = ?",
      ).all(this.cipher.fingerprint(selector.value));
    } else if (selector.type === "project") {
      memoryRows = this.db.prepare(
        "SELECT * FROM memory_items WHERE deleted_at IS NULL AND project_id = ?",
      ).all(selector.value);
    } else {
      memoryRows = this.db.prepare(
        "SELECT * FROM memory_items WHERE deleted_at IS NULL AND updated_at < ?",
      ).all(selector.value.toISOString());
    }
    if (taskRows.length > 0) {
      const byId = new Map(memoryRows.map((row) => [row.id, row]));
      const selectSourceMemories = this.db.prepare(
        `SELECT * FROM memory_items
         WHERE deleted_at IS NULL
           AND source_type = 'dingtalk_message'
           AND source_version = ?`,
      );
      for (const task of taskRows) {
        for (const row of selectSourceMemories.all(task.id)) {
          byId.set(row.id, row);
        }
      }
      memoryRows = [...byId.values()];
    }
    if (planRows.length > 0) {
      const byId = new Map(memoryRows.map((row) => [row.id, row]));
      const planHashes = new Set(planRows.map((row) => row.plan_hash));
      const planMemories = this.db.prepare(
        `SELECT * FROM memory_items
         WHERE deleted_at IS NULL
           AND source_type = 'work_plan'`,
      ).all();
      for (const row of planMemories) {
        if (planHashes.has(this.cipher.decrypt(row.source_id_ciphertext))) {
          byId.set(row.id, row);
        }
      }
      memoryRows = [...byId.values()];
    }
    let capabilityBudgetRows;
    if (selector.type === "project") {
      capabilityBudgetRows = this.db.prepare(
        "SELECT * FROM capability_budget_usage WHERE project_key = ?",
      ).all(this.cipher.fingerprint(selector.value));
    } else {
      capabilityBudgetRows = [];
    }
    let timeReturnRows;
    if (selector.type === "project") {
      timeReturnRows = this.db.prepare(
        "SELECT * FROM time_return_entries WHERE project_id = ?",
      ).all(selector.value);
    } else if (selector.type === "time") {
      timeReturnRows = this.db.prepare(
        "SELECT * FROM time_return_entries WHERE updated_at < ?",
      ).all(selector.value.toISOString());
    } else {
      const planIds = planRows.map((row) => row.id);
      const selectTimeReturn = this.db.prepare(
        "SELECT * FROM time_return_entries WHERE work_plan_id = ?",
      );
      timeReturnRows = planIds.flatMap((id) => selectTimeReturn.all(id));
    }
    let shadowTimeReturnRows;
    if (selector.type === "project") {
      shadowTimeReturnRows = this.db.prepare(
        "SELECT * FROM shadow_time_return_entries WHERE project_id = ?",
      ).all(selector.value);
    } else if (selector.type === "time") {
      shadowTimeReturnRows = this.db.prepare(
        "SELECT * FROM shadow_time_return_entries WHERE confirmed_at < ?",
      ).all(selector.value.toISOString());
    } else {
      shadowTimeReturnRows = this.db.prepare(
        "SELECT * FROM shadow_time_return_entries WHERE confirmed_by = ?",
      ).all(selector.value);
    }
    let workTriggerRows = [];
    if (selector.type === "project") {
      workTriggerRows = this.db.prepare(
        "SELECT * FROM work_triggers WHERE project_id = ?",
      ).all(selector.value);
    } else if (selector.type === "person") {
      workTriggerRows = this.db.prepare("SELECT * FROM work_triggers").all().filter((row) => {
        try {
          return JSON.parse(this.cipher.decrypt(row.definition_ciphertext)).requesterId === selector.value;
        } catch {
          return false;
        }
      });
    }
    const taskById = new Map(taskRows.map((row) => [row.id, row]));
    const eligibleTaskIds = new Set(
      taskRows.filter((row) => taskStatus.has(row.status)).map((row) => row.id),
    );
    let messageRows;
    if (selector.type === "person") {
      messageRows = this.db.prepare("SELECT * FROM messages WHERE sender_user_id = ?")
        .all(selector.value);
    } else if (selector.type === "project") {
      const selectMessages = this.db.prepare("SELECT * FROM messages WHERE task_id = ?");
      messageRows = [...sourceTaskIds].flatMap((taskId) => selectMessages.all(taskId));
    } else {
      messageRows = this.db.prepare("SELECT * FROM messages WHERE ingested_at < ?")
        .all(selector.value.toISOString());
    }
    const eligibleMessages = [];
    const blockedMessages = [];
    for (const row of messageRows) {
      const linkedTask = row.task_id ? taskById.get(row.task_id) : null;
      if (
        (linkedTask && eligibleTaskIds.has(linkedTask.id)) ||
        (!row.task_id && row.status !== "pending")
      ) eligibleMessages.push(row);
      else blockedMessages.push(row);
    }
    const blockedCheckpointKeys = [];
    const checkpointRewrites = [];
    const checkpointRows = this.db.prepare(
      "SELECT key, value, updated_at FROM checkpoints WHERE substr(key, 1, 13) = 'scoped_pause:'",
    ).all();
    const targetCheckpointKey = selector.type === "person"
      ? scopedPauseKey(this.cipher, "contact", selector.value)
      : selector.type === "project"
        ? scopedPauseKey(this.cipher, "project", selector.value)
        : null;
    for (const row of checkpointRows) {
      if (
        row.key === targetCheckpointKey ||
        (selector.type === "time" && row.updated_at < selector.value.toISOString())
      ) blockedCheckpointKeys.push(row.key);
      if (selector.type === "person" && row.key !== targetCheckpointKey) {
        try {
          const value = JSON.parse(this.cipher.decrypt(row.value));
          if (value.actor === selector.value) {
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
        ["tasks.approved_by", "SELECT id FROM tasks WHERE approved_by = ?"],
        ["approvals.actor", "SELECT id FROM approvals WHERE actor = ?"],
        ["reviews.reviewer", "SELECT id FROM decision_reviews WHERE reviewer = ?"],
        ["review_events.reviewer", "SELECT id FROM decision_review_events WHERE reviewer = ?"],
        ["plans.revision_actor", "SELECT id FROM work_plans WHERE revision_actor = ?"],
        ["plans.cancel_requested_by", "SELECT id FROM work_plans WHERE cancel_requested_by = ?"],
        ["plan_approvals.actor", "SELECT id FROM work_plan_approvals WHERE actor = ?"],
        ["memories.created_by", "SELECT id FROM memory_items WHERE created_by = ?"],
        ["memories.updated_by", "SELECT id FROM memory_items WHERE updated_by = ?"],
      ];
      for (const [kind, sql] of referenceQueries) {
        for (const row of this.db.prepare(sql).all(selector.value)) {
          identityReferences.push(`${kind}:${row.id}`);
        }
      }
      for (const row of checkpointRewrites) {
        identityReferences.push(`checkpoint.actor:${row.key}`);
      }
    }
    const graphProjectIds = new Set([
      ...(selector.type === "project" ? [selector.value] : []),
      ...planRows.map((row) => row.project_id),
      ...memoryRows.map((row) => row.project_id),
      ...shadowTimeReturnRows.map((row) => row.project_id),
    ].filter((value) => value && value !== "deleted"));
    const graphNodes = [];
    const graphEdges = [];
    const selectGraphNodes = this.db.prepare(
      `SELECT node_id AS id, observed_at AS updated_at
       FROM governed_graph_nodes WHERE project_id = ?`,
    );
    const selectGraphEdges = this.db.prepare(
      `SELECT edge_id AS id, observed_at AS updated_at
       FROM governed_graph_edges WHERE project_id = ?`,
    );
    for (const projectId of graphProjectIds) {
      graphNodes.push(...selectGraphNodes.all(projectId));
      graphEdges.push(...selectGraphEdges.all(projectId));
    }
    const token = (row) =>
      `${row.id}:${row.status ?? ""}:${row.updated_at ?? row.ingested_at ?? ""}`;
    const eligible = {
      tasks: taskRows.filter((row) => taskStatus.has(row.status)).map(token),
      messages: eligibleMessages.map(token),
      workPlans: planRows.filter((row) => planStatus.has(row.status)).map(token),
      memories: memoryRows.map(token),
      capabilityBudgets: capabilityBudgetRows.map((row) =>
        `${row.project_key}:${row.authorization_hash}:${row.capability}:${row.updated_at}`),
      timeReturns: [
        ...timeReturnRows,
        ...shadowTimeReturnRows.map((row) => ({
          ...row,
          status: "confirmed",
          updated_at: row.confirmed_at,
        })),
      ].map(token),
      workTriggers: workTriggerRows.filter((row) => row.status === "disabled").map(token),
      graphNodes: graphNodes.map(token),
      graphEdges: graphEdges.map(token),
      identityReferences: [...new Set(identityReferences)],
    };
    const blocked = {
      tasks: taskRows.filter((row) => !taskStatus.has(row.status)).map(token),
      messages: blockedMessages.map(token),
      workPlans: planRows.filter((row) => !planStatus.has(row.status)).map(token),
      workTriggers: workTriggerRows.filter((row) => row.status !== "disabled").map(token),
      scopedPauses: blockedCheckpointKeys,
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
        messages: eligibleMessages.map((row) => row.id),
        workPlans: planRows.filter((row) => planStatus.has(row.status)).map((row) => row.id),
        memories: memoryRows.map((row) => row.id),
        capabilityBudgets: capabilityBudgetRows.map((row) => ({
          projectKey: row.project_key,
          authorizationHash: row.authorization_hash,
          capability: row.capability,
        })),
        timeReturns: timeReturnRows.map((row) => row.id),
        shadowTimeReturns: shadowTimeReturnRows.map((row) => row.id),
        workTriggers: workTriggerRows.filter((row) => row.status === "disabled").map((row) => row.id),
        graphProjects: [...graphProjectIds].sort(),
        checkpointRewrites,
      },
    };
  }

  previewPrivacyErasure(selector, now = new Date()) {
    return this._privacyErasureCandidates(selector, now).preview;
  }

  erasePrivacyData(selector, confirmation, actor, now = new Date()) {
    if (!String(actor ?? "").trim()) throw new Error("Privacy erasure actor is required");
    return this.transaction(() => {
      const candidates = this._privacyErasureCandidates(selector, now);
      if (candidates.preview.blockedTotal > 0) {
        throw new Error("Privacy erasure is blocked by active or unresolved records");
      }
      if (!candidates.preview.confirmation) {
        throw new Error("Privacy erasure has no eligible data");
      }
      if (confirmation !== candidates.preview.confirmation) {
        throw new Error("Privacy erasure confirmation does not match the current snapshot");
      }
      const timestamp = nowIso(now);
      const encryptedEmpty = this.cipher.encrypt("");
      const encryptedObject = this.cipher.encrypt("{}");
      const eraseTask = this.db.prepare(
        `UPDATE tasks SET sender_user_id = '', conversation_id = '', payload_json = ?,
           result_json = NULL, last_error = NULL,
           approved_by = CASE WHEN approved_by IS NULL THEN NULL ELSE 'deleted' END,
           privacy_erased_at = ?, updated_at = ?
         WHERE id = ? AND privacy_erased_at IS NULL`,
      );
      for (const id of candidates.ids.tasks) {
        eraseTask.run(encryptedObject, timestamp, timestamp, id);
        this.db.prepare("UPDATE approvals SET actor = 'deleted', reason = ? WHERE task_id = ?")
          .run(encryptedEmpty, id);
        this.db.prepare("UPDATE side_effects SET receipt_json = NULL, last_error = NULL WHERE task_id = ?")
          .run(id);
        this.db.prepare("DELETE FROM decision_review_events WHERE task_id = ?").run(id);
        this.db.prepare("DELETE FROM decision_reviews WHERE task_id = ?").run(id);
      }
      const rememberMessage = this.db.prepare(
        "INSERT OR IGNORE INTO privacy_erased_messages(message_key, erased_at) VALUES (?, ?)",
      );
      const deleteMessage = this.db.prepare("DELETE FROM messages WHERE id = ?");
      for (const id of candidates.ids.messages) {
        rememberMessage.run(this.cipher.fingerprint(`message:${id}`), timestamp);
        deleteMessage.run(id);
      }
      const erasePlan = this.db.prepare(
        `UPDATE work_plans SET project_id = 'deleted', requester_key = ?,
           requester_ciphertext = ?, objective_ciphertext = ?, plan_ciphertext = ?,
           plan_hash = ?, authorization_hash = NULL, capability_budget_ciphertext = ?,
           execution_owner = NULL, lease_expires_at = NULL,
           cancel_requested_at = NULL, cancel_requested_by = NULL,
           revision_actor = CASE WHEN revision_actor IS NULL THEN NULL ELSE 'deleted' END,
           privacy_erased_at = ?, updated_at = ?
         WHERE id = ? AND privacy_erased_at IS NULL`,
      );
      for (const id of candidates.ids.workPlans) {
        erasePlan.run(
          this.cipher.fingerprint(`deleted:${id}:${randomUUID()}`),
          encryptedEmpty,
          encryptedEmpty,
          encryptedObject,
          this.cipher.fingerprint(`deleted-plan:${id}:${randomUUID()}`),
          encryptedObject,
          timestamp,
          timestamp,
          id,
        );
        this.db.prepare("UPDATE work_plan_approvals SET actor = 'deleted', reason_ciphertext = ? WHERE work_plan_id = ?")
          .run(encryptedEmpty, id);
        this.db.prepare("UPDATE work_plan_steps SET evidence_ciphertext = NULL, error_ciphertext = NULL WHERE work_plan_id = ?")
          .run(id);
      }
      const eraseCapabilityBudget = this.db.prepare(
        `UPDATE capability_budget_usage SET project_id_ciphertext = ?, updated_at = ?
         WHERE project_key = ? AND authorization_hash = ? AND capability = ?`,
      );
      for (const budget of candidates.ids.capabilityBudgets) {
        eraseCapabilityBudget.run(
          encryptedEmpty,
          timestamp,
          budget.projectKey,
          budget.authorizationHash,
          budget.capability,
        );
      }
      const deleteTimeReturn = this.db.prepare(
        "DELETE FROM time_return_entries WHERE id = ?",
      );
      for (const id of candidates.ids.timeReturns) deleteTimeReturn.run(id);
      const deleteShadowTimeReturn = this.db.prepare(
        "DELETE FROM shadow_time_return_entries WHERE id = ?",
      );
      for (const id of candidates.ids.shadowTimeReturns) deleteShadowTimeReturn.run(id);
      const deleteWorkTrigger = this.db.prepare("DELETE FROM work_triggers WHERE id = ?");
      for (const id of candidates.ids.workTriggers) deleteWorkTrigger.run(id);
      const eraseMemory = this.db.prepare(
        `UPDATE memory_items SET subject_key = ?, subject_ciphertext = ?, project_id = NULL,
           statement_ciphertext = ?, source_type = 'deleted', source_id_ciphertext = ?,
           source_version = NULL, source_access_status = 'revoked', source_access_reason = 'deleted',
           source_access_checked_at = ?, source_access_expires_at = NULL, scope_ciphertext = ?,
           confidence = 0, status = 'revoked', sensitivity = 'internal', valid_from = NULL,
           expires_at = NULL, created_by = 'deleted', updated_by = 'deleted', supersedes_id = NULL,
           created_at = ?, updated_at = ?, deleted_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      );
      for (const id of candidates.ids.memories) {
        this.db.prepare("UPDATE memory_items SET supersedes_id = NULL WHERE supersedes_id = ?").run(id);
        eraseMemory.run(
          this.cipher.fingerprint(`deleted:${id}:${randomUUID()}`),
          encryptedEmpty,
          encryptedEmpty,
          encryptedEmpty,
          timestamp,
          encryptedObject,
          timestamp,
          timestamp,
          timestamp,
          id,
        );
      }
      for (const checkpoint of candidates.ids.checkpointRewrites) {
        this.db.prepare("UPDATE checkpoints SET value = ?, updated_at = ? WHERE key = ?")
          .run(this.cipher.encrypt(JSON.stringify(checkpoint.value)), timestamp, checkpoint.key);
      }
      const deleteGraphEdges = this.db.prepare(
        "DELETE FROM governed_graph_edges WHERE project_id = ?",
      );
      const deleteGraphNodes = this.db.prepare(
        "DELETE FROM governed_graph_nodes WHERE project_id = ?",
      );
      for (const projectId of candidates.ids.graphProjects) {
        deleteGraphEdges.run(projectId);
        deleteGraphNodes.run(projectId);
      }
      if (candidates.selector.type === "person") {
        const value = candidates.selector.value;
        this.db.prepare("UPDATE tasks SET approved_by = 'deleted' WHERE approved_by = ?").run(value);
        this.db.prepare("UPDATE approvals SET actor = 'deleted', reason = ? WHERE actor = ?").run(encryptedEmpty, value);
        this.db.prepare("UPDATE decision_reviews SET reviewer = 'deleted', note_ciphertext = ? WHERE reviewer = ?").run(encryptedEmpty, value);
        this.db.prepare("UPDATE decision_review_events SET reviewer = 'deleted', note_ciphertext = ? WHERE reviewer = ?").run(encryptedEmpty, value);
        this.db.prepare("UPDATE work_plans SET revision_actor = 'deleted' WHERE revision_actor = ?").run(value);
        this.db.prepare("UPDATE work_plans SET cancel_requested_by = 'deleted' WHERE cancel_requested_by = ?").run(value);
        this.db.prepare("UPDATE work_plan_approvals SET actor = 'deleted', reason_ciphertext = ? WHERE actor = ?").run(encryptedEmpty, value);
        this.db.prepare("UPDATE memory_items SET created_by = 'deleted' WHERE created_by = ?").run(value);
        this.db.prepare("UPDATE memory_items SET updated_by = 'deleted' WHERE updated_by = ?").run(value);
      }
      return {
        erased: true,
        selector: candidates.preview.selector,
        counts: candidates.preview.counts,
        erasedAt: timestamp,
      };
    });
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
            'cancelled_operator', 'expired', 'continued'
          )
            AND updated_at < ?
        `,
        )
        .all(timestamp);
      const deleteMessages = this.db.prepare(
        "DELETE FROM messages WHERE task_id = ?",
      );
      const selectMessages = this.db.prepare("SELECT id FROM messages WHERE task_id = ?");
      const rememberMessage = this.db.prepare(
        "INSERT OR IGNORE INTO privacy_erased_messages(message_key, erased_at) VALUES (?, ?)",
      );
      const deleteEffects = this.db.prepare(
        "DELETE FROM side_effects WHERE task_id = ?",
      );
      const deleteApprovals = this.db.prepare(
        "DELETE FROM approvals WHERE task_id = ?",
      );
      const deleteTask = this.db.prepare("DELETE FROM tasks WHERE id = ?");
      for (const { id } of taskRows) {
        for (const message of selectMessages.all(id)) {
          rememberMessage.run(this.cipher.fingerprint(`message:${message.id}`), timestamp);
        }
        deleteMessages.run(id);
        deleteEffects.run(id);
        deleteApprovals.run(id);
        deleteTask.run(id);
      }
      return taskRows.length;
    });
  }
}
