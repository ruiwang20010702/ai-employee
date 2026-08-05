import assert from "node:assert/strict";
import { test } from "node:test";
import {
  availabilityBucket,
  buildAvailabilityMetrics,
} from "../src/availability-metrics.mjs";

test("可用性按固定分钟桶聚合且缺测计为不可用", () => {
  assert.equal(
    availabilityBucket(new Date("2026-08-05T10:03:42Z"), 60_000).toISOString(),
    "2026-08-05T10:03:00.000Z",
  );
  const metrics = buildAvailabilityMetrics({
    sampleCount: 4,
    readyCount: 3,
    firstTrackedAt: "2026-08-05T10:00:00Z",
    lastSampleAt: "2026-08-05T10:04:00Z",
  }, {
    now: new Date("2026-08-05T10:05:30Z"),
    intervalMs: 60_000,
    windowMs: 5 * 60_000,
  });
  assert.equal(metrics.expectedSamples, 5);
  assert.equal(metrics.recordedSamples, 4);
  assert.equal(metrics.readySamples, 3);
  assert.equal(metrics.missingSamples, 1);
  assert.equal(metrics.unavailableSamples, 2);
  assert.equal(metrics.availability, 0.6);
  assert.equal(metrics.windowComplete, true);
  assert.equal(metrics.targetMet, false);
});

test("未积满完整窗口时只给观察值", () => {
  const metrics = buildAvailabilityMetrics({
    sampleCount: 2,
    readyCount: 2,
    firstTrackedAt: "2026-08-05T10:02:00Z",
    lastSampleAt: "2026-08-05T10:03:00Z",
  }, {
    now: new Date("2026-08-05T10:04:20Z"),
    intervalMs: 60_000,
    windowMs: 5 * 60_000,
  });
  assert.equal(metrics.availability, 1);
  assert.equal(metrics.trackingCoverage, 0.4);
  assert.equal(metrics.windowComplete, false);
  assert.equal(metrics.targetMet, null);
});
