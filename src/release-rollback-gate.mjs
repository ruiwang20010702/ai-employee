export function validateReleaseRollbackGate({ preflight, previousRelease }) {
  if (!preflight || preflight.ready !== true) {
    throw new Error("生产预检未通过");
  }
  const pending = preflight.migrations?.pending;
  if (!Array.isArray(pending)) {
    throw new Error("生产预检缺少迁移状态");
  }
  const rollbackTarget = String(previousRelease ?? "").trim();
  if (pending.length > 0 && !rollbackTarget) {
    throw new Error("存在待迁移项但没有可验证的上一版本；请先发布无待迁移的兼容基线");
  }
  return {
    valid: true,
    pendingMigrations: pending.length,
    rollbackTargetReady: Boolean(rollbackTarget),
    databaseWrite: false,
  };
}
