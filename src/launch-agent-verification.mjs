import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function outputLines(output) {
  return String(output ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function validateLoadedLaunchAgent(
  output,
  { label, scriptPath, componentArgument = null, workingDirectory, configPath },
) {
  const lines = outputLines(output);
  const expectedHeaderSuffix = `/${label} = {`;
  const expectedWorkingDirectory = `working directory = ${workingDirectory}/`;
  const expectedConfig = `AI_EMPLOYEE_CONFIG_FILE => ${configPath}`;
  const failures = [];

  if (!lines[0]?.endsWith(expectedHeaderSuffix)) failures.push("label_mismatch");
  if (!lines.includes(scriptPath)) failures.push("script_path_mismatch");
  if (componentArgument && !lines.includes(componentArgument)) {
    failures.push("component_argument_mismatch");
  }
  if (!lines.includes(expectedWorkingDirectory)) failures.push("working_directory_mismatch");
  if (!lines.includes(expectedConfig)) failures.push("config_path_mismatch");

  return {
    verified: failures.length === 0,
    failures,
  };
}

export async function verifyLoadedLaunchAgents({
  definitions,
  releaseDirectory,
  configPath,
  scriptPathFor,
  run = execFileAsync,
  uid = process.getuid(),
}) {
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw new Error("LaunchAgent definitions are required");
  }
  if (typeof scriptPathFor !== "function") {
    throw new Error("LaunchAgent script path resolver is required");
  }

  const resolvedRelease = await realpath(resolve(releaseDirectory));
  const resolvedConfig = await realpath(resolve(configPath));
  const expectedConfig = join(resolvedRelease, ".runtime", "production.json");
  if (resolvedConfig !== expectedConfig) {
    throw new Error("Production config must belong to the expected release");
  }

  const results = await Promise.all(
    definitions.map(async (definition) => {
      try {
        const { stdout } = await run("/bin/launchctl", [
          "print",
          `gui/${uid}/${definition.label}`,
        ], {
          timeout: 5_000,
          maxBuffer: 1024 * 1024,
        });
        const scriptPath = scriptPathFor(definition, resolvedRelease);
        const result = validateLoadedLaunchAgent(stdout, {
          label: definition.label,
          scriptPath,
          componentArgument: scriptPath.endsWith("/src/service-launcher.mjs")
            ? definition.component
            : null,
          workingDirectory: resolvedRelease,
          configPath: resolvedConfig,
        });
        return { label: definition.label, ...result };
      } catch {
        return {
          label: definition.label,
          verified: false,
          failures: ["launch_agent_unavailable"],
        };
      }
    }),
  );
  const failedLabels = results
    .filter((result) => !result.verified)
    .map((result) => result.label);

  return {
    verified: failedLabels.length === 0,
    failedLabels,
  };
}
