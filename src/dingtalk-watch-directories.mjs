import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function discoverWatchDirectories(dingtalkRoot) {
  const entries = await readdir(dingtalkRoot, { withFileTypes: true }).catch(
    () => [],
  );
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("_v3"))
    .flatMap((entry) => {
      const accountDirectory = join(dingtalkRoot, entry.name);
      return [
        join(accountDirectory, "DBFiles"),
        join(accountDirectory, "Sync_v2", "point"),
        join(accountDirectory, "SyncPoint"),
      ];
    });
  const existing = [];
  for (const directory of candidates) {
    if (await access(directory).then(() => true).catch(() => false)) {
      existing.push(directory);
    }
  }
  return [...new Set(existing)];
}
