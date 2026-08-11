export const forwardActiveTaskStatuses = Object.freeze([
  "queued",
  "processing",
  "awaiting_approval",
  "approved",
  "sending",
  "send_unknown",
  "waiting_information",
  "continuation_pending",
]);

export const forwardActivePlanStatuses = Object.freeze([
  "awaiting_approval",
  "ready",
  "approved",
  "executing",
  "verifying",
]);

function count(statuses, names) {
  return names.reduce(
    (total, name) => total + Number(statuses?.[name] ?? 0),
    0,
  );
}

export function evaluateForwardMaintenanceState(state) {
  const activeTasks = count(state?.tasks, forwardActiveTaskStatuses);
  const activePlans = count(state?.workPlans, forwardActivePlanStatuses);
  const pendingMessages = Number(state?.pendingMessages ?? 0);
  const expiredExecutionLeases = Number(state?.expiredExecutionLeases ?? 0);
  const blockers = [];
  if (state?.paused !== true) blockers.push("system_not_paused");
  if (activeTasks !== 0) blockers.push("active_tasks");
  if (activePlans !== 0) blockers.push("active_work_plans");
  if (pendingMessages !== 0) blockers.push("pending_messages");
  if (expiredExecutionLeases !== 0) blockers.push("expired_execution_leases");
  return {
    safe: blockers.length === 0,
    blockers,
    paused: state?.paused === true,
    activeTasks,
    activePlans,
    pendingMessages,
    expiredExecutionLeases,
    tasks: state?.tasks ?? {},
    workPlans: state?.workPlans ?? {},
  };
}

export function assertForwardMaintenanceState(state) {
  const result = evaluateForwardMaintenanceState(state);
  if (!result.safe) {
    const error = new Error(
      `维护前滚状态不安全：${result.blockers.join(",")}`,
    );
    error.code = "forward_maintenance_state_unsafe";
    error.evidence = result;
    throw error;
  }
  return result;
}
