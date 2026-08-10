export async function inspectServiceRollbackState(
  pool,
  {
    targetSupportsContinuation = false,
    targetSupportsCapabilityBudget = false,
  } = {},
) {
  const presence = await pool.query(
    `SELECT
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'tasks'
           AND column_name = 'continuation_of_task_id'
       ) AS continuation_present,
       (
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'work_plans'
             AND column_name IN (
               'authorization_hash', 'capability_budget_ciphertext'
             )
         )
         OR EXISTS (
           SELECT 1
           FROM information_schema.tables
           WHERE table_schema = current_schema()
             AND table_name = 'capability_budget_usage'
         )
       ) AS capability_budget_present`,
  );
  const migrationPresent = Boolean(presence.rows[0]?.continuation_present);
  const capabilityBudgetMigrationPresent = Boolean(
    presence.rows[0]?.capability_budget_present,
  );
  const base = {
    activeContinuationTasks: 0,
    migrationPresent,
    capabilityBudgetMigrationPresent,
    targetSupportsContinuation,
    targetSupportsCapabilityBudget,
  };
  if (
    capabilityBudgetMigrationPresent &&
    !targetSupportsCapabilityBudget
  ) {
    return {
      ...base,
      compatible: false,
    };
  }
  if (!migrationPresent || targetSupportsContinuation) {
    return {
      ...base,
      compatible: true,
    };
  }
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM tasks
     WHERE status IN ('waiting_information', 'continuation_pending')
        OR (
          continuation_of_task_id IS NOT NULL
          AND status NOT IN (
            'no_reply', 'completed', 'rejected', 'cancelled_manual',
            'cancelled_operator', 'expired', 'dead'
          )
        )`,
  );
  const activeContinuationTasks = Number(result.rows[0]?.count ?? 0);
  return {
    ...base,
    compatible: activeContinuationTasks === 0,
    activeContinuationTasks,
  };
}

export function assertServiceRollbackState(state) {
  if (
    state?.capabilityBudgetMigrationPresent &&
    !state?.targetSupportsCapabilityBudget
  ) {
    const error = new Error(
      "旧服务回退已阻止：数据库已应用第 018 号能力次数预算迁移，目标服务不支持持久预算门禁",
    );
    error.code = "service_rollback_capability_budget_unsupported";
    throw error;
  }
  if (!state?.compatible) {
    const error = new Error(
      "旧服务回退已阻止：数据库中仍有等待信息任务链，必须先恢复候选服务或人工完成安全收敛",
    );
    error.code = "service_rollback_active_continuations";
    error.count = Number(state?.activeContinuationTasks ?? 0);
    throw error;
  }
  return state;
}
