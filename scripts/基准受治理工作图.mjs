import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import {
  benchmarkGovernedGraph,
  buildGraphBenchmarkFixture,
} from "../src/governed-work-graph-benchmark.mjs";

const directory = await mkdtemp(join(tmpdir(), "foursday-graph-benchmark-"));
let store;
try {
  store = await new Store(join(directory, "benchmark.sqlite")).open();
  const result = await benchmarkGovernedGraph({
    store,
    fixture: buildGraphBenchmarkFixture({ planCount: 30 }),
    iterations: 100,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  store?.close();
  await rm(directory, { recursive: true, force: true });
}
