#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../src/main-module.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = join(projectRoot, "assets", "foursday-v0.5-demo.manifest.json");

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${name} fields are invalid`);
  }
  return value;
}

function boxes(buffer, start = 0, end = buffer.length) {
  const result = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw new Error("MP4 box header is truncated");
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new Error("MP4 extended box header is truncated");
      const extended = buffer.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MP4 box is too large");
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) throw new Error("MP4 box size is invalid");
    result.push({ type, start: offset, dataStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return result;
}

function requiredBox(collection, type, name) {
  const value = collection.find((item) => item.type === type);
  if (!value) throw new Error(`MP4 is missing ${name}`);
  return value;
}

function movieDuration(buffer, mvhd) {
  const version = buffer[mvhd.dataStart];
  const timescaleOffset = mvhd.dataStart + (version === 1 ? 20 : 12);
  const durationOffset = mvhd.dataStart + (version === 1 ? 24 : 16);
  if (![0, 1].includes(version) || durationOffset + (version === 1 ? 8 : 4) > mvhd.end) {
    throw new Error("MP4 movie header is invalid");
  }
  const timescale = buffer.readUInt32BE(timescaleOffset);
  const duration = version === 1
    ? buffer.readBigUInt64BE(durationOffset)
    : BigInt(buffer.readUInt32BE(durationOffset));
  if (timescale === 0 || duration > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("MP4 duration is invalid");
  }
  return Number(duration) / timescale;
}

export function inspectPublicDemoMp4(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) throw new Error("Demo MP4 is invalid");
  const top = boxes(buffer);
  requiredBox(top, "ftyp", "file type box");
  const moov = requiredBox(top, "moov", "movie box");
  const movie = boxes(buffer, moov.dataStart, moov.end);
  const durationSeconds = movieDuration(buffer, requiredBox(movie, "mvhd", "movie header"));
  const tracks = movie.filter((item) => item.type === "trak").map((trak) => {
    const track = boxes(buffer, trak.dataStart, trak.end);
    const tkhd = requiredBox(track, "tkhd", "track header");
    const mdia = requiredBox(track, "mdia", "track media");
    const media = boxes(buffer, mdia.dataStart, mdia.end);
    const hdlr = requiredBox(media, "hdlr", "track handler");
    if (hdlr.dataStart + 12 > hdlr.end || tkhd.end - 8 < tkhd.dataStart) {
      throw new Error("MP4 track metadata is invalid");
    }
    return {
      handler: buffer.toString("ascii", hdlr.dataStart + 8, hdlr.dataStart + 12),
      width: buffer.readUInt32BE(tkhd.end - 8) / 65_536,
      height: buffer.readUInt32BE(tkhd.end - 4) / 65_536,
    };
  });
  const video = tracks.find((track) => track.handler === "vide");
  if (!video) throw new Error("Demo MP4 has no video track");
  return {
    durationSeconds,
    width: video.width,
    height: video.height,
    audio: tracks.some((track) => track.handler === "soun"),
  };
}

export function inspectPublicDemoPoster(buffer) {
  const signature = "89504e470d0a1a0a";
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("Demo poster is not a valid PNG");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function validatePublicDemoManifest(manifest, { media, poster, mediaSha, posterSha }) {
  exactKeys(manifest, ["schema", "media", "poster", "publicEvidence", "privacyReview"], "manifest");
  if (manifest.schema !== "foursday-public-demo-manifest/v1") {
    throw new Error("Demo manifest schema is invalid");
  }
  const declaredMedia = exactKeys(
    manifest.media,
    ["path", "sha256", "durationSeconds", "width", "height", "audio", "captions"],
    "manifest.media",
  );
  const declaredPoster = exactKeys(
    manifest.poster,
    ["path", "sha256", "width", "height"],
    "manifest.poster",
  );
  const evidence = exactKeys(
    manifest.publicEvidence,
    ["issueUrl", "draftPrUrl", "merged", "deployed"],
    "manifest.publicEvidence",
  );
  const privacy = exactKeys(
    manifest.privacyReview,
    ["reviewedAt", "repositoryRootShown", "localAbsolutePathsShown", "credentialsShown", "privateRepositoryShown"],
    "manifest.privacyReview",
  );
  if (
    declaredMedia.path !== "assets/foursday-v0.5-demo.mp4" ||
    declaredPoster.path !== "assets/foursday-v0.5-demo-poster.png" ||
    declaredMedia.sha256 !== mediaSha ||
    declaredPoster.sha256 !== posterSha ||
    Math.abs(declaredMedia.durationSeconds - media.durationSeconds) > 0.01 ||
    declaredMedia.width !== media.width ||
    declaredMedia.height !== media.height ||
    declaredMedia.audio !== media.audio ||
    declaredMedia.captions !== "burned-in" ||
    declaredPoster.width !== poster.width ||
    declaredPoster.height !== poster.height
  ) throw new Error("Demo media does not match its reviewed manifest");
  if (
    declaredMedia.durationSeconds < 60 || declaredMedia.durationSeconds > 90 ||
    declaredMedia.width !== 1280 || declaredMedia.height !== 720 ||
    declaredMedia.audio !== false
  ) throw new Error("Demo media contract is invalid");
  if (
    evidence.issueUrl !== "https://github.com/ruiwang20010702/foursday/issues/29" ||
    evidence.draftPrUrl !== "https://github.com/ruiwang20010702/foursday/pull/39" ||
    evidence.merged !== false || evidence.deployed !== false
  ) throw new Error("Demo public evidence boundary is invalid");
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(privacy.reviewedAt) ||
    privacy.repositoryRootShown !== "/workspace/foursday" ||
    privacy.localAbsolutePathsShown !== false ||
    privacy.credentialsShown !== false ||
    privacy.privateRepositoryShown !== false
  ) throw new Error("Demo privacy review is invalid");
  const serialized = JSON.stringify(manifest);
  if (/\/Users\/|[A-Za-z]:\\Users\\/u.test(serialized)) {
    throw new Error("Demo manifest contains a user-specific path");
  }
  return true;
}

async function safeAsset(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Demo asset must be a regular file");
  const [root, resolved] = await Promise.all([realpath(projectRoot), realpath(path)]);
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Demo asset resolves outside the repository");
  return readFile(resolved);
}

export async function verifyPublicDemo() {
  const manifest = JSON.parse(await safeAsset(manifestPath));
  const [mediaBuffer, posterBuffer] = await Promise.all([
    safeAsset(join(projectRoot, manifest.media?.path ?? "")),
    safeAsset(join(projectRoot, manifest.poster?.path ?? "")),
  ]);
  const media = inspectPublicDemoMp4(mediaBuffer);
  const poster = inspectPublicDemoPoster(posterBuffer);
  validatePublicDemoManifest(manifest, {
    media,
    poster,
    mediaSha: sha256(mediaBuffer),
    posterSha: sha256(posterBuffer),
  });
  return {
    valid: true,
    schema: manifest.schema,
    durationSeconds: media.durationSeconds,
    dimensions: `${media.width}x${media.height}`,
    audio: media.audio,
    captions: manifest.media.captions,
    publicIssue: manifest.publicEvidence.issueUrl,
    publicDraftPr: manifest.publicEvidence.draftPrUrl,
    localAbsolutePathsShown: manifest.privacyReview.localAbsolutePathsShown,
    credentialsShown: manifest.privacyReview.credentialsShown,
    merged: manifest.publicEvidence.merged,
    deployed: manifest.publicEvidence.deployed,
    digestBoundReview: true,
  };
}

export async function runPublicDemoVerification({ output = process.stdout } = {}) {
  const result = await verifyPublicDemo();
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) await runPublicDemoVerification();
