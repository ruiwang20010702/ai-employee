function text(value, name, maximum = 200) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function textList(value, name, maximum = 20) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${name} must be an array with at most ${maximum} items`);
  }
  return [...new Set(value.map((item) => text(item, name)))];
}

export function validateProjectProfile(input = {}) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error("profile must be an object");
  }
  const profile = {
    objective: text(input.objective, "profile.objective", 1_000),
    successCriteria: textList(
      input.successCriteria ?? [],
      "profile.successCriteria",
    ),
    milestones: textList(input.milestones ?? [], "profile.milestones"),
    collaborationObjects: textList(
      input.collaborationObjects ?? [],
      "profile.collaborationObjects",
    ),
    selectedRecipeIds: textList(
      input.selectedRecipeIds ?? [],
      "profile.selectedRecipeIds",
      20,
    ),
    memoryScope: {
      allowedTypes: textList(
        input.memoryScope?.allowedTypes ?? ["project", "principle"],
        "profile.memoryScope.allowedTypes",
        3,
      ),
      retentionDays: Number(input.memoryScope?.retentionDays ?? 90),
    },
  };
  if (
    profile.memoryScope.allowedTypes.some(
      (type) => !["project", "principle", "person"].includes(type),
    )
  ) {
    throw new Error("profile.memoryScope.allowedTypes contains an unsupported type");
  }
  if (
    !Number.isSafeInteger(profile.memoryScope.retentionDays) ||
    profile.memoryScope.retentionDays < 1 ||
    profile.memoryScope.retentionDays > 365
  ) {
    throw new Error("profile.memoryScope.retentionDays must be between 1 and 365");
  }
  if (
    profile.selectedRecipeIds.some(
      (id) => !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(id),
    )
  ) {
    throw new Error("profile.selectedRecipeIds contains an invalid recipe id");
  }
  return profile;
}
