import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  inspectPublicDemoMp4,
  inspectPublicDemoPoster,
  validatePublicDemoManifest,
  verifyPublicDemo,
} from "../scripts/验证公开演示.mjs";

test("公开演示是 60–90 秒、无音频且绑定真实 Issue 与 Draft PR", async () => {
  const result = await verifyPublicDemo();
  assert.equal(result.valid, true);
  assert.equal(result.durationSeconds, 75);
  assert.equal(result.dimensions, "1280x720");
  assert.equal(result.audio, false);
  assert.equal(result.captions, "burned-in");
  assert.equal(result.publicIssue, "https://github.com/ruiwang20010702/foursday/issues/29");
  assert.equal(result.publicDraftPr, "https://github.com/ruiwang20010702/foursday/pull/39");
  assert.equal(result.merged, false);
  assert.equal(result.deployed, false);
});

test("公开演示的人工隐私复核被媒体摘要固定", async () => {
  const result = await verifyPublicDemo();
  assert.equal(result.localAbsolutePathsShown, false);
  assert.equal(result.credentialsShown, false);
  assert.equal(result.digestBoundReview, true);
});

test("MP4 与 PNG 检查拒绝畸形媒体", async () => {
  const [media, poster] = await Promise.all([
    readFile(new URL("../assets/foursday-v0.5-demo.mp4", import.meta.url)),
    readFile(new URL("../assets/foursday-v0.5-demo-poster.png", import.meta.url)),
  ]);
  assert.deepEqual(inspectPublicDemoMp4(media), {
    durationSeconds: 75,
    width: 1280,
    height: 720,
    audio: false,
  });
  assert.deepEqual(inspectPublicDemoPoster(poster), { width: 1280, height: 720 });
  assert.throws(() => inspectPublicDemoMp4(Buffer.from("not an mp4")), /invalid/u);
  assert.throws(() => inspectPublicDemoPoster(Buffer.from("not a png")), /valid PNG/u);
});

test("演示清单不能把本机路径或未审核媒体冒充公开资产", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../assets/foursday-v0.5-demo.manifest.json", import.meta.url),
    "utf8",
  ));
  const inspected = {
    media: { durationSeconds: 75, width: 1280, height: 720, audio: false },
    poster: { width: 1280, height: 720 },
    mediaSha: manifest.media.sha256,
    posterSha: manifest.poster.sha256,
  };
  const privatePath = structuredClone(manifest);
  privatePath.privacyReview.repositoryRootShown = "/Users/example/private";
  assert.throws(
    () => validatePublicDemoManifest(privatePath, inspected),
    /privacy review is invalid/u,
  );
  const changedDigest = structuredClone(manifest);
  changedDigest.media.sha256 = "0".repeat(64);
  assert.throws(
    () => validatePublicDemoManifest(changedDigest, inspected),
    /does not match/u,
  );
});
