#!/usr/bin/env node
import { createInterface } from "node:readline";
import { admitHermesMemoryCandidate } from "./hermes-memory-candidate-sidecar.mjs";
import {
  foursdayContextTokenPattern,
  loadFoursdayWorkContext,
} from "./foursday-work-context.mjs";
import { isMainModule } from "./main-module.mjs";

const toolName = "foursday_remember_project_fact";

export const foursdayCodexTool = Object.freeze({
  name: toolName,
  description: "Queue one verified, low-risk project fact for the owner's personal gbrain.",
  inputSchema: {
    type: "object",
    properties: {
      contextToken: { type: "string", description: "Opaque Foursday token from the current message context." },
      type: { type: "string", enum: ["atom", "prospective", "source"] },
      factKey: { type: "string" },
      title: { type: "string" },
      statement: { type: "string" },
      sensitivity: { type: "string", enum: ["public", "internal"] },
      confidence: { type: "number", minimum: 0.97, maximum: 1 },
      evidence: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            relativePath: { type: "string" },
            contentSha256: { type: "string" },
            description: { type: "string" },
          },
          required: ["relativePath", "contentSha256", "description"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "contextToken", "type", "factKey", "title", "statement",
      "sensitivity", "confidence", "evidence",
    ],
    additionalProperties: false,
  },
});

export async function callFoursdayCodexTool(input, {
  environment = process.env,
  cwd = process.cwd(),
  now = Date.now(),
  admit = admitHermesMemoryCandidate,
} = {}) {
  const contextPath = environment.FOURSDAY_WORK_CONTEXT_FILE;
  const configPath = environment.FOURSDAY_PRODUCTION_CONFIG;
  const registryPath = environment.FOURSDAY_PROJECT_REGISTRY;
  if (!contextPath || !configPath || !registryPath) throw new Error("foursday_mcp_unconfigured");
  if (!foursdayContextTokenPattern.test(String(input?.contextToken ?? ""))) {
    throw new Error("work_context_invalid");
  }
  const context = await loadFoursdayWorkContext({
    path: contextPath,
    token: input.contextToken,
    cwd,
    now,
  });
  const { contextToken: _discarded, ...candidate } = input ?? {};
  const result = await admit({
    ...candidate,
    projectId: context.projectId,
    sourceSessionHash: context.sourceSessionHash,
    sourcePrincipalId: context.sourcePrincipalHandle,
    observedAt: new Date(now).toISOString(),
  }, { configPath, registryPath, environment });
  return {
    accepted: result.accepted === true,
    status: result.status,
    projectId: result.projectId,
    automaticPromotionQueued: result.automaticPromotionQueued === true,
    personalWorktreeTouched: false,
  };
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function handleFoursdayMcpRequest(request, options = {}) {
  if (!request || request.jsonrpc !== "2.0") return errorResponse(request?.id ?? null, -32600, "Invalid request");
  if (request.method === "initialize") {
    return response(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "foursday", version: "0.1.0" },
    });
  }
  if (request.method === "notifications/initialized") return null;
  if (request.method === "tools/list") return response(request.id, { tools: [foursdayCodexTool] });
  if (request.method === "tools/call") {
    if (request.params?.name !== toolName) return errorResponse(request.id, -32601, "Unknown tool");
    try {
      const result = await callFoursdayCodexTool(request.params?.arguments, options);
      return response(request.id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      });
    } catch (error) {
      const knownErrors = new Set([
        "work_context_invalid",
        "work_context_unavailable",
        "work_context_expired",
        "work_context_workspace_mismatch",
        "foursday_mcp_unconfigured",
      ]);
      const candidate = String(error?.message ?? "");
      const code = knownErrors.has(candidate) ? candidate : "memory_candidate_rejected";
      return response(request.id, {
        content: [{ type: "text", text: JSON.stringify({ accepted: false, error: code }) }],
        structuredContent: { accepted: false, error: code },
        isError: true,
      });
    }
  }
  return errorResponse(request.id ?? null, -32601, "Method not found");
}

async function runStdio() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let output;
    try {
      output = await handleFoursdayMcpRequest(JSON.parse(line));
    } catch {
      output = errorResponse(null, -32700, "Parse error");
    }
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

if (isMainModule(import.meta.url)) await runStdio();
