import { startHealthServer } from "./health-server.mjs";
import { startListener } from "./listener.mjs";
import { applyProductionConfigFile } from "./production-config-file.mjs";
import { runWorker } from "./worker.mjs";

const [component] = process.argv.slice(2);
if (!["listener", "worker", "health"].includes(component)) {
  throw new Error("Usage: service-launcher.mjs listener|worker|health");
}
await applyProductionConfigFile();

const service =
  component === "listener"
    ? await startListener()
    : component === "worker"
      ? await runWorker()
      : await startHealthServer();

const shutdown = async (signal) => {
  await service.stop(signal);
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
