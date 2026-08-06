import { fileURLToPath } from "node:url";
import { validateCodexPluginPackage } from "../src/codex-plugin-package.mjs";
import { isMainModule } from "../src/main-module.mjs";

export async function verifyCodexPlugin({ root = fileURLToPath(new URL("../", import.meta.url)) } = {}) {
  return validateCodexPluginPackage({ root });
}

if (isMainModule(import.meta.url)) {
  console.log(JSON.stringify(await verifyCodexPlugin(), null, 2));
}
