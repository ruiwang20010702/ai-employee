import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateCodexPluginPackage } from "../src/codex-plugin-package.mjs";
import {
  adminBaseUrl,
  createAdminReader,
  createMcpHandler,
  pluginVersion,
  runStdioServer,
} from "../plugins/foursday/scripts/mcp-server.mjs";

test("仓库市场以显式安装方式发布只读 Codex 插件", async () => {
  const result = await validateCodexPluginPackage({
    root: fileURLToPath(new URL("../", import.meta.url)),
  });
  assert.deepEqual(result, {
    valid: true,
    marketplace: "foursday-local",
    plugin: "foursday",
    version: "0.4.0",
    installation: "AVAILABLE",
    authentication: "ON_INSTALL",
    readOnly: true,
    checkedDistributionFiles: 6,
    personalConfigurationWrite: false,
  });
});

test("应用包、插件清单和 MCP 服务版本保持一致", async () => {
  const [application, plugin] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(
      new URL("../plugins/foursday/.codex-plugin/plugin.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
  ]);
  assert.equal(application.version, "0.4.0");
  assert.equal(plugin.version, application.version);
  assert.equal(pluginVersion, application.version);
});

test("仓库市场不能通过符号链接把插件来源指向仓库外", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-plugin-marketplace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".agents", "plugins"), { recursive: true });
  await mkdir(join(root, "plugins"), { recursive: true });
  await symlink(
    fileURLToPath(new URL("../plugins/foursday", import.meta.url)),
    join(root, "plugins", "foursday"),
  );
  await writeFile(join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "foursday-local",
    interface: { displayName: "Foursday（本仓库）" },
    plugins: [{
      name: "foursday",
      source: { source: "local", path: "./plugins/foursday" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  }));
  await assert.rejects(
    validateCodexPluginPackage({ root }),
    /escapes the package root/u,
  );
});

test("Codex MCP 只提供只读工具且状态卡片具备无界面降级结果", async () => {
  const handler = createMcpHandler({
    readAdmin: async (path) => {
      assert.equal(path, "/api/overview");
      return {
        ready: true,
        paused: false,
        sendMode: "真实发送关闭",
        taskCounts: { awaiting_approval: 2, waiting_information: 3, dead: 1 },
        planCounts: { awaiting_approval: 3 },
        confirmedMemoryCount: 4,
        projectCount: 5,
        checks: {
          database: true,
          dwsExecutable: true,
          codexExecutable: true,
          deadTasks: 1,
          heartbeats: { worker: { healthy: true, lastSeenAt: "不得返回" } },
          operationalChecks: { reconciliation: { healthy: false, detail: "不得返回" } },
          messageCoverage: { required: true, healthy: true, sourceMessages: 99 },
          secret: "不得返回",
        },
      };
    },
  });
  const listed = await handler({ method: "tools/list" });
  assert.equal(listed.tools.length, 7);
  assert.ok(listed.tools.every((tool) => tool.annotations.readOnlyHint));
  assert.ok(listed.tools.every((tool) => !/approve|send|execute/u.test(tool.name)));
  const panelTool = listed.tools.find((tool) => tool.name === "show_status_panel");
  assert.equal(panelTool._meta.ui.resourceUri, "ui://foursday/status.html");

  const result = await handler({ method: "tools/call", params: { name: "show_status_panel", arguments: {} } });
  assert.equal(result.structuredContent.ready, true);
  assert.equal(result.structuredContent.taskCounts.awaiting_approval, 2);
  assert.equal(result.structuredContent.taskCounts.waiting_information, 3);
  assert.deepEqual(result.structuredContent.checks, {
    database: true,
    dwsExecutable: true,
    codexExecutable: true,
    deadTasks: 1,
    unknownSends: 0,
    expiredExecutionLeases: 0,
    heartbeats: { worker: true },
    operationalChecks: { reconciliation: false },
    messageCoverage: { required: true, healthy: true },
  });
  assert.doesNotMatch(JSON.stringify(result), /不得返回/u);
});

test("待审批草稿只在专用工具中返回并限制数量与字段", async () => {
  const handler = createMcpHandler({
    readAdmin: async () => ({
      items: Array.from({ length: 25 }, (_, index) => ({
        id: `task-${index}`,
        senderName: "联系人",
        contentPreview: "原消息",
        draft: "建议回复",
        riskLevel: "low",
        reason: "需要确认",
        workingDirectory: "/private/project",
        payload: { secret: "不得返回" },
      })),
    }),
  });
  const result = await handler({ method: "tools/call", params: { name: "list_pending_drafts", arguments: {} } });
  assert.equal(result.structuredContent.count, 20);
  assert.deepEqual(Object.keys(result.structuredContent.items[0]).sort(), [
    "draft", "id", "originalMessage", "reason", "riskLevel", "senderName", "updatedAt",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private|不得返回/u);
});

test("管理客户端只访问本机只读接口且不泄露钥匙串令牌", async () => {
  assert.equal(adminBaseUrl("http://localhost:9465"), "http://localhost:9465");
  assert.equal(adminBaseUrl("http://[::1]:9465"), "http://[::1]:9465");
  assert.throws(() => adminBaseUrl("https://example.com"), /loopback/u);
  const captured = [];
  const nonce = "n".repeat(43);
  const read = createAdminReader({
    baseUrl: "http://127.0.0.1:9465",
    tokenReader: async () => "private-read-token",
    request: async (url, init) => {
      captured.push({ url, init });
      if (url.endsWith("/api/auth/challenge")) {
        return { ok: true, json: async () => ({ nonce }) };
      }
      return { ok: true, json: async () => ({ ready: true }) };
    },
  });
  assert.deepEqual(await read("/api/overview"), { ready: true });
  assert.equal(captured[0].url, "http://127.0.0.1:9465/api/auth/challenge");
  assert.equal(captured[0].init.method, "POST");
  assert.equal(captured[0].init.headers.authorization, undefined);
  assert.equal(captured[1].url, "http://127.0.0.1:9465/api/overview");
  assert.equal(captured[1].init.method, "GET");
  assert.equal(captured[1].init.headers.authorization, undefined);
  assert.equal(captured[1].init.headers["x-foursday-challenge"], nonce);
  assert.equal(
    captured[1].init.headers["x-foursday-proof"],
    createHmac("sha256", "private-read-token")
      .update(`${nonce}\nGET\n/api/overview`)
      .digest("hex"),
  );
  assert.doesNotMatch(JSON.stringify(captured), /private-read-token/u);
  await assert.rejects(read("/api/system/pause"), /Unsupported/u);
});

test("stdio 传输完成初始化、工具枚举并稳定返回协议错误", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const running = runStdioServer({
    input,
    output,
    handler: createMcpHandler({ readAdmin: async () => ({ ready: true }) }),
  });
  input.end([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "missing", arguments: {} } }),
  ].join("\n"));
  await running;
  const messages = text.trim().split("\n").map(JSON.parse);
  assert.equal(messages[0].result.serverInfo.name, "foursday");
  assert.equal(messages[0].result.serverInfo.version, pluginVersion);
  assert.equal(messages[1].result.tools.length, 7);
  assert.equal(messages[2].error.code, -32601);
});

test("状态 UI 资源符合 MCP Apps 类型且不含写入动作", async () => {
  const handler = createMcpHandler({ readAdmin: async () => ({}) });
  const result = await handler({ method: "resources/read", params: { uri: "ui://foursday/status.html" } });
  assert.equal(result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(result.contents[0].text, /ui\/notifications\/tool-result/u);
  assert.match(result.contents[0].text, /等待补充信息/u);
  assert.doesNotMatch(result.contents[0].text, /批准|发送消息|执行计划/u);
});
