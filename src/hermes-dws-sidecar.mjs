import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DwsAdapter, isAutomatedSelfMessage } from "./dws.mjs";
import { discoverWatchDirectories } from "./listener.mjs";
import { isMainModule } from "./main-module.mjs";

function csv(value) {
  return [...new Set(String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("DWS sidecar timing configuration is invalid");
  }
  return parsed;
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function epoch(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function messageIdFromReceipt(receipt) {
  const queue = [receipt];
  for (let depth = 0; queue.length > 0 && depth < 200; depth += 1) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (
        typeof child === "string" &&
        /^(?:openMessageId|messageId|msgId)$/u.test(key) &&
        child.trim()
      ) return child.trim();
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return null;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function readBackSentMessage({ dws, route, conversationId, evidence }) {
  if (typeof dws.fetchDirect !== "function") return null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt > 0) await sleep(1_000);
    let messages;
    try {
      messages = await dws.fetchDirect({
        userId: route.recipientId,
        identityKind: route.recipientKind ?? null,
        before: new Date(),
        limit: 50,
        lookbackMs: 10 * 60 * 1_000,
      });
    } catch {
      continue;
    }
    const matched = messages.filter((message) =>
      message.conversationId === conversationId &&
      isAutomatedSelfMessage(message, [evidence])
    );
    if (matched.length === 1 && String(matched[0].id ?? "").trim()) {
      return String(matched[0].id).trim();
    }
  }
  return null;
}

function emptyState() {
  return {
    lastUsers: {}, lastGroups: {}, recentMessageIds: [],
    recipients: {}, activeConversations: {}, takeoverReported: [],
  };
}

async function loadState(path) {
  if (!path) return emptyState();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return {
      lastUsers: parsed?.lastUsers && typeof parsed.lastUsers === "object" ? parsed.lastUsers : {},
      lastGroups: parsed?.lastGroups && typeof parsed.lastGroups === "object" ? parsed.lastGroups : {},
      recentMessageIds: Array.isArray(parsed?.recentMessageIds)
        ? parsed.recentMessageIds.map(String).filter(Boolean).slice(-5_000)
        : [],
      recipients: parsed?.recipients && typeof parsed.recipients === "object"
        ? parsed.recipients
        : {},
      activeConversations:
        parsed?.activeConversations && typeof parsed.activeConversations === "object"
          ? parsed.activeConversations
          : {},
      takeoverReported: Array.isArray(parsed?.takeoverReported)
        ? parsed.takeoverReported.map(String).filter(Boolean)
        : [],
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

async function saveState(path, state) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export function sidecarConfig(environment = process.env) {
  const dwsPath = String(environment.DWS_PATH ?? "").trim();
  if (!isAbsolute(dwsPath)) throw new Error("DWS_PATH must be absolute");
  const stateFile = String(environment.DWS_PERSONAL_STATE_FILE ?? "").trim();
  if (stateFile && !isAbsolute(stateFile)) {
    throw new Error("DWS_PERSONAL_STATE_FILE must be absolute");
  }
  return {
    dwsPath: resolve(dwsPath),
    dingtalkRoot: String(
      environment.DINGTALK_ROOT ?? environment.DINGTALK_DATA_ROOT ?? "",
    ).trim(),
    userIds: csv(
      environment.DWS_PERSONAL_FETCH_USERS ??
      environment.DWS_PERSONAL_ALLOWED_USERS,
    ),
    groupIds: csv(environment.DWS_PERSONAL_ALLOWED_GROUPS),
    selfUserId: String(environment.DINGTALK_SELF_USER_ID ?? "").trim() || null,
    stateFile: stateFile ? resolve(stateFile) : null,
    initialLookbackMs: boundedInteger(
      environment.DWS_PERSONAL_INITIAL_LOOKBACK_MS,
      120_000,
      10_000,
      24 * 60 * 60 * 1_000,
    ),
    fallbackMs: boundedInteger(
      environment.DWS_PERSONAL_FALLBACK_MS,
      30_000,
      5_000,
      5 * 60 * 1_000,
    ),
    sendEnabled: String(environment.DWS_PERSONAL_SEND_ENABLED ?? "false").toLowerCase() === "true",
  };
}

export async function createSidecarRuntime({
  config = sidecarConfig(),
  dws = new DwsAdapter({ dwsPath: config.dwsPath }),
  emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`),
  now = () => new Date(),
} = {}) {
  await access(config.dwsPath);
  const state = await loadState(config.stateFile);
  const seen = new Set(state.recentMessageIds);
  const recipients = new Map(Object.entries(state.recipients));
  const activeConversations = new Map(Object.entries(state.activeConversations));
  const takeoverReported = new Set(state.takeoverReported);
  const automatedSendEvidence = [];
  const watchers = [];
  let fallbackTimer = null;
  let debounceTimer = null;
  let running = false;
  let pending = false;

  const remember = (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 5_000) seen.delete(seen.values().next().value);
    state.recentMessageIds = [...seen];
    return true;
  };

  const emitMessage = (message, chatType, mentionedSelf) => {
    const id = String(message.id ?? "").trim();
    const conversationId = String(message.conversationId ?? "").trim();
    const senderUserId = String(message.senderUserId ?? "").trim();
    const senderOpenDingTalkId = String(message.senderOpenDingTalkId ?? "").trim();
    const createTime = new Date(message.createTime).toISOString();
    if (!id || !conversationId || !senderUserId || !remember(id)) return;
    if (message.isWithdrawn === true) {
      emit({
        type: "event",
        record: {
          control: "message_withdrawn",
          id: `withdrawn:${hash(id)}`,
          messageId: id,
          conversationId,
          participantUserId: senderUserId,
          chatType,
          createTime: message.withdrawnAt
            ? new Date(message.withdrawnAt).toISOString()
            : createTime,
        },
      });
      return;
    }
    recipients.set(conversationId, {
      chatType,
      recipientId: senderOpenDingTalkId || senderUserId,
      recipientKind: senderOpenDingTalkId ? "open_dingtalk_id" : "user_id",
    });
    state.recipients = Object.fromEntries(recipients);
    activeConversations.set(conversationId, {
      participantUserId: senderUserId,
      chatType,
      after: createTime,
    });
    state.activeConversations = Object.fromEntries(activeConversations);
    emit({
      type: "event",
      record: {
        id,
        senderUserId,
        senderOpenDingTalkId: senderOpenDingTalkId || null,
        senderName: String(message.senderName ?? "").trim() || senderUserId,
        conversationId,
        content: String(message.content ?? "").trim(),
        createTime,
        chatType,
        mentionedSelf,
        isSelf: message.isSelf === true,
      },
    });
  };

  const check = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const end = now();
      for (const userId of config.userIds) {
        const last = epoch(state.lastUsers[userId]);
        const start = new Date(last == null
          ? end.getTime() - config.initialLookbackMs
          : Math.max(0, last - 5_000));
        const messages = await dws.fetchBySender({ senderUserId: userId, start, end });
        for (const message of messages) emitMessage(message, "direct", false);
        state.lastUsers[userId] = end.toISOString();
      }
      for (const groupId of config.groupIds) {
        const last = epoch(state.lastGroups[groupId]);
        const start = new Date(last == null
          ? end.getTime() - config.initialLookbackMs
          : Math.max(0, last - 5_000));
        const messages = await dws.fetchGroupMentions({ groupIds: [groupId], start, end });
        for (const message of messages) emitMessage(message, "group", true);
        state.lastGroups[groupId] = end.toISOString();
      }
      if (config.selfUserId && typeof dws.hasManualReply === "function") {
        for (const [conversationId, active] of activeConversations) {
          if (takeoverReported.has(conversationId)) continue;
          const manual = await dws.hasManualReply({
            conversationId,
            selfUserId: config.selfUserId,
            after: active.after,
            now: end,
            automatedSendEvidence,
          });
          if (manual?.known === true && manual.replied === true) {
            takeoverReported.add(conversationId);
            state.takeoverReported = [...takeoverReported];
            emit({
              type: "event",
              record: {
                control: "human_takeover",
                id: `takeover:${hash(conversationId)}:${end.getTime()}`,
                conversationId,
                participantUserId: active.participantUserId,
                chatType: active.chatType,
                createTime: end.toISOString(),
              },
            });
          }
        }
      }
      await saveState(config.stateFile, state);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        queueMicrotask(() => check().catch((error) => {
          process.stderr.write(`dws_sidecar_check_failed:${String(error?.code ?? error?.name ?? "error")}\n`);
        }));
      }
    }
  };

  const trigger = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => check().catch((error) => {
      process.stderr.write(`dws_sidecar_check_failed:${String(error?.code ?? error?.name ?? "error")}\n`);
    }), 250);
  };

  if (config.dingtalkRoot && isAbsolute(config.dingtalkRoot)) {
    for (const directory of await discoverWatchDirectories(config.dingtalkRoot)) {
      const watcher = watch(directory, { persistent: true }, trigger);
      watcher.on("error", () => {});
      watchers.push(watcher);
    }
  }
  fallbackTimer = setInterval(trigger, config.fallbackMs);

  return {
    async start() {
      emit({
        type: "ready",
        transport: watchers.length > 0 ? "filesystem-events-with-fallback" : "fallback",
        targets: config.userIds.length,
        groups: config.groupIds.length,
      });
      await check();
    },
    async send(payload) {
      if (!config.sendEnabled) {
        return { success: false, error: "DWS personal send is disabled" };
      }
      const conversationId = String(payload?.conversationId ?? "").trim();
      const route = recipients.get(conversationId);
      if (!route) return { success: false, error: "DWS conversation recipient is unknown" };
      const idempotencyKey = randomUUID();
      const startedAt = new Date().toISOString();
      const receipt = await dws.sendMessage({
        conversationId,
        recipientId: route.recipientId,
        recipientKind: route.recipientKind ?? null,
        chatType: route.chatType,
        text: String(payload?.content ?? ""),
        idempotencyKey,
      });
      dws.verifySendReceipt(receipt);
      const evidence = {
        conversationId,
        taskId: idempotencyKey,
        idempotencyKey,
        startedAt,
        content: String(payload?.content ?? ""),
        receipt,
      };
      const serverMessageId = messageIdFromReceipt(receipt) ??
        await readBackSentMessage({ dws, route, conversationId, evidence });
      if (!serverMessageId) {
        return {
          success: false,
          outcomeUnknown: true,
          error: "DWS explicit receipt did not include a server message ID",
        };
      }
      automatedSendEvidence.push(evidence);
      if (automatedSendEvidence.length > 1_000) automatedSendEvidence.shift();
      return {
        success: true,
        messageId: serverMessageId,
        receiptKind: "server",
      };
    },
    async stop() {
      clearInterval(fallbackTimer);
      clearTimeout(debounceTimer);
      for (const watcher of watchers) watcher.close();
      await saveState(config.stateFile, state);
    },
    check,
  };
}

async function runProtocol() {
  const runtime = await createSidecarRuntime();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", async (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame?.type !== "request") return;
    const id = String(frame.id ?? "");
    try {
      const result = frame.action === "send"
        ? await runtime.send(frame.payload)
        : frame.action === "shutdown"
          ? { success: true }
          : { success: false, error: "Unsupported DWS sidecar action" };
      process.stdout.write(`${JSON.stringify({ type: "response", id, result })}\n`);
      if (frame.action === "shutdown") {
        await runtime.stop();
        process.exit(0);
      }
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        type: "response",
        id,
        result: { success: false, error: String(error?.code ?? error?.name ?? "error") },
      })}\n`);
    }
  });
  await runtime.start();
}

if (isMainModule(import.meta.url)) {
  await runProtocol();
}

export { hash };
