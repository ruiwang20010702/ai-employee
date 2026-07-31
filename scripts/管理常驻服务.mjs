import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
  { component: "health", label: "com.ai-employee.health" },
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

function plist({ component, label }) {
  const script =
    component === "backup"
      ? join(projectRoot, "scripts", "备份数据库.mjs")
      : join(projectRoot, "src", "service-launcher.mjs");
  const componentArgument =
    component === "backup"
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
    for (const service of [...services].reverse()) {
      const filename = `${service.label}.plist`;
      const destination = join(launchAgentsDirectory, filename);
      await execFileAsync("/bin/launchctl", [
        "bootout",
        domain,
        destination,
      ]).catch(() => {});
      const backup = previous.get(service.label);
      if (!backup) continue;
      await copyFile(backup, destination);
      await chmod(destination, 0o600);
      await execFileAsync("/bin/launchctl", [
        "bootstrap",
        domain,
        destination,
      ]).catch(() => {});
    }
    throw new Error(`Service install failed and rollback ran: ${error.message}`);
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

const command = process.argv[2] ?? "generate";
if (command === "generate") await generate();
else if (command === "install") await install();
else if (command === "uninstall") await uninstall();
else throw new Error("Usage: 管理常驻服务.mjs generate|install|uninstall");
