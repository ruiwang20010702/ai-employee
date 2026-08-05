function epoch(value) {
  if (value == null) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function availabilityBucket(now, intervalMs) {
  const time = epoch(now);
  if (time == null || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("A valid availability interval is required");
  }
  return new Date(Math.floor(time / intervalMs) * intervalMs);
}

export function buildAvailabilityMetrics(
  { sampleCount = 0, readyCount = 0, firstTrackedAt = null, lastSampleAt = null } = {},
  {
    now = new Date(),
    intervalMs = 60_000,
    windowMs = 30 * 24 * 60 * 60 * 1000,
    target = 0.995,
  } = {},
) {
  const nowTime = epoch(now);
  const firstTime = epoch(firstTrackedAt);
  const lastTime = epoch(lastSampleAt);
  if (
    nowTime == null ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs <= 0 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs <= 0
  ) {
    throw new Error("A valid availability window is required");
  }
  const endExclusive = Math.floor(nowTime / intervalMs) * intervalMs;
  const requestedStart = endExclusive - windowMs;
  const effectiveStart = firstTime == null
    ? endExclusive
    : Math.max(requestedStart, Math.floor(firstTime / intervalMs) * intervalMs);
  const expectedSamples = Math.max(
    0,
    Math.floor((endExclusive - effectiveStart) / intervalMs),
  );
  const boundedSamples = Math.min(Math.max(0, Number(sampleCount)), expectedSamples);
  const boundedReady = Math.min(
    Math.max(0, Number(readyCount)),
    boundedSamples,
  );
  const missingSamples = expectedSamples - boundedSamples;
  const availability = expectedSamples === 0 ? null : boundedReady / expectedSamples;
  const windowComplete = firstTime != null && firstTime <= requestedStart;
  return {
    windowStart: new Date(requestedStart).toISOString(),
    windowEnd: new Date(endExclusive).toISOString(),
    trackedSince: firstTime == null ? null : new Date(firstTime).toISOString(),
    lastSampleAt: lastTime == null ? null : new Date(lastTime).toISOString(),
    intervalMs,
    expectedSamples,
    recordedSamples: boundedSamples,
    readySamples: boundedReady,
    unavailableSamples: expectedSamples - boundedReady,
    missingSamples,
    availability,
    target,
    windowComplete,
    targetMet: windowComplete && availability != null ? availability >= target : null,
    trackingCoverage: firstTime == null
      ? 0
      : Math.min(1, Math.max(0, (endExclusive - firstTime) / windowMs)),
  };
}
