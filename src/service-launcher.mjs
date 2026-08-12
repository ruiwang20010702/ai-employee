import { startHealthServer } from "./health-server.mjs";
import { startAdminServer } from "./admin-server.mjs";
import { startAlertMonitor } from "./alert-monitor.mjs";
import { startListener } from "./listener.mjs";
import { applyProductionConfigFile } from "./production-config-file.mjs";
import { runWorker } from "./worker.mjs";
import { runPlanExecutor } from "./plan-executor.mjs";
import { runProactiveWorker } from "./proactive-worker.mjs";

const [component] = process.argv.slice(2);
if (!["listener", "worker", "executor", "proactive", "health", "admin", "alert"].includes(component)) {
  throw new Error("Usage: service-launcher.mjs listener|worker|executor|proactive|health|admin|alert");
}
await applyProductionConfigFile();

const service =
  component === "listener"
    ? await startListener()
    : component === "worker"
      ? await runWorker()
      : component === "executor"
      ? await runPlanExecutor()
      : component === "proactive"
        ? await runProactiveWorker()
      : component === "health"
        ? await startHealthServer()
        : component === "admin"
          ? await startAdminServer()
          : await startAlertMonitor();

const shutdown = async (signal) => {
  await service.stop(signal);
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
