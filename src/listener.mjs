import { watch } from "node:fs";
import { createHash } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.mjs";
import { DwsAdapter } from "./dws.mjs";
import { createProductionStore } from "./production-store.mjs";
import { safeErrorCode } from "./logging.mjs";
import { isMainModule } from "./main-module.mjs";

function log(type, fields = {}) {
  console.log(JSON.stringify({ type, at: new Date().toISOString(), ...fields }));
}

function checkpointKey(userId) {
  return `dws:last-success:${hashId(userId)}`;
}

function groupCheckpointKey(groupId) {
  return `dws:group-mentions:last-success:${hashId(groupId)}`;
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
    checkpoint: await store.getCheckpoint(checkpointKey(userId)),
    now,
    overlapMs: config.overlapMs,
    initialLookbackHours: config.initialLookbackHours,
  });
  const messages = await dws.fetchBySender({
    senderUserId: userId,
    start,
    end: now,
  });
  const inserted = await store.ingestMessages(messages, now);
  await store.setCheckpoint(checkpointKey(userId), now.toISOString(), now);
  return { fetched: messages.length, inserted };
}

export async function ingestGroupMentions({
  groupId,
  config,
  store,
  dws,
  now = new Date(),
}) {
  const key = groupCheckpointKey(groupId);
  const start = fetchStart({
    checkpoint: await store.getCheckpoint(key),
    now,
    overlapMs: config.overlapMs,
    initialLookbackHours: config.initialLookbackHours,
  });
  const messages = await dws.fetchGroupMentions({
    groupIds: [groupId],
    start,
    end: now,
  });
  const inserted = await store.ingestMessages(messages, now);
  await store.setCheckpoint(key, now.toISOString(), now);
  return { fetched: messages.length, inserted };
}

export async function startListener({
  config = loadConfig({ production: true }),
  store = null,
  dws = new DwsAdapter(config),
  once = process.argv.includes("--once"),
} = {}) {
  store = store ? await store.open() : await createProductionStore(config);
  let checking = false;
  let stopping = false;
  let pendingTrigger = null;
  const activeOperations = new Set();
  let debounceTimer;
  let fallbackTimer;
  let bundleSweepTimer;
  let heartbeatTimer;
  const watchers = [];

  const createTasks = async () => {
    if (await store.isPaused()) return [];
    const taskIds = await store.createReadyTasks({
      quietWindowMs: config.quietWindowMs,
      bundleGapMs: config.bundleGapMs,
      maxMessagesPerTask: config.maxMessagesPerTask,
      maxAttempts: config.maxTaskAttempts,
    });
    if (taskIds.length > 0) log("tasks.queued", { count: taskIds.length });
    return taskIds;
  };

  const runCheck = async (trigger) => {
    if (stopping) return null;
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
            errorCode: safeErrorCode(error),
          });
        }
      }
      for (const groupId of config.targetGroupIds) {
        try {
          const result = await ingestGroupMentions({
            groupId,
            config,
            store,
            dws,
          });
          fetched += result.fetched;
          inserted += result.inserted;
        } catch (error) {
          errors += 1;
          log("listener.group_error", {
            trigger,
            groupHash: hashId(groupId),
            errorCode: safeErrorCode(error),
          });
        }
      }
      const taskIds = await createTasks();
      const paused = await store.isPaused();
      if (errors === 0) {
        await store.setCheckpoint(
          "listener:last-full-success",
          new Date().toISOString(),
        );
      } else {
        await store.setCheckpoint(
          "listener:last-full-failure",
          "target_fetch_failed",
        );
      }
      await store.recordHeartbeat?.("listener");
      log("listener.checked", {
        trigger,
        targets: config.targetUserIds.length,
        groups: config.targetGroupIds.length,
        fetched,
        inserted,
        tasks: taskIds.length,
        paused,
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
    if (stopping) return null;
    const operation = runCheck(trigger)
      .catch((error) => {
        log("listener.error", {
          trigger,
          errorCode: safeErrorCode(error),
        });
        return null;
      })
      .finally(() => activeOperations.delete(operation));
    activeOperations.add(operation);
    return operation;
  };

  const startup = await runCheck("startup");
  if (once) {
    await store.close();
    if (
      startup.errors ===
      config.targetUserIds.length + config.targetGroupIds.length
    ) {
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
        log("listener.watch_error", {
          directoryHash: hashId(directory),
          errorCode: safeErrorCode(error),
        });
      });
    } catch (error) {
      log("listener.watch_error", {
        directoryHash: hashId(directory),
        errorCode: safeErrorCode(error),
      });
    }
  }

  fallbackTimer = setInterval(
    () => safeCheck("fallback"),
    config.fallbackMs,
  );
  heartbeatTimer = setInterval(() => {
    if (stopping) return;
    const operation = store
      .recordHeartbeat?.("listener")
      ?.catch((error) => {
        log("listener.heartbeat_error", {
          errorCode: safeErrorCode(error),
        });
      })
      ?.finally(() => activeOperations.delete(operation));
    if (operation) activeOperations.add(operation);
  }, config.heartbeatMs);
  bundleSweepTimer = setInterval(async () => {
    if (stopping) return;
    const operation = createTasks()
      .catch((error) => {
        log("listener.bundle_error", {
          errorCode: safeErrorCode(error),
        });
      })
      .finally(() => activeOperations.delete(operation));
    activeOperations.add(operation);
    await operation;
  }, Math.min(config.quietWindowMs, 1_000));
  log("listener.started", {
    targets: config.targetUserIds.length,
    groups: config.targetGroupIds.length,
    watchedDirectories: watchers.length,
    fallbackMs: config.fallbackMs,
  });

  const stop = async (signal = "manual") => {
    if (stopping) return;
    stopping = true;
    pendingTrigger = null;
    for (const watcher of watchers) watcher.close();
    clearInterval(fallbackTimer);
    clearInterval(bundleSweepTimer);
    clearInterval(heartbeatTimer);
    clearTimeout(debounceTimer);
    await Promise.allSettled([...activeOperations]);
    await store.close();
    log("listener.stopped", { signal });
  };
  return { stop, runCheck, createTasks };
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const listener = await startListener();
  process.on("SIGINT", async () => {
    await listener.stop("SIGINT");
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await listener.stop("SIGTERM");
    process.exit(0);
  });
}
