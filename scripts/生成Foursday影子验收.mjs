#!/usr/bin/env node
import {
  chmod,
  lstat,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { evaluateHermesShadowAcceptance } from "../src/hermes-shadow-acceptance.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");

function argument(name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function privateFile(value, name) {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  const path = resolve(value);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${name} must be a private regular file`);
  }
  return path;
}

const releaseSha = argument("--release-sha");
const ledgerPath = await privateFile(argument("--ledger"), "--ledger");
const restartPath = await privateFile(
  argument("--restart-evidence"),
  "--restart-evidence",
);
const codePath = await privateFile(argument("--code-evidence"), "--code-evidence");
const output = argument("--output");
if (!isAbsolute(output)) throw new Error("--output must be an absolute path");

const lines = (await readFile(ledgerPath, "utf8"))
  .split("\n")
  .filter((line) => line.trim());
if (lines.length > 100_000) throw new Error("Foursday shadow ledger is too large");
const events = lines.map((line) => JSON.parse(line));
const restartEvidence = JSON.parse(await readFile(restartPath, "utf8"));
const codeWorkEvidence = JSON.parse(await readFile(codePath, "utf8"));
const result = evaluateHermesShadowAcceptance({
  releaseSha,
  events,
  restartEvidence,
  codeWorkEvidence,
});

if (!apply) {
  console.log(JSON.stringify({
    valid: result.valid,
    missing: result.missing,
    summary: result.summary,
    receiptReady: Boolean(result.receipt),
    productionWrite: false,
  }, null, 2));
  process.exit(0);
}
if (!result.valid || !result.receipt) {
  throw new Error(`Foursday shadow acceptance is incomplete: ${result.missing.join(",")}`);
}
const target = resolve(output);
const parentMetadata = await lstat(dirname(target));
if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
  throw new Error("Foursday shadow acceptance output parent is invalid");
}
const temporary = `${target}.tmp-${process.pid}`;
await writeFile(temporary, `${JSON.stringify(result.receipt, null, 2)}\n`, {
  mode: 0o600,
  flag: "wx",
});
await chmod(temporary, 0o600);
await rename(temporary, target);
await chmod(target, 0o600);
console.log(JSON.stringify({
  valid: true,
  applied: true,
  scenarioCount: Object.keys(result.receipt.scenarios).length,
  evidenceDigest: result.receipt.evidenceDigest,
}, null, 2));
