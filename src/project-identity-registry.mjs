import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const subjectPattern = /^[a-z][a-z0-9_]{1,63}$/u;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateProjectIdentityRegistry(input) {
  if (
    !input ||
    Array.isArray(input) ||
    input.schema !== "foursday-project-identities/v1" ||
    !Array.isArray(input.projects) ||
    input.projects.length < 1 ||
    input.projects.length > 100
  ) throw new Error("Project identity registry is invalid");
  const subjects = new Set();
  const aliases = new Map();
  const projects = input.projects.map((raw) => {
    const subject = String(raw?.subject ?? "").trim();
    const canonicalName = String(raw?.canonicalName ?? "").normalize("NFKC").trim();
    const normalizedAliases = [...new Set((raw?.aliases ?? []).map((alias) =>
      String(alias).normalize("NFKC").trim()).filter(Boolean))];
    if (
      !subjectPattern.test(subject) ||
      subjects.has(subject) ||
      !canonicalName ||
      canonicalName.length > 120 ||
      normalizedAliases.length < 1 ||
      normalizedAliases.length > 20 ||
      normalizedAliases.some((alias) => alias.length > 120) ||
      !normalizedAliases.includes(canonicalName)
    ) throw new Error("Project identity entry is invalid");
    subjects.add(subject);
    for (const alias of normalizedAliases) {
      const key = alias.toLowerCase();
      const existing = aliases.get(key);
      if (existing && existing !== subject) {
        throw new Error("Project identity alias is ambiguous");
      }
      aliases.set(key, subject);
    }
    return { subject, canonicalName, aliases: normalizedAliases };
  });
  return { schema: input.schema, projects };
}

export async function loadProjectIdentityRegistry(path) {
  return validateProjectIdentityRegistry(
    JSON.parse(await readFile(resolve(path), "utf8")),
  );
}

export function projectIdentityRegistryDigest(registry) {
  return createHash("sha256").update(canonicalJson(registry)).digest("hex");
}

function sameIdentity(memory, project) {
  return memory.status === "confirmed" &&
    memory.scope?.factKey === "identity.project_aliases" &&
    memory.scope?.canonicalName === project.canonicalName &&
    canonicalJson(memory.scope?.aliases ?? []) === canonicalJson(project.aliases);
}

export async function applyProjectIdentityRegistry({
  store,
  registry,
  actor,
  confirmation,
  apply = false,
  now = new Date(),
} = {}) {
  const validated = validateProjectIdentityRegistry(registry);
  const digest = projectIdentityRegistryDigest(validated);
  const expectedConfirmation = `PROJECTS-${digest.slice(0, 12).toUpperCase()}`;
  const preview = {
    schema: validated.schema,
    digest,
    confirmation: expectedConfirmation,
    projects: validated.projects.map((project) => ({
      subject: project.subject,
      canonicalName: project.canonicalName,
      aliases: project.aliases,
    })),
    writes: apply ? "confirmed_project_identity_memories_only" : "none",
    capabilitiesChanged: false,
    externalSystemsTouched: false,
  };
  if (!apply) return { ...preview, applied: false, created: 0, unchanged: 0 };
  if (confirmation !== expectedConfirmation) {
    throw new Error("Project identity confirmation does not match the current registry");
  }
  if (!String(actor ?? "").trim()) throw new Error("Project identity actor is required");
  let created = 0;
  let unchanged = 0;
  for (const project of validated.projects) {
    const existing = (await store.listMemories({
      type: "project",
      subject: project.subject,
      statuses: ["proposed", "confirmed"],
      limit: 100,
    })).filter((memory) => memory.scope?.factKey === "identity.project_aliases");
    if (existing.some((memory) => sameIdentity(memory, project))) {
      unchanged += 1;
      continue;
    }
    if (existing.length > 0) {
      throw new Error(`Project identity already exists with different aliases: ${project.subject}`);
    }
    const memoryId = await store.proposeMemory({
      type: "project",
      subject: project.subject,
      projectId: project.subject,
      statement: `项目身份为 ${project.canonicalName}；允许通过已确认别名关联当前聊天。`,
      sourceType: "operator_confirmed_project_index",
      sourceId: `project-identity-registry:${digest}`,
      sourceVersion: digest,
      scope: {
        factKey: "identity.project_aliases",
        canonicalName: project.canonicalName,
        aliases: project.aliases,
      },
      confidence: 1,
      sensitivity: "internal",
      createdBy: actor,
    }, now);
    await store.confirmMemory(memoryId, actor, now);
    created += 1;
  }
  return { ...preview, applied: true, created, unchanged };
}
