#!/usr/bin/env node
import { readFile, lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { foursdayNativeHermesLayout } from "../src/foursday-hermes-native-install.mjs";
import {
  inspectFoursdayNativeGateway,
  runFoursdayNativeGatewayAction,
} from "../src/foursday-native-gateway.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const [action = "status", ...flags] = process.argv.slice(2);
const valueFlags = new Set(["--acceptance", "--release-sha", "--confirm"]);
if (flags.some((flag, index) =>
  flag !== "--apply" && !valueFlags.has(flag) && !valueFlags.has(flags[index - 1]))) {
  throw new Error("Usage: 管理Foursday原生Gateway.mjs <status|install-shadow|start-shadow|activate|stop|restart|uninstall|remove-profile> [--apply] [--acceptance /private/receipt.json --release-sha FULL_SHA --confirm VALUE]");
}
const argument = (name) => {
  const index = flags.indexOf(name);
  return index === -1 ? null : flags[index + 1];
};
let acceptance = null;
if (action === "activate") {
  const path = argument("--acceptance");
  if (!path || !isAbsolute(path)) throw new Error("Native activation requires an absolute --acceptance path");
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size < 2 ||
    metadata.size > 1024 * 1024
  ) {
    throw new Error("Native activation acceptance must be a private regular file");
  }
  acceptance = JSON.parse(await readFile(absolute, "utf8"));
}
const layout = foursdayNativeHermesLayout({ projectRoot });
const result = action === "status"
  ? await inspectFoursdayNativeGateway({ layout })
  : await runFoursdayNativeGatewayAction(action, {
      layout,
      apply: flags.includes("--apply"),
      releaseSha: argument("--release-sha"),
      acceptance,
      confirmation: argument("--confirm"),
    });
console.log(JSON.stringify(result, null, 2));
if (action === "status" && !result.ready) process.exitCode = 1;
