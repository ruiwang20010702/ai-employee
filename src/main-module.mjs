import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isMainModule(importMetaUrl, argv = process.argv) {
  if (!argv[1]) return false;
  const entry = resolve(argv[1]);
  const modulePath = resolve(fileURLToPath(importMetaUrl));
  try {
    return realpathSync(entry) === realpathSync(modulePath);
  } catch {
    return entry === modulePath;
  }
}
