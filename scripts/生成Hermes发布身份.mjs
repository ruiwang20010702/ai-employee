#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createHermesReleaseIdentity } from "../src/hermes-release-identity.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");

function argument(name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function absolute(value, name) {
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return resolve(value);
}

const releaseSha = argument("--release-sha");
const releaseRoot = absolute(argument("--release-root"), "--release-root");
const output = absolute(argument("--output"), "--output");
const identity = await createHermesReleaseIdentity({ releaseSha, releaseRoot });
const serialized = `${JSON.stringify(identity, null, 2)}\n`;
const identityDigest = createHash("sha256").update(serialized).digest("hex");

if (!apply) {
  console.log(JSON.stringify({
    valid: true,
    applied: false,
    releaseSha,
    fileCount: Object.keys(identity.files).length,
    identityDigest,
    productionWrite: false,
  }, null, 2));
  process.exit(0);
}

const parent = dirname(output);
const parentMetadata = await lstat(parent);
if (
  !parentMetadata.isDirectory() ||
  parentMetadata.isSymbolicLink() ||
  (parentMetadata.mode & 0o077) !== 0 ||
  await realpath(parent) !== parent
) throw new Error("Hermes release identity output parent must be private");
const temporary = `${output}.tmp-${process.pid}`;
await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
await chmod(temporary, 0o600);
await rename(temporary, output);
await chmod(output, 0o600);
console.log(JSON.stringify({
  valid: true,
  applied: true,
  releaseSha,
  fileCount: Object.keys(identity.files).length,
  identityDigest,
}, null, 2));
