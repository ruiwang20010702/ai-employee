import { access, constants } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { Store } from "./store.mjs";

const config = loadConfig({ requireTargets: false });
const store = await new Store(config.databasePath).open();

try {
  const state = store.health();
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
  store.close();
}
