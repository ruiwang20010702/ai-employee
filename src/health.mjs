import { access, constants } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { createProductionStore } from "./production-store.mjs";

const config = loadConfig({ requireTargets: false, production: true });
const store = await createProductionStore(config);

try {
  const state = await store.health();
  const executable = async (path) =>
    access(path, constants.X_OK)
      .then(() => true)
      .catch(() => false);
  const checks = {
    database: true,
    dwsExecutable: await executable(config.dwsPath),
    codexExecutable: await executable(config.codexPath),
    paused: state.paused,
    deadTasks: state.tasks.dead ?? 0,
    unknownSends: state.tasks.send_unknown ?? 0,
    pendingMessages: state.pendingMessages,
    checkpoints: state.checkpoints.length,
  };
  const healthy =
    checks.dwsExecutable &&
    checks.codexExecutable &&
    checks.deadTasks === 0 &&
    checks.unknownSends === 0;
  console.log(JSON.stringify({ healthy, checks }, null, 2));
  if (!healthy) process.exitCode = 1;
} finally {
  await store.close();
}
