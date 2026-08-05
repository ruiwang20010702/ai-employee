const allowedScopeTypes = new Set(["contact", "group", "project", "capability"]);

export function normalizePauseScope(type, value) {
  const normalizedType = String(type ?? "").trim().toLowerCase();
  const normalizedValue = String(value ?? "").trim();
  if (!allowedScopeTypes.has(normalizedType)) {
    throw new Error(
      "Pause scope type must be contact, group, project, or capability",
    );
  }
  if (
    !normalizedValue ||
    normalizedValue.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(normalizedValue)
  ) {
    throw new Error("Pause scope value is invalid");
  }
  return { type: normalizedType, value: normalizedValue };
}

export function normalizePauseChange({ type, value, paused, actor, reason = "" }) {
  const scope = normalizePauseScope(type, value);
  const normalizedActor = String(actor ?? "").trim();
  const normalizedReason = String(reason ?? "").trim();
  if (!normalizedActor || normalizedActor.length > 200) {
    throw new Error("Pause actor is required");
  }
  if (normalizedReason.length > 1_000) {
    throw new Error("Pause reason is too long");
  }
  return {
    ...scope,
    paused: Boolean(paused),
    actor: normalizedActor,
    reason: normalizedReason,
  };
}

export function scopedPauseKey(cipher, type, value) {
  const scope = normalizePauseScope(type, value);
  return `scoped_pause:${scope.type}:${cipher.fingerprint(scope.value)}`;
}

export async function pausedPlanScopes(store, plan) {
  if (!store.isScopedPaused) return [];
  const scopes = [
    { type: "project", value: plan.projectId },
    ...[...new Set((plan.steps ?? []).map((step) => step.capability))]
      .map((value) => ({ type: "capability", value })),
  ];
  const states = await Promise.all(
    scopes.map((scope) => store.isScopedPaused(scope.type, scope.value)),
  );
  return scopes.filter((scope, index) => states[index]);
}
