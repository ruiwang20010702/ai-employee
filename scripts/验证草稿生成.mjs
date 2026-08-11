import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { runStructuredDraftProbe } from "../src/codex-draft-probe.mjs";
import { ClaudeCodeAgentRuntime } from "../src/agent-runtime.mjs";

if (process.env.AI_EMPLOYEE_CONFIG_FILE) {
  await applyProductionConfigFile();
}
const config = loadConfig({ requireTargets: false });
const runtime = config.agentRuntime === "claude-code"
  ? new ClaudeCodeAgentRuntime({ executable: config.claudeCodePath })
  : undefined;
const result = await runStructuredDraftProbe({
  codexPath: config.codexPath,
  runtime,
  expectedDecisionSource: config.agentRuntime,
});
console.log(JSON.stringify(result, null, 2));
