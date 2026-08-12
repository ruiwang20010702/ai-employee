import assert from "node:assert/strict";
import test from "node:test";
import { runProactiveWorker } from "../src/proactive-worker.mjs";

test("主动工作服务生产入口可以加载并在能力关闭时安全完成一次心跳", async () => {
  const events = [];
  const store = {
    async recordHeartbeat(component) { events.push(`heartbeat:${component}`); },
    async isPaused() { return false; },
    async close() { events.push("close"); },
  };
  await runProactiveWorker({
    config: { capabilities: new Set(), proactivePollMs: 1_000 },
    store,
    once: true,
  });
  assert.deepEqual(events, ["heartbeat:proactive", "close"]);
});
