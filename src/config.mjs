import { homedir } from "node:os";
import { join } from "node:path";

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function commaSeparated(name, fallback = "") {
  return String(process.env[name] ?? fallback)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function loadConfig({ requireTargets = true } = {}) {
  const targetUserIds = [
    ...new Set([
      ...commaSeparated("DINGTALK_TARGET_USER_IDS"),
      ...commaSeparated("DINGTALK_TARGET_USER_ID"),
    ]),
  ];

  if (requireTargets && targetUserIds.length === 0) {
    throw new Error(
      "DINGTALK_TARGET_USER_IDS or DINGTALK_TARGET_USER_ID is required",
    );
  }

  return {
    targetUserIds,
    selfUserId: process.env.DINGTALK_SELF_USER_ID?.trim() || null,
    dwsPath: process.env.DWS_PATH ?? join(homedir(), ".local/bin/dws"),
    dwsMock: process.env.DWS_MOCK === "true",
    codexPath: process.env.CODEX_PATH ?? "/opt/homebrew/bin/codex",
    dingtalkRoot:
      process.env.DINGTALK_DATA_ROOT ??
      join(homedir(), "Library/Application Support/DingTalkMac"),
    databasePath: process.env.AI_EMPLOYEE_DATABASE_PATH || null,
    fallbackMs: positiveNumber("DINGTALK_FALLBACK_MS", 300_000),
    debounceMs: positiveNumber("DINGTALK_DEBOUNCE_MS", 800),
    quietWindowMs: positiveNumber("DINGTALK_QUIET_WINDOW_MS", 3_000),
    initialLookbackHours: positiveNumber(
      "DINGTALK_INITIAL_LOOKBACK_HOURS",
      72,
    ),
    overlapMs: positiveNumber("DINGTALK_FETCH_OVERLAP_MS", 600_000),
    workerPollMs: positiveNumber("AI_EMPLOYEE_WORKER_POLL_MS", 2_000),
    maxTaskAttempts: positiveNumber("AI_EMPLOYEE_MAX_TASK_ATTEMPTS", 5),
    capabilities: new Set(
      commaSeparated("AI_EMPLOYEE_ALLOWED_CAPABILITIES", "draft_reply"),
    ),
    debugContent: process.env.AI_EMPLOYEE_DEBUG_CONTENT === "true",
  };
}
