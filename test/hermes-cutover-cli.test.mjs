import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runHermesCutoverCommand } from "../scripts/切换Hermes生产运行时.mjs";

const releaseSha = "a".repeat(40);
const writers = [
  ["listener", "com.foursday.listener"],
  ["worker", "com.foursday.worker"],
  ["executor", "com.foursday.executor"],
  ["proactive", "com.foursday.proactive"],
].map(([component, label]) => ({
  component,
  label,
  sha256: "b".repeat(64),
}));

async function receipt(t, patch = {}) {
  const root = await mkdtemp(join(tmpdir(), "foursday-hermes-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "receipt.json");
  await writeFile(path, `${JSON.stringify({
    schema: "foursday-hermes-cutover-receipt/v1",
    releaseSha,
    legacyWriters: writers,
    ...patch,
  })}\n`, { mode: 0o600 });
  return path;
}

test("Hermes rollback 默认只预览且绑定 active 回执摘要", async (t) => {
  const path = await receipt(t);
  const plan = await runHermesCutoverCommand({
    args: ["rollback", "--receipt", path],
    environment: {},
  });
  assert.equal(plan.schema, "foursday-hermes-rollback-plan/v1");
  assert.equal(plan.releaseSha, releaseSha);
  assert.equal(plan.applyRequired, true);
  assert.equal(plan.executed, false);
  assert.match(plan.confirmation, new RegExp(`^ROLLBACK-HERMES:${releaseSha}:[a-f0-9]{16}$`, "u"));
  assert.deepEqual(plan.stopOrder, ["hermes-active"]);
  assert.deepEqual(plan.restoreOrder, ["listener", "worker", "executor", "proactive"]);
});

test("Hermes rollback 拒绝宽权限回执和伪造服务标签", async (t) => {
  const wide = await receipt(t);
  await chmod(wide, 0o644);
  await assert.rejects(
    runHermesCutoverCommand({
      args: ["rollback", "--receipt", wide],
      environment: {},
    }),
    /private regular file/u,
  );

  const forged = await receipt(t, {
    legacyWriters: writers.map((item, index) => index === 0
      ? { ...item, label: "../com.foursday.listener" }
      : item),
  });
  await assert.rejects(
    runHermesCutoverCommand({
      args: ["rollback", "--receipt", forged],
      environment: {},
    }),
    /invalid legacy writers/u,
  );
});
