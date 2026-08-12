import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { buildActivationPreview } from "./activation.mjs";
import { activationHtml } from "./activation-ui.mjs";
import { buildPilotTaskDraft } from "./pilot-task-draft.mjs";
import { buildSetupCheckin } from "./setup-checkin.mjs";

const securityHeaders = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
});

function json(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    ...securityHeaders,
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

function equalToken(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

async function readJson(request, maximum = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error("request_too_large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

export async function startActivationServer({
  host = "127.0.0.1",
  port = 4173,
  workingDirectory = process.cwd(),
  previewBuilder = buildActivationPreview,
  executionCoordinator = null,
  pilotWorkspace = null,
  readinessChecker = null,
  actionToken = randomBytes(32).toString("hex"),
} = {}) {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("Activation server must remain loopback-only");
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      const nonce = randomBytes(18).toString("base64");
      response.writeHead(200, {
        ...securityHeaders,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      });
      response.end(
        activationHtml
          .replaceAll("__NONCE__", nonce)
          .replaceAll("__ACTION_TOKEN__", actionToken),
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/environment") {
      json(response, 200, {
        workingDirectory,
        nodeVersion: process.versions.node,
        externalSystemsTouched: false,
        executionAvailable: Boolean(executionCoordinator),
        pilotWorkspaceAvailable: Boolean(pilotWorkspace),
        pilotSourceSha: pilotWorkspace?.sourceSha ?? null,
        readinessAvailable: Boolean(readinessChecker),
      });
      return;
    }
    if (readinessChecker && request.method === "POST" && url.pathname === "/api/readiness") {
      try {
        if (!equalToken(request.headers["x-foursday-action-token"], actionToken)) {
          throw Object.assign(new Error("action_token_invalid"), { status: 403 });
        }
        if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          throw Object.assign(new Error("content_type_must_be_application_json"), { status: 415 });
        }
        await readJson(request);
        const readiness = await readinessChecker();
        json(response, 200, {
          ...readiness,
          setupCheckin: pilotWorkspace
            ? buildSetupCheckin({
              candidateSha: pilotWorkspace.sourceSha,
              nodeVersion: process.versions.node,
              readiness,
            })
            : null,
        });
      } catch (error) {
        json(response, error.status ?? 400, {
          error: error.status ? String(error.message) : "readiness_check_failed",
        });
      }
      return;
    }
    if (pilotWorkspace && request.method === "POST" && url.pathname === "/api/pilot-task-draft") {
      try {
        if (!equalToken(request.headers["x-foursday-action-token"], actionToken)) {
          throw Object.assign(new Error("action_token_invalid"), { status: 403 });
        }
        if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          throw Object.assign(new Error("content_type_must_be_application_json"), { status: 415 });
        }
        const body = await readJson(request);
        json(response, 200, buildPilotTaskDraft({
          participantAlias: body.participantAlias,
          candidateSha: pilotWorkspace.sourceSha,
        }));
      } catch (error) {
        json(response, error.status ?? 400, {
          error: error.status ? String(error.message) : "pilot_task_draft_failed",
        });
      }
      return;
    }
    if (pilotWorkspace && request.method === "POST" && url.pathname === "/api/pilot-workspace") {
      try {
        if (!equalToken(request.headers["x-foursday-action-token"], actionToken)) {
          throw Object.assign(new Error("action_token_invalid"), { status: 403 });
        }
        if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          throw Object.assign(new Error("content_type_must_be_application_json"), { status: 415 });
        }
        const body = await readJson(request);
        if (body.confirmForkAndClone !== true) {
          throw Object.assign(new Error("fork_and_clone_confirmation_required"), { status: 400 });
        }
        json(response, 201, await pilotWorkspace.prepare({
          confirmForkAndClone: true,
        }));
      } catch (error) {
        const status = error.status ?? 400;
        json(response, status, {
          error: error.status ? String(error.message) : "pilot_workspace_prepare_failed",
        });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/preview") {
      try {
        if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          throw Object.assign(new Error("content_type_must_be_application_json"), { status: 415 });
        }
        const body = await readJson(request);
        json(response, 200, await previewBuilder(body));
      } catch (error) {
        json(response, error.status ?? 400, { error: String(error.message ?? "preview_failed") });
      }
      return;
    }
    if (executionCoordinator && request.method === "POST" && url.pathname === "/api/sessions") {
      try {
        if (!equalToken(request.headers["x-foursday-action-token"], actionToken)) {
          throw Object.assign(new Error("action_token_invalid"), { status: 403 });
        }
        if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          throw Object.assign(new Error("content_type_must_be_application_json"), { status: 415 });
        }
        const body = await readJson(request);
        if (body.confirmLocalSession !== true) {
          throw Object.assign(new Error("local_session_confirmation_required"), { status: 400 });
        }
        json(response, 201, await executionCoordinator.create(body));
      } catch (error) {
        json(response, error.status ?? 400, { error: String(error.message ?? "session_create_failed") });
      }
      return;
    }
    const evidenceRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/evidence$/u);
    if (executionCoordinator && request.method === "GET" && evidenceRoute) {
      try {
        if (!equalToken(request.headers["x-foursday-action-token"], actionToken)) {
          throw Object.assign(new Error("action_token_invalid"), { status: 403 });
        }
        const bundle = await executionCoordinator.exportEvidence(
          decodeURIComponent(evidenceRoute[1]),
        );
        json(response, 200, bundle, {
          "content-disposition": `attachment; filename="foursday-evidence-${bundle.plan.planHash.slice(0, 12)}.json"`,
        });
      } catch (error) {
        json(response, error.status ?? 400, { error: String(error.message ?? "evidence_export_failed") });
      }
      return;
    }
    const publicProofRoute = url.pathname.match(
      /^\/api\/sessions\/([^/]+)\/public-proof$/u,
    );
    if (executionCoordinator && request.method === "GET" && publicProofRoute) {
      try {
        if (!equalToken(request.headers["x-foursday-action-token"], actionToken)) {
          throw Object.assign(new Error("action_token_invalid"), { status: 403 });
        }
        json(
          response,
          200,
          await executionCoordinator.exportPublicProof(
            decodeURIComponent(publicProofRoute[1]),
          ),
        );
      } catch (error) {
        json(response, error.status ?? 400, {
          error: String(error.message ?? "public_proof_export_failed"),
        });
      }
      return;
    }
    const sessionRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)$/u);
    if (executionCoordinator && request.method === "GET" && sessionRoute) {
      try {
        if (!equalToken(request.headers["x-foursday-action-token"], actionToken)) {
          throw Object.assign(new Error("action_token_invalid"), { status: 403 });
        }
        const session = await executionCoordinator.get(decodeURIComponent(sessionRoute[1]));
        json(response, session ? 200 : 404, session ?? { error: "session_not_found" });
      } catch (error) {
        json(response, error.status ?? 400, { error: String(error.message ?? "session_read_failed") });
      }
      return;
    }
    const sessionAction = url.pathname.match(
      /^\/api\/sessions\/([^/]+)\/(approve|outcomes|cancel)$/u,
    );
    if (executionCoordinator && request.method === "POST" && sessionAction) {
      try {
        if (!equalToken(request.headers["x-foursday-action-token"], actionToken)) {
          throw Object.assign(new Error("action_token_invalid"), { status: 403 });
        }
        if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          throw Object.assign(new Error("content_type_must_be_application_json"), { status: 415 });
        }
        const body = await readJson(request);
        const sessionId = decodeURIComponent(sessionAction[1]);
        const action = sessionAction[2];
        const result = action === "approve"
          ? await executionCoordinator.approveAndExecute(sessionId, body)
          : action === "outcomes"
            ? await executionCoordinator.confirmOutcomes(sessionId, body)
            : await executionCoordinator.cancel(sessionId, body);
        json(response, 200, result);
      } catch (error) {
        json(response, error.status ?? 400, { error: String(error.message ?? "session_action_failed") });
      }
      return;
    }
    json(response, 404, { error: "not_found" });
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, host, accept);
  });
  return {
    server,
    url: `http://${host}:${server.address().port}/`,
    async stop() {
      await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
      await executionCoordinator?.close?.();
    },
  };
}
