import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isMainModule } from "../src/main-module.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";

const execFileAsync = promisify(execFile);
const controllerRoot = fileURLToPath(new URL("../", import.meta.url));
const configuredReleaseRoot =
  process.env.AI_EMPLOYEE_EXPECTED_RELEASE_DIRECTORY ??
  process.env.AI_EMPLOYEE_RELEASE_DIR;
if (configuredReleaseRoot && !isAbsolute(configuredReleaseRoot)) {
  throw new Error("AI_EMPLOYEE_RELEASE_DIR must be an absolute path");
}
const projectRoot = configuredReleaseRoot
  ? resolve(configuredReleaseRoot)
  : controllerRoot;
const runtimeDirectory = join(projectRoot, ".runtime");
const generatedDirectory = join(runtimeDirectory, "launchd");
const logsDirectory = join(runtimeDirectory, "logs");
const configPath =
  process.env.AI_EMPLOYEE_CONFIG_FILE ??
  join(runtimeDirectory, "production.json");
const launchAgentsDirectory = join(homedir(), "Library", "LaunchAgents");
const domain = `gui/${process.getuid()}`;

export const serviceDefinitions = [
  { component: "listener", label: "com.foursday.listener" },
  { component: "worker", label: "com.foursday.worker" },
  { component: "executor", label: "com.foursday.executor" },
  { component: "proactive", label: "com.foursday.proactive" },
  { component: "health", label: "com.foursday.health" },
  { component: "admin", label: "com.foursday.admin" },
  { component: "alert", label: "com.foursday.alert" },
  {
    component: "reconciliation",
    label: "com.foursday.reconciliation",
    intervalSeconds: 3_600,
  },
  {
    component: "memory-source",
    label: "com.foursday.memory-source",
    intervalSeconds: 300,
  },
  {
    component: "backup",
    label: "com.foursday.backup",
    schedule: { Hour: 2, Minute: 15 },
  },
];

export function serviceScriptPath(service, root = projectRoot) {
  if (service.component === "backup") {
    return join(root, "scripts", "备份数据库.mjs");
  }
  if (service.component === "reconciliation") {
    return join(root, "scripts", "消息覆盖对账.mjs");
  }
  if (service.component === "memory-source") {
    return join(root, "scripts", "校验记忆来源.mjs");
  }
  return join(root, "src", "service-launcher.mjs");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function plist({ component, label, intervalSeconds }) {
  const script = serviceScriptPath({ component });
  const componentArgument =
    component === "backup" || component === "reconciliation" || component === "memory-source"
      ? ""
      : `\n    <string>${escapeXml(component)}</string>`;
  const lifecycle =
    component === "backup"
      ? `  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>15</integer>
  </dict>`
      : component === "reconciliation" || component === "memory-source"
        ? `  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${Number(intervalSeconds)}</integer>`
      : `  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(script)}</string>${componentArgument}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AI_EMPLOYEE_CONFIG_FILE</key>
    <string>${escapeXml(configPath)}</string>
    <key>PATH</key>
    <string>${escapeXml(
      [
        dirname(process.execPath),
        join(homedir(), ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
    )}</string>
  </dict>
${lifecycle}
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logsDirectory, `${component}.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logsDirectory, `${component}.error.log`))}</string>
</dict>
</plist>
`;
}

export async function validateServiceConfig({
  path = configPath,
  environment = process.env,
} = {}) {
  await applyProductionConfigFile({
    path,
    environment: { ...environment },
  });
}

async function generate({ report = true } = {}) {
  await validateServiceConfig();
  await mkdir(generatedDirectory, { recursive: true, mode: 0o700 });
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  await chmod(runtimeDirectory, 0o700);
  await chmod(logsDirectory, 0o700);
  const logFiles = await readdir(logsDirectory, { withFileTypes: true });
  await Promise.all(
    logFiles
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map((entry) => chmod(join(logsDirectory, entry.name), 0o600)),
  );
  for (const service of serviceDefinitions) {
    const destination = join(generatedDirectory, `${service.label}.plist`);
    await writeFile(destination, plist(service), { mode: 0o600 });
  }
  if (report) {
    console.log(
      JSON.stringify({
        generatedDirectory,
        configPath,
        services: serviceDefinitions.map((service) => service.label),
      }),
    );
  }
}

export async function restoreLaunchAgents({
  serviceDefinitions: definitions = serviceDefinitions,
  destinationDirectory = launchAgentsDirectory,
  previous = new Map(),
  runLaunchctl = execFileAsync,
  launchDomain = domain,
} = {}) {
  const failedLabels = [];
  for (const service of [...definitions].reverse()) {
    const filename = `${service.label}.plist`;
    const destination = join(destinationDirectory, filename);
    await runLaunchctl("/bin/launchctl", [
      "bootout",
      launchDomain,
      destination,
    ]).catch(() => {});
    const backup = previous.get(service.label);
    try {
      if (backup) {
        await copyFile(backup, destination);
        await chmod(destination, 0o600);
        await runLaunchctl("/bin/launchctl", [
          "bootstrap",
          launchDomain,
          destination,
        ]);
        await runLaunchctl("/bin/launchctl", [
          "print",
          `${launchDomain}/${service.label}`,
        ]);
      } else {
        await unlink(destination).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        const stillLoaded = await runLaunchctl("/bin/launchctl", [
          "print",
          `${launchDomain}/${service.label}`,
        ]).then(() => true).catch(() => false);
        if (stillLoaded) {
          throw new Error("New service remained loaded after rollback");
        }
      }
    } catch {
      failedLabels.push(service.label);
    }
  }
  return {
    complete: failedLabels.length === 0,
    failedLabels,
  };
}

export async function stopLaunchAgentsForMaintenance({
  serviceDefinitions: definitions = serviceDefinitions,
  destinationDirectory = launchAgentsDirectory,
  runLaunchctl = execFileAsync,
  launchDomain = domain,
} = {}) {
  const failedLabels = [];
  for (const service of definitions) {
    const destination = join(
      destinationDirectory,
      `${service.label}.plist`,
    );
    await runLaunchctl("/bin/launchctl", [
      "bootout",
      launchDomain,
      destination,
    ]).catch(() => {});
    const stillLoaded = await runLaunchctl("/bin/launchctl", [
      "print",
      `${launchDomain}/${service.label}`,
    ]).then(() => true).catch(() => false);
    if (stillLoaded) failedLabels.push(service.label);
  }
  return {
    complete: failedLabels.length === 0,
    failedLabels,
  };
}

export async function removeForwardLaunchAgents({
  serviceDefinitions: definitions = serviceDefinitions,
  destinationDirectory = launchAgentsDirectory,
  runLaunchctl = execFileAsync,
  launchDomain = domain,
} = {}) {
  const failedLabels = [];
  for (const service of [...definitions].reverse()) {
    const destination = join(
      destinationDirectory,
      `${service.label}.plist`,
    );
    try {
      await runLaunchctl("/bin/launchctl", [
        "bootout",
        launchDomain,
        destination,
      ]).catch(() => {});
      await unlink(destination).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      const stillLoaded = await runLaunchctl("/bin/launchctl", [
        "print",
        `${launchDomain}/${service.label}`,
      ]).then(() => true).catch(() => false);
      if (stillLoaded) throw new Error("service remained loaded");
    } catch {
      failedLabels.push(service.label);
    }
  }
  return {
    complete: failedLabels.length === 0,
    failedLabels,
  };
}

async function install() {
  await generate();
  await mkdir(launchAgentsDirectory, { recursive: true });
  const backupDirectory = join(
    runtimeDirectory,
    "launchd-backups",
    new Date().toISOString().replaceAll(/[:.]/g, "-"),
  );
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const previous = new Map();
  for (const service of serviceDefinitions) {
    const filename = `${service.label}.plist`;
    const destination = join(launchAgentsDirectory, filename);
    const exists = await stat(destination).then(() => true).catch(() => false);
    if (!exists) continue;
    const backup = join(backupDirectory, filename);
    await copyFile(destination, backup);
    await chmod(backup, 0o600);
    previous.set(service.label, backup);
  }

  try {
    for (const service of serviceDefinitions) {
      const filename = `${service.label}.plist`;
      const source = join(generatedDirectory, filename);
      const destination = join(launchAgentsDirectory, filename);
      await execFileAsync("/bin/launchctl", [
        "bootout",
        domain,
        destination,
      ]).catch(() => {});
      await copyFile(source, destination);
      await chmod(destination, 0o600);
      await execFileAsync("/bin/launchctl", [
        "bootstrap",
        domain,
        destination,
      ]);
    }
  } catch (error) {
    const rollback = await restoreLaunchAgents({ previous });
    if (!rollback.complete) {
      throw new Error(
        `Service install failed and rollback was incomplete: ${rollback.failedLabels.join(",")}`,
      );
    }
    throw new Error(`Service install failed and rollback completed: ${error.message}`);
  }
  console.log(
    JSON.stringify({
      installed: true,
      launchAgentsDirectory,
      rollbackSnapshot: backupDirectory,
    }),
  );
}

async function installForwardOnly() {
  await generate({ report: false });
  await mkdir(launchAgentsDirectory, { recursive: true });
  const forensicDirectory = join(
    runtimeDirectory,
    "launchd-forward-snapshots",
    new Date().toISOString().replaceAll(/[:.]/g, "-"),
  );
  await mkdir(forensicDirectory, { recursive: true, mode: 0o700 });
  for (const service of serviceDefinitions) {
    const filename = `${service.label}.plist`;
    const destination = join(launchAgentsDirectory, filename);
    const exists = await stat(destination).then(() => true).catch(() => false);
    if (!exists) continue;
    const snapshot = join(forensicDirectory, filename);
    await copyFile(destination, snapshot);
    await chmod(snapshot, 0o600);
  }

  const stopped = await stopLaunchAgentsForMaintenance();
  if (!stopped.complete) {
    throw new Error(
      `Forward-only service stop failed: ${stopped.failedLabels.join(",")}`,
    );
  }
  try {
    for (const service of serviceDefinitions) {
      const filename = `${service.label}.plist`;
      const source = join(generatedDirectory, filename);
      const destination = join(launchAgentsDirectory, filename);
      await copyFile(source, destination);
      await chmod(destination, 0o600);
      await execFileAsync("/bin/launchctl", [
        "bootstrap",
        domain,
        destination,
      ]);
      await execFileAsync("/bin/launchctl", [
        "print",
        `${domain}/${service.label}`,
      ]);
    }
  } catch (error) {
    const cleanup = await removeForwardLaunchAgents();
    if (!cleanup.complete) {
      throw new Error(
        `Forward-only service install failed and cleanup was incomplete: ${cleanup.failedLabels.join(",")}`,
      );
    }
    throw new Error(
      `Forward-only service install failed; previous services were not restored: ${error.message}`,
    );
  }
  console.log(JSON.stringify({
    installed: true,
    forwardOnly: true,
    launchAgentsDirectory,
    forensicSnapshot: forensicDirectory,
  }));
}

async function uninstall() {
  for (const service of serviceDefinitions) {
    const destination = join(
      launchAgentsDirectory,
      `${service.label}.plist`,
    );
    await execFileAsync("/bin/launchctl", [
      "bootout",
      domain,
      destination,
    ]).catch(() => {});
  }
  console.log(
    JSON.stringify({
      unloaded: serviceDefinitions.map((service) => service.label),
      note: "plist files were retained for recoverability",
    }),
  );
}

async function stopForMaintenance() {
  const result = await stopLaunchAgentsForMaintenance();
  if (!result.complete) {
    throw new Error(
      `Maintenance service stop was incomplete: ${result.failedLabels.join(",")}`,
    );
  }
  console.log(JSON.stringify({
    stopped: true,
    forwardOnly: true,
    services: serviceDefinitions.map((service) => service.label),
  }));
}

if (isMainModule(import.meta.url)) {
  const command = process.argv[2] ?? "generate";
  if (command === "generate") await generate();
  else if (command === "install") await install();
  else if (command === "install-forward-only") await installForwardOnly();
  else if (command === "uninstall") await uninstall();
  else if (command === "stop-for-maintenance") await stopForMaintenance();
  else throw new Error(
    "Usage: 管理常驻服务.mjs generate|install|install-forward-only|uninstall|stop-for-maintenance",
  );
}
