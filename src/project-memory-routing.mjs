function normalized(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function aliasMatches(text, alias) {
  if (!text || !alias) return false;
  if (/^[a-z0-9][a-z0-9 ._-]*$/u.test(alias)) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "u").test(text);
  }
  return text.includes(alias);
}

function identityAliases(memory) {
  if (
    memory?.status !== "confirmed" ||
    memory?.type !== "project" ||
    memory?.scope?.factKey !== "identity.project_aliases" ||
    !Array.isArray(memory.scope.aliases)
  ) return [];
  return [...new Set([
    memory.subject,
    memory.scope.canonicalName,
    ...memory.scope.aliases,
  ].map(normalized).filter(Boolean))];
}

export function routeProjectMemories({ text = "", memories = [] } = {}) {
  const haystack = normalized(text);
  if (!haystack) return [];
  const matches = memories.flatMap((memory) => {
    const aliases = identityAliases(memory).filter((alias) => aliasMatches(haystack, alias));
    if (aliases.length === 0) return [];
    const alias = aliases.sort((left, right) => right.length - left.length)[0];
    return [{ subject: memory.subject, alias }];
  });
  const selectedSubjects = new Set(
    matches
      .filter((candidate) => !matches.some((other) =>
        other.subject !== candidate.subject &&
        other.alias.length > candidate.alias.length &&
        other.alias.includes(candidate.alias)))
      .map((match) => match.subject),
  );
  return memories.filter(
    (memory) => memory.status === "confirmed" &&
      memory.type === "project" &&
      selectedSubjects.has(memory.subject),
  );
}
