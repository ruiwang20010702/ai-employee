#!/usr/bin/env node
import { isMainModule } from "../src/main-module.mjs";

export const activationHelp = `Foursday activation

Usage:
  npm start -- [options]
  foursday start [options]

Options:
  --port <number>  Set the loopback preview port (default: 4173).
  --help           Show this help and exit.

Safety:
  Help exits without starting a listener or accessing a model, Git, GitHub, SQLite, or production systems.
`;

async function loadActivationRuntime() {
  const [
    { startActivationServer },
    { createDefaultActivationExecutionCoordinator },
    { openAiCompatibleProviderFromEnvironment },
  ] = await Promise.all([
    import("../src/activation-server.mjs"),
    import("../src/activation-execution.mjs"),
    import("../src/openai-compatible-provider.mjs"),
  ]);
  return {
    startActivationServer,
    createDefaultActivationExecutionCoordinator,
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

export async function runActivation({
  args = process.argv.slice(2),
  output = process.stdout,
  loadRuntime = loadActivationRuntime,
  workingDirectory = process.cwd(),
} = {}) {
  if (args.includes("--help")) {
    output.write(activationHelp);
    return null;
  }
  const port = portFrom(args);
  const {
    startActivationServer,
    createDefaultActivationExecutionCoordinator,
    openAiCompatibleProviderFromEnvironment,
  } = await loadRuntime();
  const executionCoordinator = createDefaultActivationExecutionCoordinator({
    workingDirectory,
    modelProvider: openAiCompatibleProviderFromEnvironment(),
  });
  const server = await startActivationServer({
    port,
    workingDirectory,
    executionCoordinator,
  });
  output.write(`Foursday activation is ready: ${server.url}\n`);
  output.write("Preview is read-only. Local SQLite, model, Git, and GitHub are used only after explicit plan approval.\n");
  return server;
}

if (isMainModule(import.meta.url)) await runActivation();
