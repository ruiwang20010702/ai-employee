import { createHash } from "node:crypto";
import { containsCredentialMaterial } from "./memory-candidate.mjs";
import { assessWorkPlan } from "./work-plan.mjs";
import { instantiateWorkRecipe } from "./work-recipe.mjs";

const idPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const eventTypePattern = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/u;

function text(value, name, maximum = 200) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${name} must contain 1-${maximum} safe characters`);
  }
  return normalized;
}

function jsonValue(value, name, depth = 0) {
  if (depth > 6) throw new Error(`${name} exceeds maximum nesting depth`);
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${name} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, name, depth + 1));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${name} must be JSON-compatible`);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    text(key, `${name} key`, 100),
    jsonValue(item, name, depth + 1),
  ]));
}

function boundedJsonValue(value, name) {
  const normalized = jsonValue(value, name);
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > 64 * 1024) {
    throw new Error(`${name} exceeds 64 KiB`);
  }
  return normalized;
}

function containsPersistedCredential(value) {
  if (Array.isArray(value)) return value.some(containsPersistedCredential);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, item]) =>
      containsCredentialMaterial(`${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`) ||
      containsPersistedCredential(item));
  }
  return typeof value === "string" && containsCredentialMaterial(value);
}

function persistedTriggerValue(value, name) {
  const normalized = boundedJsonValue(value, name);
  if (containsPersistedCredential(normalized)) {
    throw new Error(`${name} cannot persist credential material`);
  }
  return normalized;
}

function eventFilters(value) {
  const normalized = persistedTriggerValue(value ?? {}, "trigger.event.filters");
  for (const key of Object.keys(normalized)) {
    if (
      !/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+){0,4}$/u.test(key) ||
      key.split(".").some((segment) => ["__proto__", "prototype", "constructor"].includes(segment))
    ) {
      throw new Error("Trigger event filter must use a bounded payload path");
    }
  }
  return normalized;
}

function utcTimestamp(value, name) {
  const normalized = text(value, name, 100);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new Error(`${name} must be an ISO 8601 UTC timestamp`);
  }
  return normalized;
}

function valueBindings(input = {}) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error("trigger.valueBindings must be an object");
  }
  return Object.fromEntries(Object.entries(input).map(([name, path]) => {
    if (!/^[a-z][a-zA-Z0-9_]*$/u.test(name)) throw new Error("Trigger input name is invalid");
    const normalized = text(path, `trigger.valueBindings.${name}`, 200);
    if (!/^payload(?:\.[a-zA-Z0-9_]+){1,5}$/u.test(normalized)) {
      throw new Error("Trigger value binding must be a bounded event payload path");
    }
    return [name, normalized];
  }));
}

export function validateWorkTrigger(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error("Work trigger must be an object");
  }
  if (input.version !== 1) throw new Error("Work trigger version must be 1");
  const id = text(input.id, "trigger.id", 100);
  const recipeId = text(input.recipeId, "trigger.recipeId", 100);
  if (!idPattern.test(id) || !idPattern.test(recipeId)) throw new Error("Trigger or recipe id is invalid");
  const kind = input.kind;
  if (!["schedule", "event"].includes(kind)) throw new Error("Trigger kind must be schedule or event");
  const common = {
    version: 1,
    id,
    projectId: text(input.projectId, "trigger.projectId", 64),
    recipeId,
    recipeVersion: Number(input.recipeVersion ?? 1),
    requesterId: text(input.requesterId, "trigger.requesterId", 500),
    kind,
    enabled: input.enabled === true,
    maxRunsPerDay: Number(input.maxRunsPerDay ?? 1),
    cooldownMinutes: Number(input.cooldownMinutes ?? 15),
    values: persistedTriggerValue(input.values ?? {}, "trigger.values"),
    valueBindings: valueBindings(input.valueBindings),
  };
  if (common.recipeVersion !== 1) throw new Error("Trigger recipeVersion must be 1");
  if (!Number.isSafeInteger(common.maxRunsPerDay) || common.maxRunsPerDay < 1 || common.maxRunsPerDay > 100) {
    throw new Error("Trigger maxRunsPerDay must be between 1 and 100");
  }
  if (!Number.isSafeInteger(common.cooldownMinutes) || common.cooldownMinutes < 1 || common.cooldownMinutes > 1_440) {
    throw new Error("Trigger cooldownMinutes must be between 1 and 1440");
  }
  if (kind === "schedule") {
    const intervalMinutes = Number(input.schedule?.intervalMinutes);
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 43_200) {
      throw new Error("Schedule intervalMinutes must be between 5 and 43200");
    }
    if (Object.keys(common.valueBindings).length > 0) {
      throw new Error("Schedule triggers cannot bind event payload values");
    }
    return {
      ...common,
      schedule: {
        startsAt: utcTimestamp(input.schedule?.startsAt, "trigger.schedule.startsAt"),
        intervalMinutes,
      },
    };
  }
  const type = text(input.event?.type, "trigger.event.type", 100);
  if (!eventTypePattern.test(type)) throw new Error("Trigger event type is invalid");
  return {
    ...common,
    event: {
      type,
      filters: eventFilters(input.event?.filters),
    },
  };
}

export function validateWorkEvent(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error("Work event must be an object");
  }
  const id = text(input.id, "event.id", 200);
  const type = text(input.type, "event.type", 100);
  if (!eventTypePattern.test(type)) throw new Error("Work event type is invalid");
  return {
    version: 1,
    id,
    type,
    occurredAt: utcTimestamp(input.occurredAt, "event.occurredAt"),
    payload: boundedJsonValue(input.payload ?? {}, "event.payload"),
    source: text(input.source, "event.source", 100),
  };
}

function containsFilter(payload, filters) {
  return Object.entries(filters).every(([key, expected]) => {
    const actual = key.split(".").reduce(
      (value, segment) => value && Object.hasOwn(value, segment) ? value[segment] : undefined,
      payload,
    );
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
}

export function workTriggerMatchesEvent(triggerInput, eventInput) {
  const trigger = validateWorkTrigger(triggerInput);
  const event = validateWorkEvent(eventInput);
  return trigger.enabled && trigger.kind === "event" && trigger.event.type === event.type &&
    containsFilter(event.payload, trigger.event.filters);
}

export function nextScheduledRun(triggerInput, after = new Date()) {
  const trigger = validateWorkTrigger(triggerInput);
  if (trigger.kind !== "schedule") throw new Error("Next run requires a schedule trigger");
  const start = new Date(trigger.schedule.startsAt).getTime();
  const interval = trigger.schedule.intervalMinutes * 60_000;
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) throw new Error("Schedule cursor is invalid");
  if (afterMs < start) return new Date(start);
  return new Date(start + (Math.floor((afterMs - start) / interval) + 1) * interval);
}

function getPath(event, path) {
  return path.split(".").reduce((value, segment) => value?.[segment], event);
}

export function triggerRunKey({ triggerId, scheduledFor = null, eventId = null }) {
  const raw = scheduledFor
    ? `schedule:${text(triggerId, "triggerId", 100)}:${utcTimestamp(scheduledFor, "scheduledFor")}`
    : `event:${text(triggerId, "triggerId", 100)}:${text(eventId, "eventId", 200)}`;
  return createHash("sha256").update(raw).digest("hex");
}

export function buildTriggeredWorkPlan({ trigger: triggerInput, recipe, manifest, scheduledFor, event }) {
  const trigger = validateWorkTrigger(triggerInput);
  if (!trigger.enabled) throw new Error("Disabled trigger cannot create work");
  if (manifest.projectId !== trigger.projectId) throw new Error("Trigger project does not match manifest");
  if (!(manifest.profile?.selectedRecipeIds ?? []).includes(trigger.recipeId)) {
    throw new Error("Trigger recipe is not selected by the project");
  }
  if (recipe.id !== trigger.recipeId || recipe.version !== trigger.recipeVersion) {
    throw new Error("Trigger recipe version does not match");
  }
  let runKey;
  let values = { ...trigger.values };
  if (trigger.kind === "schedule") {
    const timestamp = utcTimestamp(scheduledFor, "scheduledFor");
    runKey = triggerRunKey({ triggerId: trigger.id, scheduledFor: timestamp });
  } else {
    const normalizedEvent = validateWorkEvent(event);
    if (!workTriggerMatchesEvent(trigger, normalizedEvent)) throw new Error("Work event does not match trigger");
    runKey = triggerRunKey({ triggerId: trigger.id, eventId: normalizedEvent.id });
    values = {
      ...values,
      ...Object.fromEntries(Object.entries(trigger.valueBindings).map(([name, path]) => [
        name,
        getPath(normalizedEvent, path),
      ])),
    };
  }
  const instantiated = instantiateWorkRecipe(recipe, {
    projectId: trigger.projectId,
    requesterId: trigger.requesterId,
    projectRoot: manifest.rootDirectory,
    values,
    trigger: { id: trigger.id, runKey },
  });
  return {
    runKey,
    assessment: assessWorkPlan({ manifest, plan: instantiated.plan }),
  };
}
