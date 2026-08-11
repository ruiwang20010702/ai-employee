import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isMainModule } from "../src/main-module.mjs";

const execFileAsync = promisify(execFile);
const launchDomain = `gui/${process.getuid()}`;
const managedPlistNames = new Set([
  "com.foursday.listener.plist",
  "com.foursday.worker.plist",
  "com.foursday.executor.plist",
  "com.foursday.health.plist",
  "com.foursday.admin.plist",
  "com.foursday.alert.plist",
  "com.foursday.reconciliation.plist",
  "com.foursday.memory-source.plist",
  "com.foursday.backup.plist",
  "com.ai-employee.listener.plist",
  "com.ai-employee.worker.plist",
  "com.ai-employee.executor.plist",
  "com.ai-employee.health.plist",
  "com.ai-employee.admin.plist",
  "com.ai-employee.alert.plist",
  "com.ai-employee.reconciliation.plist",
  "com.ai-employee.memory-source.plist",
  "com.ai-employee.backup.plist",
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`缺少参数：${name}`);
  return value;
}

async function existingDirectory(path, description) {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error(`${description}不是目录`);
  return path;
}

export async function reconcileVersionServices({
  releaseDirectory,
  destinationDirectory = join(homedir(), "Library", "LaunchAgents"),
  runLaunchctl = execFileAsync,
  domain = launchDomain,
} = {}) {
  const release = resolve(String(releaseDirectory ?? ""));
  const generatedDirectory = await existingDirectory(
    join(release, ".runtime", "launchd"),
    "目标版本服务清单",
  );
  await existingDirectory(destinationDirectory, "LaunchAgents 目录");

  const allowed = new Set(
    (await readdir(generatedDirectory))
      .filter((name) => managedPlistNames.has(name)),
  );
  if (allowed.size === 0) throw new Error("目标版本没有生成受管常驻服务清单");

  const stale = (await readdir(destinationDirectory))
    .filter((name) => managedPlistNames.has(name) && !allowed.has(name))
    .sort();
  if (stale.length === 0) {
    return { reconciled: true, removed: [], backupDirectory: null };
  }

  const backupDirectory = join(
    release,
    ".runtime",
    "launchd-stale-backups",
    new Date().toISOString().replaceAll(/[:.]/g, "-"),
  );
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });

  const removed = [];
  for (const filename of stale) {
    const label = basename(filename, ".plist");
    const destination = join(destinationDirectory, filename);
    const backup = join(backupDirectory, filename);
    await copyFile(destination, backup);
    await chmod(backup, 0o600);
    await runLaunchctl("/bin/launchctl", [
      "bootout",
      domain,
      destination,
    ]).catch(() => {});
    await unlink(destination);
    const stillLoaded = await runLaunchctl("/bin/launchctl", [
      "print",
      `${domain}/${label}`,
    ]).then(() => true).catch(() => false);
    if (stillLoaded) {
      throw new Error(`版本外服务仍处于加载状态：${label}`);
    }
    removed.push(label);
  }
  return { reconciled: true, removed, backupDirectory };
}

if (isMainModule(import.meta.url)) {
  try {
    const result = await reconcileVersionServices({
      releaseDirectory: argument("--release"),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ reconciled: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
