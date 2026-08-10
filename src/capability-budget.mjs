export function normalizeCapabilityBudget(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Capability budget is required");
  }
  const projectId = String(value.projectId ?? "").trim();
  const authorizationHash = String(value.authorizationHash ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/u.test(projectId)) {
    throw new Error("Capability budget project is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(authorizationHash)) {
    throw new Error("Capability budget authorization hash is invalid");
  }
  if (!Array.isArray(value.entries) || value.entries.length > 30) {
    throw new Error("Capability budget entries are invalid");
  }
  const seen = new Set();
  const entries = value.entries.map((entry) => {
    const capability = String(entry?.capability ?? "").trim();
    const limit = Number(entry?.limit);
    const amount = Number(entry?.amount);
    if (!/^[a-z][a-z0-9_]{1,99}$/u.test(capability) || seen.has(capability)) {
      throw new Error("Capability budget capability is invalid or duplicated");
    }
    if (
      !Number.isSafeInteger(limit) || limit <= 0 ||
      !Number.isSafeInteger(amount) || amount <= 0 || amount > limit
    ) {
      throw new Error(`Capability budget amount is invalid: ${capability}`);
    }
    seen.add(capability);
    return { capability, limit, amount };
  });
  entries.sort((left, right) => left.capability.localeCompare(right.capability));
  return { projectId, authorizationHash, entries };
}

export function capabilityBudgetSnapshot(value) {
  return JSON.stringify(normalizeCapabilityBudget(value));
}

export function capabilityBudgetForPlan(assessment, manifest) {
  const counts = new Map();
  for (const step of assessment.plan.steps) {
    const rule = manifest.capabilities?.[step.capability];
    if (rule?.maxRuns == null) continue;
    counts.set(step.capability, (counts.get(step.capability) ?? 0) + 1);
  }
  return normalizeCapabilityBudget({
    projectId: assessment.plan.projectId,
    authorizationHash: assessment.authorizationHash,
    entries: [...counts].map(([capability, amount]) => ({
      capability,
      amount,
      limit: Number(manifest.capabilities[capability].maxRuns),
    })),
  });
}
