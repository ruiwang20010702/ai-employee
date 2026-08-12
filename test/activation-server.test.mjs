import assert from "node:assert/strict";
import test from "node:test";
import { activationHtml } from "../src/activation-ui.mjs";
import { startActivationServer } from "../src/activation-server.mjs";

test("activation UI is parseable, responsive, and honest about preview boundaries", () => {
  const script = activationHtml.match(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(activationHtml, /Give your coding agent one real job/u);
  assert.match(activationHtml, /10-minute setup/u);
  assert.match(activationHtml, /Local · no writes/u);
  assert.match(activationHtml, /0 external systems touched/u);
  assert.match(activationHtml, /Building the plan/u);
  assert.match(activationHtml, /blockedCapabilities/u);
  assert.match(activationHtml, /Download evidence bundle/u);
  assert.match(activationHtml, /retains Issue and PR URLs, plan and commit evidence, and confirmed outcomes/u);
  assert.match(activationHtml, /omitting local paths, remotes, tokens, credentials, and model output/u);
  assert.match(activationHtml, /foursday-evidence-/u);
  assert.match(activationHtml, /@media\(max-width:820px\)/u);
  assert.match(activationHtml, /prefers-reduced-motion/u);
  assert.doesNotMatch(activationHtml, /fake|testimonial|trusted by/iu);
});

test("activation server exposes only loopback preview endpoints", async () => {
  const calls = [];
  const service = await startActivationServer({
    port: 0,
    workingDirectory: "/workspace/example",
    previewBuilder: async (body) => {
      calls.push(body);
      return { schema: "foursday-activation/v1", externalSystemsTouched: false };
    },
  });
  try {
    const page = await fetch(service.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/u);
    const pageText = await page.text();
    assert.doesNotMatch(pageText, /__ACTION_TOKEN__/u);
    const environment = await fetch(new URL("/api/environment", service.url)).then((response) => response.json());
    assert.equal(environment.workingDirectory, "/workspace/example");
    const preview = await fetch(new URL("/api/preview", service.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issueUrl: "https://github.com/example/project/issues/1" }),
    });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).externalSystemsTouched, false);
    assert.equal(calls.length, 1);
    const wrongType = await fetch(new URL("/api/preview", service.url), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);
    assert.equal(calls.length, 1);
    assert.equal((await fetch(new URL("/api/execute", service.url))).status, 404);
  } finally {
    await service.stop();
  }
  await assert.rejects(
    () => startActivationServer({ host: "0.0.0.0", port: 0 }),
    /loopback-only/u,
  );
});

test("activation execution routes require explicit local-session and plan approval", async () => {
  const actionToken = "a".repeat(64);
  const calls = [];
  const coordinator = {
    async create(body) {
      calls.push(["create", body]);
      return { sessionId: "session-1", plan: { planHash: "a".repeat(64) } };
    },
    async get(id) { return id === "session-1" ? { sessionId: id, running: false } : null; },
    async approveAndExecute(id, body) {
      calls.push(["approve", id, body]);
      return { sessionId: id, status: "completed" };
    },
    async confirmOutcomes(id, body) {
      calls.push(["outcomes", id, body]);
      return { memory: { status: "confirmed" } };
    },
    async cancel(id, body) {
      calls.push(["cancel", id, body]);
      return { sessionId: id, status: "cancellation_requested" };
    },
    async exportEvidence(id) {
      calls.push(["evidence", id]);
      return {
        schema: "foursday-validation-evidence/v1",
        plan: { planHash: "a".repeat(64) },
      };
    },
    async close() { calls.push(["close"]); },
  };
  const service = await startActivationServer({
    port: 0,
    executionCoordinator: coordinator,
    actionToken,
  });
  const post = (path, body) => fetch(new URL(path, service.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-foursday-action-token": actionToken,
    },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await fetch(new URL("/api/sessions", service.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmLocalSession: true }),
    })).status, 403);
    assert.equal((await post("/api/sessions", {})).status, 400);
    const created = await post("/api/sessions", { confirmLocalSession: true });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).sessionId, "session-1");
    assert.equal((await fetch(new URL("/api/sessions/session-1", service.url))).status, 403);
    assert.equal((await fetch(new URL("/api/sessions/session-1", service.url), {
      headers: { "x-foursday-action-token": actionToken },
    })).status, 200);
    assert.equal((await fetch(new URL("/api/sessions/missing", service.url), {
      headers: { "x-foursday-action-token": actionToken },
    })).status, 404);
    assert.equal((await post("/api/sessions/session-1/approve", {
      approved: true, planHash: "a".repeat(64),
    })).status, 200);
    assert.equal((await post("/api/sessions/session-1/outcomes", {
      memoryId: "memory-1",
    })).status, 200);
    assert.equal((await post("/api/sessions/session-1/cancel", {
      planHash: "a".repeat(64),
    })).status, 200);
    assert.equal((await fetch(new URL("/api/sessions/session-1/evidence", service.url))).status, 403);
    const evidence = await fetch(new URL("/api/sessions/session-1/evidence", service.url), {
      headers: { "x-foursday-action-token": actionToken },
    });
    assert.equal(evidence.status, 200);
    assert.match(evidence.headers.get("content-disposition"), /foursday-evidence-a{12}\.json/u);
    assert.equal((await evidence.json()).schema, "foursday-validation-evidence/v1");
  } finally {
    await service.stop();
  }
  assert.deepEqual(calls.map((call) => call[0]), [
    "create", "approve", "outcomes", "cancel", "evidence", "close",
  ]);
});
