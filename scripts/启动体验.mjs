#!/usr/bin/env node
import { isMainModule } from "../src/main-module.mjs";

export const activationHelp = `Foursday activation

Usage:
  npm start -- [options]
  foursday start [options]

Options:
  --port <number>  Set the loopback preview port (default: 4173).
  --pilot-sha <sha>  Offer approval-bound fork preparation for this exact commit.
  --help           Show this help and exit.

Safety:
  Help exits without starting a listener or accessing a model, Git, GitHub, SQLite, or production systems.
`;

async function loadActivationRuntime() {
  const [
    { startActivationServer },
    { createDefaultActivationExecutionCoordinator, inspectActivationReadiness },
    { prepareFoursdayPilotWorkspace },
    { openAiCompatibleProviderFromEnvironment },
  ] = await Promise.all([
    import("../src/activation-server.mjs"),
    import("../src/activation-execution.mjs"),
    import("../src/pilot-workspace.mjs"),
    import("../src/openai-compatible-provider.mjs"),
  ]);
  return {
    startActivationServer,
    createDefaultActivationExecutionCoordinator,
    inspectActivationReadiness,
    prepareFoursdayPilotWorkspace,
    openAiCompatibleProviderFromEnvironment,
  };
}

function portFrom(args) {
  const index = args.indexOf("--port");
  if (index === -1) return 4173;
  const port = Number(args[index + 1]);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  return port;
}

function optionValue(args, name) {
  const indexes = args.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length === 0) return null;
  if (indexes.length > 1 || !args[indexes[0] + 1] || args[indexes[0] + 1].startsWith("--")) {
    throw new Error(`${name} must be provided once with a value`);
  }
  return args[indexes[0] + 1];
}

function pilotShaFrom(args) {
  const value = optionValue(args, "--pilot-sha");
  if (value !== null && !/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error("--pilot-sha must be a complete 40-character lowercase commit SHA");
  }
  return value;
}

function validateOptions(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (["--port", "--pilot-sha"].includes(args[index])) {
      index += 1;
      continue;
    }
    if (args[index] === "--help") continue;
    throw new Error(`Unknown activation option: ${args[index]}`);
  }
}

export async function runActivation({
  args = process.argv.slice(2),
  output = process.stdout,
  loadRuntime = loadActivationRuntime,
  workingDirectory = process.cwd(),
  environment = process.env,
} = {}) {
  if (args.includes("--help")) {
    output.write(activationHelp);
    return null;
  }
  validateOptions(args);
  const port = portFrom(args);
  const pilotSourceSha = pilotShaFrom(args);
  const {
    startActivationServer,
    createDefaultActivationExecutionCoordinator,
    inspectActivationReadiness,
    openAiCompatibleProviderFromEnvironment,
    prepareFoursdayPilotWorkspace,
  } = await loadRuntime();
  let modelProvider = null;
  let openAiCompatibleConfigurationError = false;
  try {
    modelProvider = openAiCompatibleProviderFromEnvironment(environment);
  } catch {
    openAiCompatibleConfigurationError = true;
  }
  const executionCoordinator = createDefaultActivationExecutionCoordinator({
    workingDirectory,
    modelProvider,
    environment,
  });
  const readinessChecker = () => inspectActivationReadiness({
    environment,
    openAiCompatibleConfigured: Boolean(modelProvider),
    openAiCompatibleConfigurationError,
  });
  const pilotWorkspace = pilotSourceSha
    ? {
        sourceSha: pilotSourceSha,
        async prepare({ confirmForkAndClone }) {
          const ghPath = executionCoordinator.ghPathProvider
            ? await executionCoordinator.ghPathProvider()
            : executionCoordinator.ghPath;
          return prepareFoursdayPilotWorkspace({
            sourceSha: pilotSourceSha,
            confirmForkAndClone,
          }, { ghPath });
        },
      }
    : null;
  const server = await startActivationServer({
    port,
    workingDirectory,
    executionCoordinator,
    pilotWorkspace,
    readinessChecker,
  });
  output.write(`Foursday activation is ready: ${server.url}\n`);
  output.write("Preview is read-only. Pilot fork setup requires separate confirmation; delivery still requires exact-plan approval.\n");
  return server;
}

if (isMainModule(import.meta.url)) await runActivation();
