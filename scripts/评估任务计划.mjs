import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateProjectManifest } from "../src/capability-policy.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";
import { readStdin } from "../src/stdin.mjs";

const manifestPath = process.argv[2];
if (!manifestPath) {
  throw new Error("Usage: npm run plan:check -- <项目能力清单.json>, plan from stdin");
}
const [manifestInput, planInput] = await Promise.all([
  readFile(resolve(manifestPath), "utf8"),
  readStdin(),
]);
const result = assessWorkPlan({
  manifest: validateProjectManifest(JSON.parse(manifestInput)),
  plan: JSON.parse(planInput),
});
console.log(
  JSON.stringify({
    decision: result.decision,
    reason: result.reason,
    projectId: result.projectId,
    maxLevel: result.maxLevel,
    planHash: result.planHash,
    steps: result.steps,
  }),
);
