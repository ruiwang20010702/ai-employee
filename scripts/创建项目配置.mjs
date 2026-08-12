import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { buildProjectOnboardingDraft } from "../src/project-onboarding.mjs";
import { loadConfig } from "../src/config.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const write = args.includes("--write");
const projectId = value("--project-id");
const name = value("--name");
const rootInput = value("--root");
const requester = value("--requester");
const objective = value("--objective") ?? `Safely deliver the outcomes of ${name ?? "this project"}`;
const recipeIds = String(value("--recipes") ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
if (!projectId || !name || !rootInput || !requester) {
  throw new Error(
    "Usage: 创建项目配置.mjs --project-id <id> --name <名称> --root <绝对路径> --requester <用户ID> --objective <项目目标> [--recipes <配方1,配方2>] [--write]",
  );
}
const rootDirectory = await realpath(rootInput);
const { manifest } = await buildProjectOnboardingDraft({
  projectId,
  name,
  rootDirectory,
  requesterIds: [requester],
  profile: {
    objective,
    selectedRecipeIds: recipeIds,
    memoryScope: { allowedTypes: ["project", "principle"], retentionDays: 90 },
  },
});
const output = `${JSON.stringify(manifest, null, 2)}\n`;
if (!write) {
  process.stdout.write(output);
} else {
  if (process.env.AI_EMPLOYEE_CONFIG_FILE) await applyProductionConfigFile();
  const config = loadConfig({ requireTargets: false });
  await mkdir(config.projectsDirectory, { recursive: true, mode: 0o700 });
  const destination = join(config.projectsDirectory, `${projectId}.json`);
  await writeFile(destination, output, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ created: true, projectId, file: basename(destination) }));
}
