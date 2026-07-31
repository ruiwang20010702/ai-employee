import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { generateDraft } from "./draft.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const runtimeDir = new URL(".runtime/", root);
const stateFile = new URL("state.json", runtimeDir);
const eventFile = new URL("events.jsonl", runtimeDir);
const targetUserId = process.env.DINGTALK_TARGET_USER_ID;
const once = process.argv.includes("--once");
const fallbackMs = Number(process.env.DINGTALK_FALLBACK_MS ?? 300_000);
const debounceMs = Number(process.env.DINGTALK_DEBOUNCE_MS ?? 800);

const dingtalkRoot = join(homedir(), "Library/Application Support/DingTalkMac");
const dwsPath = process.env.DWS_PATH ?? join(homedir(), ".local/bin/dws");

if (!targetUserId) {
  throw new Error(
    "DINGTALK_TARGET_USER_ID is required. Copy .env.example and inject it at runtime.",
  );
}

function localTimestamp(date) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { initialized: false, seenMessageIds: [] };
  }
}

async function saveState(state) {
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

async function appendEvent(event) {
  await mkdir(runtimeDir, { recursive: true });
  const previous = await readFile(eventFile, "utf8").catch(() => "");
  await writeFile(eventFile, `${previous}${JSON.stringify(event)}\n`);
}

function collectMessages(payload) {
  const conversations =
    payload?.result?.conversationMessagesList ??
    payload?.conversationMessagesList ??
    [];
  return conversations.flatMap((conversation) =>
    (conversation.messages ?? []).map((message) => ({
      ...message,
      singleChat: conversation.singleChat,
      conversationTitle: conversation.title,
    })),
  );
}

async function fetchRecentMessages() {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const { stdout } = await execFileAsync(
    dwsPath,
    [
      "chat",
      "message",
      "list-by-sender",
      "--sender-user-id",
      targetUserId,
      "--start",
      `${localTimestamp(start).replace(" ", "T")}+08:00`,
      "--end",
      `${localTimestamp(end).replace(" ", "T")}+08:00`,
      "--limit",
      "50",
      "-f",
      "json",
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return collectMessages(JSON.parse(stdout));
}

let checking = false;
async function check(trigger) {
  if (checking) return;
  checking = true;
  try {
    const [state, messages] = await Promise.all([loadState(), fetchRecentMessages()]);
    const ids = messages.map((message) => message.openMessageId).filter(Boolean);

    if (!state.initialized) {
      await saveState({
        initialized: true,
        seenMessageIds: ids.slice(-200),
        lastCheckAt: new Date().toISOString(),
      });
      console.log(JSON.stringify({ type: "ready", baselineMessages: ids.length }));
      return;
    }

    const seen = new Set(state.seenMessageIds);
    const fresh = messages
      .filter((message) => message.openMessageId && !seen.has(message.openMessageId))
      .sort((a, b) => String(a.createTime).localeCompare(String(b.createTime)));

    for (const message of fresh) {
      const event = {
        type: "dingtalk.message.received",
        detectedAt: new Date().toISOString(),
        trigger,
        sender: message.sender,
        senderUserId: targetUserId,
        messageId: message.openMessageId,
        conversationId: message.openConversationId,
        createTime: message.createTime,
        content: message.content,
      };
      await appendEvent(event);
      console.log(JSON.stringify(event));
      try {
        const draft = await generateDraft(event);
        console.log(JSON.stringify(draft));
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "draft.error",
            sourceMessageId: event.messageId,
            message: error.message,
            at: new Date().toISOString(),
          }),
        );
      }
    }

    await saveState({
      initialized: true,
      seenMessageIds: [...new Set([...state.seenMessageIds, ...ids])].slice(-200),
      lastCheckAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "listener.error",
        trigger,
        message: error.message,
        at: new Date().toISOString(),
      }),
    );
  } finally {
    checking = false;
  }
}

async function findAccountDirectory() {
  const { stdout } = await execFileAsync("/usr/bin/find", [
    dingtalkRoot,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "-type",
    "d",
    "-name",
    "*_v3",
  ]);
  const directory = stdout.trim().split("\n").find(Boolean);
  if (!directory) throw new Error("DingTalk account directory was not found");
  return directory;
}

await check("startup");
if (once) process.exit(0);

const accountDirectory = await findAccountDirectory();
const watchDirectories = [
  join(accountDirectory, "DBFiles"),
  join(accountDirectory, "Sync_v2", "point"),
  join(accountDirectory, "SyncPoint"),
];
let debounceTimer;
const signalFiles = new Set([
  "dingtalk.db-wal",
  "dingtalk.db_fts-wal",
  "sync_sync_sync_HZ",
  "synca.dat",
]);
const watchers = watchDirectories.map((directory) =>
  watch(directory, { persistent: true }, (_eventType, filename) => {
    if (!signalFiles.has(String(filename))) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => check("dingtalk-local-event"), debounceMs);
  }),
);

const fallbackTimer = setInterval(() => check("fallback"), fallbackMs);
console.log(
  JSON.stringify({
    type: "listening",
    targetUserId,
    watchDirectories,
    fallbackMs,
  }),
);

function shutdown(signal) {
  for (const watcher of watchers) watcher.close();
  clearInterval(fallbackTimer);
  clearTimeout(debounceTimer);
  console.log(JSON.stringify({ type: "stopped", signal }));
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
