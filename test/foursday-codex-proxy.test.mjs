import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  classifyCodexServerRequest,
  codexProcessEnvironment,
  injectFoursdayTurnContext,
  rewriteCodexClientRequest,
  runFoursdayCodexProxy,
} from "../src/foursday-codex-proxy.mjs";
import {
  foursdayCodexConfig,
  foursdayCodexRules,
} from "../src/foursday-native-profile-config.mjs";

const execFileAsync = promisify(execFile);

test("proxy forces the Foursday permission profile on every Codex thread", () => {
  const initialized = rewriteCodexClientRequest({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { capabilities: { optOutNotificationMethods: ["x"] } },
  });
  assert.equal(initialized.params.capabilities.experimentalApi, true);
  assert.deepEqual(initialized.params.capabilities.optOutNotificationMethods, ["x"]);
  for (const method of ["thread/start"]) {
    const rewritten = rewriteCodexClientRequest({
      jsonrpc: "2.0", id: 2, method,
      params: {
        cwd: "/project",
        approvalPolicy: "never",
        sandbox: "dangerFullAccess",
        permissions: { type: "profile", id: ":danger-full-access" },
      },
    }, { developerInstructions: "Foursday trusted instructions" });
    assert.equal(rewritten.params.cwd, "/project");
    assert.equal(rewritten.params.approvalPolicy, "untrusted");
    assert.equal(rewritten.params.permissions, "foursday-workspace");
    assert.equal(rewritten.params.serviceName, "foursday");
    assert.equal(rewritten.params.sandbox, undefined);
    assert.equal(rewritten.params.developerInstructions, "Foursday trusted instructions");
  }
  for (const method of ["thread/resume", "thread/fork"]) {
    assert.throws(() => rewriteCodexClientRequest({
      jsonrpc: "2.0", id: 8, method, params: { threadId: "foreign" },
    }, { developerInstructions: "Foursday trusted instructions" }), /unbound_thread_denied/u);
  }
  const turn = rewriteCodexClientRequest({
    jsonrpc: "2.0", id: 4, method: "turn/start",
    params: {
      threadId: "thread",
      input: [],
      cwd: "/project",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      permissions: ":danger-full-access",
      config: { default_permissions: ":danger-full-access" },
      runtimeWorkspaceRoots: ["/"],
      environments: [{ id: "remote" }],
      dynamicTools: [{ name: "unsafe" }],
      collaborationMode: { mode: "default", settings: { developer_instructions: "unsafe" } },
    },
  }, {
    allowedRoots: new Set(["/project"]),
    developerInstructions: "Foursday trusted instructions",
  });
  assert.equal(turn.params.cwd, "/project");
  assert.equal(turn.params.approvalPolicy, "untrusted");
  assert.equal(turn.params.permissions, "foursday-workspace");
  assert.equal(turn.params.sandboxPolicy, undefined);
  assert.equal(turn.params.config, undefined);
  assert.equal(turn.params.runtimeWorkspaceRoots, undefined);
  assert.equal(turn.params.environments, undefined);
  assert.equal(turn.params.dynamicTools, undefined);
  assert.equal(turn.params.collaborationMode, undefined);
  assert.throws(() => rewriteCodexClientRequest({
    jsonrpc: "2.0", id: 5, method: "turn/start",
    params: { threadId: "thread", input: [], cwd: "/other" },
  }, {
    allowedRoots: new Set(["/project"]),
    developerInstructions: "Foursday trusted instructions",
  }), /workspace_denied/u);
  assert.throws(() => rewriteCodexClientRequest({
    jsonrpc: "2.0", id: 3, method: "thread/start", params: { cwd: "/other" },
  }, {
    allowedRoots: new Set(["/project"]),
    developerInstructions: "Foursday trusted instructions",
  }), /workspace_denied/u);
});

test("proxy identifies high-risk commands even through absolute paths or shell wrappers", () => {
  const request = (command) => ({
    method: "item/commandExecution/requestApproval",
    params: { command },
  });
  for (const command of [
    "/usr/bin/git push origin main",
    "/bin/zsh -lc 'rm -rf ./output'",
    "terraform destroy -auto-approve",
    "/usr/bin/security find-generic-password -w",
    "psql -c 'delete from users'",
    "rm notes.txt",
    "git restore important.md",
    "find . -name '*.tmp' -delete",
  ]) assert.equal(classifyCodexServerRequest(request(command)), "high_risk_command");
  assert.equal(classifyCodexServerRequest(request("npm test")), null);
  assert.equal(classifyCodexServerRequest({
    method: "item/permissions/requestApproval",
  }), "permission_escalation");
  assert.equal(classifyCodexServerRequest({
    method: "execCommandApproval",
    params: { command: "git push origin main" },
  }), "high_risk_command");
});

test("proxy rejects command-line config overrides before starting Codex", async () => {
  let spawned = false;
  await assert.rejects(runFoursdayCodexProxy({
    args: ["app-server", "-c", "default_permissions=\":danger-full-access\""],
    spawnProcess: () => { spawned = true; },
  }), /fixed app-server entrypoint/u);
  assert.equal(spawned, false);
});

test("proxy gives Codex only runtime essentials and three MCP path bindings", () => {
  const environment = codexProcessEnvironment({
    HOME: "/home/foursday",
    CODEX_HOME: "/home/foursday/codex",
    FOURSDAY_PRODUCTION_CONFIG: "/private/config.json",
    FOURSDAY_PROJECT_REGISTRY: "/private/projects.json",
    FOURSDAY_WORK_CONTEXT_FILE: "/private/contexts.json",
    FOURSDAY_DINGTALK_USERS: "private-user-id",
    DWS_PERSONAL_ALLOWED_USERS: "private-user-id",
    GH_TOKEN: "secret",
    DATABASE_URL: "secret",
  }, "/usr/local/bin/codex");
  assert.equal(environment.HOME, "/home/foursday");
  assert.equal(environment.FOURSDAY_PROJECT_REGISTRY, "/private/projects.json");
  assert.equal(environment.FOURSDAY_DINGTALK_USERS, undefined);
  assert.equal(environment.DWS_PERSONAL_ALLOWED_USERS, undefined);
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.DATABASE_URL, undefined);
});

test("turn context token becomes project and personal-memory context without reaching the user request", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-turn-context-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = `fctx_${"a".repeat(64)}`;
  const contextPath = join(root, "contexts.json");
  await writeFile(contextPath, `${JSON.stringify({
    schemaVersion: 1,
    contexts: {
      [token]: {
        projectId: "example",
        workspace: root,
        projectContext: "Project: Example. Workspace is already routed.",
        memoryContext: "The owner prefers evidence-first answers.",
        sourcePrincipalHandle: "b".repeat(64),
        sourceSessionHash: "c".repeat(64),
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      },
    },
  })}\n`, { mode: 0o600 });
  const result = await injectFoursdayTurnContext({
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {
      threadId: "thread",
      input: [{ type: "text", text: `What changed?\n\n<!-- foursday-context:${token} -->` }],
    },
  }, {
    environment: {
      FOURSDAY_WORK_CONTEXT_FILE: contextPath,
      FOURSDAY_REQUIRE_WORK_CONTEXT: "true",
    },
    cwd: root,
  });
  const text = result.params.input[0].text;
  assert.match(text, /Project: Example/u);
  assert.match(text, /owner prefers evidence-first/u);
  assert.match(text, /<current_user_request>\nWhat changed\?/u);
  assert.doesNotMatch(text, /<!-- foursday-context:/u);
});

test("real Codex app-server confirms the forced Foursday sandbox and permission profile", async (t) => {
  let codex;
  try {
    codex = String((await execFileAsync("/usr/bin/which", ["codex"])).stdout).trim();
  } catch {
    t.skip("Codex is not installed");
    return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-appserver-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  const workspace = join(root, "workspace");
  const fallback = join(root, "fallback");
  const registry = join(root, "projects.json");
  const profileInstructions = join(root, "SOUL.md");
  const projectSkill = join(root, "project-work.md");
  await mkdir(join(codexHome, "rules"), { recursive: true, mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(fallback, { mode: 0o700 });
  await writeFile(registry, `${JSON.stringify({
    schemaVersion: 1,
    projects: [{ id: "test", name: "Test", aliases: [], root: workspace }],
  })}\n`, { mode: 0o600 });
  await writeFile(profileInstructions, "# Foursday\nWork from evidence.\n", { mode: 0o600 });
  await writeFile(projectSkill, "# Project work\nRead and verify.\n", { mode: 0o600 });
  await writeFile(join(codexHome, "config.toml"), foursdayCodexConfig({
    nodePath: process.execPath,
    mcpPath: fileURLToPath(new URL("../src/foursday-codex-mcp.mjs", import.meta.url)),
  }), { mode: 0o600 });
  await writeFile(join(codexHome, "rules", "foursday.rules"), foursdayCodexRules(), { mode: 0o600 });
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../src/foursday-codex-proxy.mjs", import.meta.url)),
    "app-server",
  ], {
    env: {
      ...process.env,
      FOURSDAY_CODEX_PATH: codex,
      CODEX_HOME: codexHome,
      FOURSDAY_PROJECT_REGISTRY: registry,
      FOURSDAY_FALLBACK_WORKSPACE: fallback,
      FOURSDAY_PROFILE_INSTRUCTIONS_FILE: profileInstructions,
      FOURSDAY_PROJECT_SKILL_FILE: projectSkill,
      FOURSDAY_REQUIRE_WORK_CONTEXT: "false",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode == null) child.kill("SIGTERM");
    await closed;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id != null && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const request = (id, method, params = {}) => new Promise((accept, reject) => {
    pending.set(id, accept);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref();
  });
  const initialized = await request(1, "initialize", {
    clientInfo: { name: "foursday-test", title: "Foursday Test", version: "0.1" },
  });
  assert.equal(initialized.error, undefined);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
  const started = await request(2, "thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "dangerFullAccess",
  });
  assert.equal(started.error, undefined);
  assert.equal(started.result.cwd, workspace);
  assert.equal(started.result.approvalPolicy, "untrusted");
  assert.match(String(started.result.approvalsReviewer), /auto.?review/iu);
  assert.equal(started.result.sandbox.type, "workspaceWrite");
  assert.equal(started.result.sandbox.networkAccess, false);
  assert.equal(started.result.activePermissionProfile.id, "foursday-workspace");
  child.stdin.end();
  child.kill("SIGTERM");
  await closed;
});
