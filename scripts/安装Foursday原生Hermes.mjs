#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  foursdayNativeHermesLayout,
  inspectFoursdaySourceCommit,
  runFoursdayNativeHermesInstall,
} from "../src/foursday-hermes-native-install.mjs";
import { validateHermesUpstreamLock } from "../src/hermes-upstream.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some((argument) => !["--apply", "--profile-only"].includes(argument))) {
  throw new Error("Usage: 安装Foursday原生Hermes.mjs [--apply] [--profile-only]");
}
const [lock, packageDocument] = await Promise.all([
  readFile(new URL("../hermes/upstream.lock.json", import.meta.url), "utf8")
    .then(JSON.parse)
    .then(validateHermesUpstreamLock),
  readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
]);
const foursdayCommit = await inspectFoursdaySourceCommit(projectRoot);
const result = await runFoursdayNativeHermesInstall({
  apply: args.includes("--apply"),
  installGateway: false,
  profileOnly: args.includes("--profile-only"),
  lock,
  layout: foursdayNativeHermesLayout({ projectRoot }),
  foursdayVersion: packageDocument.version,
  foursdayCommit,
});
console.log(JSON.stringify(result, null, 2));
