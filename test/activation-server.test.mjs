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
  assert.match(activationHtml, /Copy privacy-safe pilot proof/u);
  assert.match(activationHtml, /Copy setup check-in/u);
  assert.match(activationHtml, /Open setup Issue #50/u);
  assert.match(activationHtml, /Open pilot Issue #49/u);
  assert.match(activationHtml, /Repository authority/u);
  assert.match(activationHtml, /sourceRepository/u);
  assert.match(activationHtml, /issueRepository/u);
  assert.match(activationHtml, /retains Issue and PR URLs, plan and commit evidence, and confirmed outcomes/u);
  assert.match(activationHtml, /omitting local paths, remotes, tokens, credentials, and model output/u);
  assert.match(activationHtml, /foursday-evidence-/u);
  assert.match(activationHtml, /\/public-proof/u);
  assert.match(activationHtml, /@media\(max-width:820px\)/u);
  assert.match(activationHtml, /prefers-reduced-motion/u);
  assert.doesNotMatch(activationHtml, /fake|testimonial|trusted by/iu);
});

test("evidence download announcements are accessible, truthful, and privacy bounded", () => {
  const script = activationHtml.match(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/u)?.[1];
  const announcements = [...script.matchAll(/downloadStatus\.textContent='([^']+)'/gu)]
    .map((match) => match[1]);
  assert.match(activationHtml, /<p id="evidence-download-status" class="hint" role="status" aria-live="polite" aria-atomic="true"><\/p>/u);
  assert.deepEqual(announcements, [
    "Downloading evidence bundle...",
    "Evidence bundle downloaded.",
    "Evidence bundle download failed. Try again.",
  ]);
  assert.match(script, /await downloadEvidence\(\);downloadStatus\.textContent='Evidence bundle downloaded\.'/u);
  for (const announcement of announcements) {
    assert.doesNotMatch(announcement, /token|path|directory|[/\\]/iu);
  }
  assert.doesNotMatch(script, /downloadStatus\.textContent=error\.(?:message|stack)/u);
});

test("public proof is copied only after outcome confirmation with bounded status text", () => {
  const script = activationHtml.match(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/u)?.[1];
  const announcements = [...script.matchAll(/proofStatus\.textContent='([^']+)'/gu)]
    .map((match) => match[1]);
  assert.match(activationHtml, /data-action="copy-public-proof"/u);
  assert.match(activationHtml, /<p id="public-proof-status" class="hint" role="status" aria-live="polite" aria-atomic="true"><\/p>/u);
  assert.deepEqual(announcements, [
    "Copying privacy-safe pilot proof...",
    "Pilot proof copied. Replace tester-XX and add your timings and feedback before posting.",
    "Pilot proof copy failed. Download the private evidence bundle and try again.",
  ]);
  assert.match(script, /await copyPublicProof\(\)/u);
  assert.match(script, /navigator\.clipboard\?\.writeText/u);
  assert.doesNotMatch(script, /proofStatus\.textContent=error\.(?:message|stack)/u);
});

test("pilot preparation is separately confirmed and reports only bounded status text", () => {
  const script = activationHtml.match(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/u)?.[1];
  assert.match(activationHtml, /Prepare my pilot fork/u);
  assert.match(activationHtml, /I authorize creation or reuse of my personal Foursday fork/u);
  assert.match(activationHtml, /id="pilot-status"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(script, /api\('\/api\/pilot-workspace',\{confirmForkAndClone:true\},600000\)/u);
  assert.match(script, /Pilot workspace ready\. Review the repository root/u);
  assert.match(script, /Pilot preparation failed\. Check GitHub CLI login and retry/u);
  assert.doesNotMatch(script, /pilot-status[^;]*error\.(?:message|stack)/u);
});

test("readiness UI is read-only, accessible, and does not expose command errors", () => {
  const script = activationHtml.match(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/u)?.[1];
  assert.match(activationHtml, /Check pilot readiness/u);
  assert.match(activationHtml, /id="pilot-readiness-status"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(script, /api\('\/api\/readiness',\{\}\)/u);
  assert.match(script, /Ready for fork preparation and governed execution/u);
  assert.match(script, /copyText\(readiness\.setupCheckin\.markdown\)/u);
  assert.match(script, /Setup check-in copied\. Choose your platform/u);
  assert.match(script, /Setup changed after pilot preparation/u);
  assert.match(script, /esc\(readiness\.setupCheckin\.issueUrl\)/u);
  assert.match(script, /No fork, branch, push, or PR was created/u);
  assert.doesNotMatch(script, /pilot-readiness-status[^;]*error\.(?:message|stack)/u);
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

test("pilot workspace endpoint requires token and explicit confirmation", async () => {
  const actionToken = "b".repeat(64);
  const calls = [];
  const service = await startActivationServer({
    port: 0,
    actionToken,
    pilotWorkspace: {
      sourceSha: "a".repeat(40),
      async prepare(body) {
        calls.push(body);
        return {
          schema: "foursday-pilot-workspace/v1",
          rootDirectory: "/fixed/pilot/foursday",
        };
      },
    },
  });
  const post = (body, token = actionToken, contentType = "application/json") => fetch(
    new URL("/api/pilot-workspace", service.url),
    {
      method: "POST",
      headers: {
        "content-type": contentType,
        "x-foursday-action-token": token,
      },
      body: JSON.stringify(body),
    },
  );
  try {
    const environment = await fetch(new URL("/api/environment", service.url))
      .then((response) => response.json());
    assert.equal(environment.pilotWorkspaceAvailable, true);
    assert.equal(environment.pilotSourceSha, "a".repeat(40));
    assert.equal((await post({ confirmForkAndClone: true }, "wrong")).status, 403);
    assert.equal((await post({}, actionToken)).status, 400);
    assert.equal((await post({ confirmForkAndClone: true }, actionToken, "text/plain")).status, 415);
    assert.equal(calls.length, 0);
    const prepared = await post({ confirmForkAndClone: true });
    assert.equal(prepared.status, 201);
    assert.equal((await prepared.json()).rootDirectory, "/fixed/pilot/foursday");
    assert.deepEqual(calls, [{ confirmForkAndClone: true }]);
  } finally {
    await service.stop();
  }
});

test("pilot workspace endpoint hides unexpected preparation errors", async () => {
  const actionToken = "c".repeat(64);
  const service = await startActivationServer({
    port: 0,
    actionToken,
    pilotWorkspace: {
      sourceSha: "a".repeat(40),
      async prepare() {
        throw new Error("/Users/private/.config/gh/hosts.yml contained secret-value");
      },
    },
  });
  try {
    const response = await fetch(new URL("/api/pilot-workspace", service.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-foursday-action-token": actionToken,
      },
      body: JSON.stringify({ confirmForkAndClone: true }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.deepEqual(body, { error: "pilot_workspace_prepare_failed" });
    assert.doesNotMatch(JSON.stringify(body), /private|secret-value/u);
  } finally {
    await service.stop();
  }
});

test("readiness endpoint is token protected, read-only, and error bounded", async () => {
  const actionToken = "d".repeat(64);
  let calls = 0;
  const service = await startActivationServer({
    port: 0,
    actionToken,
    pilotWorkspace: {
      sourceSha: "e".repeat(40),
      async prepare() { throw new Error("not called"); },
    },
    readinessChecker: async () => {
      calls += 1;
      return {
        schema: "foursday-activation-readiness/v1",
        externalSystemsModified: false,
        github: { cliAvailable: true, authenticated: true },
        runtimes: { codex: true, claudeCode: false, openAiCompatible: false },
        readyForPilotPreparation: true,
        readyForGovernedExecution: true,
      };
    },
  });
  const post = (token = actionToken, contentType = "application/json") => fetch(
    new URL("/api/readiness", service.url),
    {
      method: "POST",
      headers: {
        "content-type": contentType,
        "x-foursday-action-token": token,
      },
      body: "{}",
    },
  );
  try {
    const environment = await fetch(new URL("/api/environment", service.url))
      .then((response) => response.json());
    assert.equal(environment.readinessAvailable, true);
    assert.equal((await post("wrong")).status, 403);
    assert.equal((await post(actionToken, "text/plain")).status, 415);
    assert.equal(calls, 0);
    const response = await post();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.externalSystemsModified, false);
    assert.equal(body.readyForGovernedExecution, true);
    assert.equal(body.setupCheckin.schema, "foursday-setup-checkin/v1");
    assert.match(body.setupCheckin.markdown, /immutable candidate: e{40}/u);
    assert.match(body.setupCheckin.issueUrl, /issues\/50#new_comment_field$/u);
    assert.doesNotMatch(body.setupCheckin.markdown, /\/Users\/|token|credential/iu);
    assert.equal(calls, 1);
  } finally {
    await service.stop();
  }

  const failing = await startActivationServer({
    port: 0,
    actionToken,
    readinessChecker: async () => {
      throw new Error("/Users/private/token-secret");
    },
  });
  try {
    const response = await fetch(new URL("/api/readiness", failing.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-foursday-action-token": actionToken,
      },
      body: "{}",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "readiness_check_failed" });
  } finally {
    await failing.stop();
  }
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
    async exportPublicProof(id) {
      calls.push(["public-proof", id]);
      return {
        proof: { schema: "foursday-public-pilot-proof/v1" },
        markdown: "Alias: tester-XX",
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
    assert.equal((await fetch(new URL("/api/sessions/session-1/public-proof", service.url))).status, 403);
    const publicProof = await fetch(
      new URL("/api/sessions/session-1/public-proof", service.url),
      { headers: { "x-foursday-action-token": actionToken } },
    );
    assert.equal(publicProof.status, 200);
    assert.equal((await publicProof.json()).proof.schema, "foursday-public-pilot-proof/v1");
  } finally {
    await service.stop();
  }
  assert.deepEqual(calls.map((call) => call[0]), [
    "create", "approve", "outcomes", "cancel", "evidence", "public-proof", "close",
  ]);
});
