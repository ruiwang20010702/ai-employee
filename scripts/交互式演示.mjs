#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runDemoScenario } from "../src/demo.mjs";
import { isMainModule } from "../src/main-module.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export async function runInteractiveDemo({
  args = process.argv.slice(2),
  input = stdin,
  output = stdout,
} = {}) {
  const known = new Set(["--message", "--approve", "--json", "--group"]);
  for (let index = 0; index < args.length; index += 1) {
    if (!known.has(args[index])) throw new Error(`Unknown option: ${args[index]}`);
    if (args[index] === "--message") index += 1;
  }
  let message = option(args, "--message");
  let approved = args.includes("--approve");
  let terminal;
  if (!message && input.isTTY) {
    terminal = createInterface({ input, output });
    message = await terminal.question(
      "Message for the Foursday demo [Prepare a launch checklist]: ",
    );
    if (!message.trim()) message = "Prepare a launch checklist for Project Aurora.";
  }
  message ??= "Prepare a launch checklist for Project Aurora.";

  let result = await runDemoScenario({
    message,
    approved: false,
    chatType: args.includes("--group") ? "group" : "direct",
  });
  if (!approved && terminal) {
    output.write(`\nDraft:\n${result.draft.reply}\n\n`);
    const answer = await terminal.question("Approve this local simulation? [y/N]: ");
    approved = /^(?:y|yes)$/iu.test(answer.trim());
  }
  await terminal?.close();
  if (approved) {
    result = await runDemoScenario({
      message,
      approved: true,
      chatType: args.includes("--group") ? "group" : "direct",
    });
  }

  if (args.includes("--json")) {
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    output.write([
      "",
      "Foursday local demo",
      `Outcome: ${result.outcome}`,
      `Draft: ${result.draft.reply || "(no reply)"}`,
      `External systems touched: ${result.externalSystemsTouched}`,
      `Recorded effects: ${result.sideEffects.length}`,
      `Verified evidence: ${result.evidence.filter((item) => item.verified !== false).length}`,
      "",
      result.outcome === "awaiting_approval"
        ? "Nothing was executed. Re-run with --approve to simulate approved work."
        : "The approved simulation completed with target read-back evidence.",
      "",
    ].join("\n"));
  }
  return result;
}

if (isMainModule(import.meta.url)) {
  await runInteractiveDemo();
}
