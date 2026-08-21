import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  callFoursdayCodexTool,
  handleFoursdayMcpRequest,
} from "../src/foursday-codex-mcp.mjs";

async function fixture(t, { expiresAt = Math.floor(Date.now() / 1000) + 60 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-codex-mcp-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = `fctx_${"a".repeat(64)}`;
  const contextPath = join(root, "contexts.json");
  await writeFile(contextPath, `${JSON.stringify({
    schemaVersion: 1,
    contexts: {
      [token]: {
        projectId: "example",
        workspace: root,
        projectContext: "Project: Example",
        memoryContext: "Personal gbrain fact",
        sourcePrincipalHandle: "d".repeat(64),
        sourceSessionHash: "b".repeat(64),
        expiresAt,
      },
    },
  })}\n`, { mode: 0o600 });
  return {
    root,
    token,
    contextPath,
    environment: {
      FOURSDAY_WORK_CONTEXT_FILE: contextPath,
      FOURSDAY_PRODUCTION_CONFIG: join(root, "production.json"),
      FOURSDAY_PROJECT_REGISTRY: join(root, "projects.json"),
    },
  };
}

function input(contextToken) {
  return {
    contextToken,
    type: "atom",
    factKey: "project.verified_fact",
    title: "Verified fact",
    statement: "The current workspace proves this fact.",
    sensitivity: "internal",
    confidence: 0.99,
    evidence: [{
      relativePath: "README.md",
      contentSha256: "c".repeat(64),
      description: "Current project evidence",
    }],
  };
}

test("Codex MCP advertises only the bounded Foursday memory tool", async () => {
  const initialized = await handleFoursdayMcpRequest({
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" },
  });
  assert.equal(initialized.result.serverInfo.name, "foursday");
  const listed = await handleFoursdayMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["foursday_remember_project_fact"]);
  assert.ok(listed.result.tools[0].inputSchema.required.includes("contextToken"));
});

test("memory tool binds project, requester and session outside model-controlled arguments", async (t) => {
  const value = await fixture(t);
  let admitted;
  const result = await callFoursdayCodexTool(input(value.token), {
    environment: value.environment,
    cwd: value.root,
    admit: async (candidate, options) => {
      admitted = { candidate, options };
      return {
        accepted: true,
        status: "proposed",
        projectId: candidate.projectId,
        automaticPromotionQueued: true,
      };
    },
  });
  assert.equal(result.accepted, true);
  assert.equal(admitted.candidate.projectId, "example");
  assert.equal(admitted.candidate.sourcePrincipalId, "d".repeat(64));
  assert.equal(admitted.candidate.sourceSessionHash, "b".repeat(64));
  assert.equal("contextToken" in admitted.candidate, false);
  assert.equal(admitted.options.configPath, value.environment.FOURSDAY_PRODUCTION_CONFIG);
  assert.doesNotMatch(JSON.stringify(result), /trusted-user|fctx_|dddddddd/u);
});

test("expired, wrong-workspace and broadly-readable work contexts fail closed", async (t) => {
  const expired = await fixture(t, { expiresAt: 1 });
  await assert.rejects(callFoursdayCodexTool(input(expired.token), {
    environment: expired.environment,
    cwd: expired.root,
  }), /work_context_expired/u);

  const current = await fixture(t);
  const other = await realpath(await mkdtemp(join(tmpdir(), "foursday-codex-other-")));
  t.after(() => rm(other, { recursive: true, force: true }));
  await assert.rejects(callFoursdayCodexTool(input(current.token), {
    environment: current.environment,
    cwd: other,
  }), /workspace_mismatch/u);

  await chmod(current.contextPath, 0o644);
  await assert.rejects(callFoursdayCodexTool(input(current.token), {
    environment: current.environment,
    cwd: current.root,
  }), /work_context_unavailable/u);

  const linked = await fixture(t);
  const linkPath = join(linked.root, "linked-contexts.json");
  await symlink(linked.contextPath, linkPath);
  await assert.rejects(callFoursdayCodexTool(input(linked.token), {
    environment: { ...linked.environment, FOURSDAY_WORK_CONTEXT_FILE: linkPath },
    cwd: linked.root,
  }), /work_context_unavailable/u);
});
