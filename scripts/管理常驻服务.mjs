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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isMainModule } from "../src/main-module.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimeDirectory = join(projectRoot, ".runtime");
const generatedDirectory = join(runtimeDirectory, "launchd");
const logsDirectory = join(runtimeDirectory, "logs");
const configPath =
  process.env.AI_EMPLOYEE_CONFIG_FILE ??
  join(runtimeDirectory, "production.json");
const launchAgentsDirectory = join(homedir(), "Library", "LaunchAgents");
const domain = `gui/${process.getuid()}`;

const services = [
  { component: "listener", label: "com.ai-employee.listener" },
  { component: "worker", label: "com.ai-employee.worker" },
  { component: "executor", label: "com.ai-employee.executor" },
  { component: "health", label: "com.ai-employee.health" },
  { component: "admin", label: "com.ai-employee.admin" },
  { component: "alert", label: "com.ai-employee.alert" },
  {
    component: "reconciliation",
    label: "com.ai-employee.reconciliation",
    intervalSeconds: 3_600,
  },
  {
    component: "backup",
    label: "com.ai-employee.backup",
    schedule: { Hour: 2, Minute: 15 },
  },
];

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function plist({ component, label, intervalSeconds }) {
  const script =
    component === "backup"
      ? join(projectRoot, "scripts", "备份数据库.mjs")
      : component === "reconciliation"
        ? join(projectRoot, "scripts", "消息覆盖对账.mjs")
      : join(projectRoot, "src", "service-launcher.mjs");
  const componentArgument =
    component === "backup" || component === "reconciliation"
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
      : component === "reconciliation"
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

async function validateConfig() {
  const metadata = await stat(configPath);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Config must have mode 600: ${configPath}`);
  }
  JSON.parse(await readFile(configPath, "utf8"));
}

async function generate() {
  await validateConfig();
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
  for (const service of services) {
    const destination = join(generatedDirectory, `${service.label}.plist`);
    await writeFile(destination, plist(service), { mode: 0o600 });
  }
  console.log(
    JSON.stringify({
      generatedDirectory,
      configPath,
      services: services.map((service) => service.label),
    }),
  );
}

export async function restoreLaunchAgents({
  serviceDefinitions = services,
  destinationDirectory = launchAgentsDirectory,
  previous = new Map(),
  runLaunchctl = execFileAsync,
  launchDomain = domain,
} = {}) {
  const failedLabels = [];
  for (const service of [...serviceDefinitions].reverse()) {
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
  for (const service of services) {
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
    for (const service of services) {
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

async function uninstall() {
  for (const service of services) {
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
      unloaded: services.map((service) => service.label),
      note: "plist files were retained for recoverability",
    }),
  );
}

if (isMainModule(import.meta.url)) {
  const command = process.argv[2] ?? "generate";
  if (command === "generate") await generate();
  else if (command === "install") await install();
  else if (command === "uninstall") await uninstall();
  else throw new Error("Usage: 管理常驻服务.mjs generate|install|uninstall");
}
