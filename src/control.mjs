import { loadConfig } from "./config.mjs";
import { createProductionStore } from "./production-store.mjs";
import { applyProductionConfigFile } from "./production-config-file.mjs";

const [command = "list", argument, ...rest] = process.argv.slice(2);
if (process.env.AI_EMPLOYEE_CONFIG_FILE) {
  await applyProductionConfigFile();
}
const config = loadConfig({ requireTargets: false, production: true });
const store = await createProductionStore(config);

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

try {
  if (command === "list") {
    print(
      (await store.listTasks({ status: argument, limit: 100 })).map((task) => ({
        id: task.id,
        status: task.status,
        senderName: task.payload?.senderName,
        content: task.payload?.content,
        draft: task.result?.reply,
        riskLevel: task.result?.riskLevel,
        reason: task.result?.reason,
        attempts: task.attempts,
        lastError: task.last_error,
        createdAt: task.created_at,
      })),
    );
  } else if (command === "show") {
    if (!argument) throw new Error("Usage: control show <taskId>");
    print(await store.getTask(argument));
  } else if (command === "approve" || command === "reject") {
    if (!argument) throw new Error(`Usage: control ${command} <taskId> [reason]`);
    const decision = command === "approve" ? "approved" : "rejected";
    print({
      taskId: argument,
      status: await store.decideTask(argument, {
        decision,
        actor: process.env.AI_EMPLOYEE_APPROVER ?? "local-user",
        reason: rest.join(" "),
      }),
    });
  } else if (command === "pause" || command === "resume") {
    await store.setPaused(command === "pause");
    print({ paused: await store.isPaused() });
  } else if (command === "retry") {
    if (!argument) throw new Error("Usage: control retry <taskId>");
    await store.retryTask(argument);
    print({ taskId: argument, status: "queued" });
  } else if (command === "resolve-sent" || command === "resolve-not-sent") {
    if (!argument) throw new Error(`Usage: control ${command} <taskId>`);
    const resolution = command === "resolve-sent" ? "sent" : "not_sent";
    await store.resolveUnknownSend(
      argument,
      resolution,
      process.env.AI_EMPLOYEE_APPROVER ?? "local-user",
    );
    print({ taskId: argument, resolution });
  } else if (command === "purge") {
    const days = Number(argument ?? 30);
    if (!Number.isFinite(days) || days < 1) {
      throw new Error("Usage: control purge <days>, days must be >= 1");
    }
    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    print({ purgedTasks: await store.purgeCompleted({ before }), before });
  } else {
    throw new Error(
      "Commands: list [status], show <taskId>, approve <taskId>, reject <taskId>, retry <taskId>, resolve-sent <taskId>, resolve-not-sent <taskId>, purge <days>, pause, resume",
    );
  }
} finally {
  await store.close();
}
