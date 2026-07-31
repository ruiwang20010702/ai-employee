import { watch } from "node:fs";
import { createHash } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { DwsAdapter } from "./dws.mjs";
import { Store } from "./store.mjs";

function log(type, fields = {}) {
  console.log(JSON.stringify({ type, at: new Date().toISOString(), ...fields }));
}

function checkpointKey(userId) {
  return `dws:last-success:${hashId(userId)}`;
}

function hashId(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function fetchStart({
  checkpoint,
  now,
  overlapMs,
  initialLookbackHours,
}) {
  if (checkpoint) {
    const parsed = new Date(checkpoint);
    if (!Number.isNaN(parsed.getTime())) {
      return new Date(parsed.getTime() - overlapMs);
    }
  }
  return new Date(now.getTime() - initialLookbackHours * 60 * 60 * 1000);
}

export async function discoverWatchDirectories(dingtalkRoot) {
  const entries = await readdir(dingtalkRoot, { withFileTypes: true }).catch(
    () => [],
  );
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("_v3"))
    .flatMap((entry) => {
      const accountDirectory = join(dingtalkRoot, entry.name);
      return [
        join(accountDirectory, "DBFiles"),
        join(accountDirectory, "Sync_v2", "point"),
        join(accountDirectory, "SyncPoint"),
      ];
    });
  const existing = [];
  for (const directory of candidates) {
    if (await access(directory).then(() => true).catch(() => false)) {
      existing.push(directory);
    }
  }
  return [...new Set(existing)];
}

export async function ingestTarget({
  userId,
  config,
  store,
  dws,
  now = new Date(),
}) {
  const start = fetchStart({
    checkpoint: store.getCheckpoint(checkpointKey(userId)),
    now,
    overlapMs: config.overlapMs,
    initialLookbackHours: config.initialLookbackHours,
  });
  const messages = await dws.fetchBySender({
    senderUserId: userId,
    start,
    end: now,
  });
  const inserted = store.ingestMessages(messages, now);
  store.setCheckpoint(checkpointKey(userId), now.toISOString(), now);
  return { fetched: messages.length, inserted };
}

export async function startListener({
  config = loadConfig(),
  store = new Store(config.databasePath),
  dws = new DwsAdapter(config),
  once = process.argv.includes("--once"),
} = {}) {
  await store.open();
  let checking = false;
  let pendingTrigger = null;
  let debounceTimer;
  let fallbackTimer;
  let bundleSweepTimer;
  const watchers = [];

  const createTasks = () => {
    if (store.isPaused()) return [];
    const taskIds = store.createReadyTasks({
      quietWindowMs: config.quietWindowMs,
      maxAttempts: config.maxTaskAttempts,
    });
    if (taskIds.length > 0) log("tasks.queued", { count: taskIds.length });
    return taskIds;
  };

  const runCheck = async (trigger) => {
    if (checking) {
      pendingTrigger = trigger;
      return;
    }
    checking = true;
    try {
      let fetched = 0;
      let inserted = 0;
      let errors = 0;
      for (const userId of config.targetUserIds) {
        try {
          const result = await ingestTarget({ userId, config, store, dws });
          fetched += result.fetched;
          inserted += result.inserted;
        } catch (error) {
          errors += 1;
          log("listener.target_error", {
            trigger,
            targetHash: hashId(userId),
            message: error.message,
          });
        }
      }
      const taskIds = createTasks();
      log("listener.checked", {
        trigger,
        targets: config.targetUserIds.length,
        fetched,
        inserted,
        tasks: taskIds.length,
        paused: store.isPaused(),
        errors,
      });
      return {
        fetched,
        inserted,
        tasks: taskIds.length,
        errors,
      };
    } finally {
      checking = false;
      if (pendingTrigger) {
        const next = pendingTrigger;
        pendingTrigger = null;
        queueMicrotask(() => safeCheck(next));
      }
    }
  };

  const safeCheck = async (trigger) => {
    try {
      return await runCheck(trigger);
    } catch (error) {
      log("listener.error", { trigger, message: error.message });
      return null;
    }
  };

  const startup = await runCheck("startup");
  if (once) {
    store.close();
    if (startup.errors === config.targetUserIds.length) {
      throw new Error("DWS fetch failed for every configured target");
    }
    return { stop() {} };
  }

  const signalFiles = new Set([
    "dingtalk.db-wal",
    "dingtalk.db_fts-wal",
    "sync_sync_sync_HZ",
    "synca.dat",
  ]);
  const watchDirectories = await discoverWatchDirectories(config.dingtalkRoot);
  for (const directory of watchDirectories) {
    try {
      watchers.push(
        watch(directory, { persistent: true }, (_eventType, filename) => {
          if (!signalFiles.has(String(filename))) return;
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(
            () => safeCheck("dingtalk-local-event"),
            config.debounceMs,
          );
        }),
      );
      watchers.at(-1).on("error", (error) => {
        log("listener.watch_error", { directory, message: error.message });
      });
    } catch (error) {
      log("listener.watch_error", { directory, message: error.message });
    }
  }

  fallbackTimer = setInterval(
    () => safeCheck("fallback"),
    config.fallbackMs,
  );
  bundleSweepTimer = setInterval(() => {
    try {
      createTasks();
    } catch (error) {
      log("listener.bundle_error", { message: error.message });
    }
  }, Math.min(config.quietWindowMs, 1_000));
  log("listener.started", {
    targets: config.targetUserIds.length,
    watchedDirectories: watchers.length,
    fallbackMs: config.fallbackMs,
  });

  const stop = (signal = "manual") => {
    for (const watcher of watchers) watcher.close();
    clearInterval(fallbackTimer);
    clearInterval(bundleSweepTimer);
    clearTimeout(debounceTimer);
    store.close();
    log("listener.stopped", { signal });
  };
  return { stop, runCheck, createTasks };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const listener = await startListener();
  process.on("SIGINT", () => {
    listener.stop("SIGINT");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    listener.stop("SIGTERM");
    process.exit(0);
  });
}
