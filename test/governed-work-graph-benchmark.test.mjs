import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.mjs";
import {
  benchmarkGovernedGraph,
  buildGraphBenchmarkFixture,
} from "../src/governed-work-graph-benchmark.mjs";

test("生产形态上限基准覆盖存储读取与四类有界查询", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-graph-benchmark-test-"));
  const store = await new Store(join(directory, "benchmark.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const result = await benchmarkGovernedGraph({
    store,
    fixture: buildGraphBenchmarkFixture({ planCount: 30 }),
    iterations: 5,
  });
  assert.ok(result.nodes < 500);
  assert.ok(result.edges < 500);
  assert.equal(result.iterations, 5);
  assert.equal(Number.isFinite(result.p95Ms), true);
  assert.match(result.decision, /transactional_store|specialized_graph_store/u);
});

test("基准拒绝超过驾驶舱边界的输入", () => {
  assert.throws(() => buildGraphBenchmarkFixture({ planCount: 41 }), /between 1 and 40/u);
});
