function key(memory) {
  const factKey = memoryFactKey(memory);
  if (!factKey) return null;
  return [memory.type, memory.project_id ?? "", memory.subject_key, factKey].join("\n");
}

function normalizedStatement(memory) {
  return String(memory.statement ?? "").trim();
}

export function memoryFactKey(memory) {
  const value = memory?.scope?.factKey;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function analyzeMemoryConflicts(memories = [], now = new Date()) {
  const confirmedByKey = new Map();
  for (const memory of memories.filter((item) =>
    item.status === "confirmed" &&
    !item.deleted_at &&
    (!item.expires_at || new Date(item.expires_at) > now))) {
    const memoryKey = key(memory);
    if (!memoryKey) continue;
    const group = confirmedByKey.get(memoryKey) ?? [];
    group.push(memory);
    confirmedByKey.set(memoryKey, group);
  }
  const candidates = memories.filter(
    (memory) => memory.status === "proposed" && memoryFactKey(memory),
  );
  const items = candidates.map((candidate) => {
    const confirmed = confirmedByKey.get(key(candidate)) ?? [];
    const duplicates = confirmed.filter(
      (memory) => normalizedStatement(memory) === normalizedStatement(candidate),
    );
    const conflicts = confirmed.filter(
      (memory) => normalizedStatement(memory) !== normalizedStatement(candidate),
    );
    return {
      memoryId: candidate.id,
      conflictIds: conflicts.map((memory) => memory.id),
      duplicateIds: duplicates.map((memory) => memory.id),
      requiresResolution: conflicts.length > 0 || duplicates.length > 0,
    };
  });
  const activeConflictGroups = [...confirmedByKey.values()].filter(
    (group) => new Set(group.map(normalizedStatement)).size > 1,
  ).length;
  const conflictCandidates = items.filter(
    (item) => item.conflictIds.length > 0,
  ).length;
  const duplicateCandidates = items.filter(
    (item) => item.duplicateIds.length > 0,
  ).length;
  return {
    candidates: candidates.length,
    conflictCandidates,
    duplicateCandidates,
    activeConflictGroups,
    conflictRate: candidates.length === 0 ? null : conflictCandidates / candidates.length,
    healthy: activeConflictGroups === 0,
    items,
  };
}
