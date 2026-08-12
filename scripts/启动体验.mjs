#!/usr/bin/env node
import { startActivationServer } from "../src/activation-server.mjs";
import { createDefaultActivationExecutionCoordinator } from "../src/activation-execution.mjs";
import { isMainModule } from "../src/main-module.mjs";
import { openAiCompatibleProviderFromEnvironment } from "../src/openai-compatible-provider.mjs";

function portFrom(args) {
  const index = args.indexOf("--port");
  if (index === -1) return 4173;
  const port = Number(args[index + 1]);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  return port;
}

export async function runActivation({ args = process.argv.slice(2), output = process.stdout } = {}) {
  const workingDirectory = process.cwd();
  const executionCoordinator = createDefaultActivationExecutionCoordinator({
    workingDirectory,
    modelProvider: openAiCompatibleProviderFromEnvironment(),
  });
  const server = await startActivationServer({
    port: portFrom(args),
    workingDirectory,
    executionCoordinator,
  });
  output.write(`Foursday activation is ready: ${server.url}\n`);
  output.write("Preview is read-only. Local SQLite, model, Git, and GitHub are used only after explicit plan approval.\n");
  return server;
}

if (isMainModule(import.meta.url)) await runActivation();
