import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertAgentRuntime } from "./adapter-contracts.mjs";
import {
  ClaudeCodeAgentRuntime,
  CodexAgentRuntime,
  ModelProviderAgentRuntime,
} from "./agent-runtime.mjs";

const artifactSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    artifact: { type: "string", minLength: 1 },
  },
  required: ["artifact"],
});

export class StructuredArtifactRuntime {
  constructor(agentRuntime) {
    this.agentRuntime = assertAgentRuntime(agentRuntime);
    this.id = agentRuntime.id;
  }

  async generateArtifact({
    prompt,
    workingDirectory,
    outputDirectory,
    timeoutMs = 120_000,
    maxBytes = 256 * 1024,
    signal = null,
  }) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) {
      throw new Error("Artifact byte limit must be between 1 and 4194304");
    }
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    await chmod(outputDirectory, 0o700);
    const runDirectory = join(outputDirectory, `artifact-${randomUUID()}`);
    await mkdir(runDirectory, { mode: 0o700 });
    const schemaPath = join(runDirectory, "schema.json");
    try {
      await writeFile(schemaPath, `${JSON.stringify(artifactSchema)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      const result = await this.agentRuntime.generateDraft({
        prompt: [
          prompt,
          "Return exactly one JSON object matching the supplied schema. Put the complete requested artifact in artifact and add no commentary outside it.",
        ].join("\n\n"),
        schemaPath,
        workspacePath: workingDirectory,
        outputDirectory: runDirectory,
        timeoutMs,
        context: { purpose: "work_artifact", runtimeId: this.id },
        signal,
      });
      if (!result || typeof result.artifact !== "string" || result.artifact.length === 0) {
        throw new Error(`${this.id} returned an invalid artifact envelope`);
      }
      const bytes = Buffer.byteLength(result.artifact);
      if (bytes > maxBytes) throw new Error(`${this.id} artifact exceeded size limit`);
      return {
        output: result.artifact,
        bytes,
        sha256: createHash("sha256").update(result.artifact).digest("hex"),
        runtimeId: this.id,
      };
    } finally {
      await rm(runDirectory, { recursive: true, force: true });
    }
  }
}

export function createStructuredArtifactRuntime({
  runtime,
  codexPath,
  claudeCodePath,
  modelProvider = null,
  environment = process.env,
} = {}) {
  if (runtime === "codex") {
    return new StructuredArtifactRuntime(new CodexAgentRuntime({
      executable: codexPath,
      environment,
    }));
  }
  if (runtime === "claude-code") {
    return new StructuredArtifactRuntime(new ClaudeCodeAgentRuntime({
      executable: claudeCodePath,
      environment,
    }));
  }
  if (runtime === "openai-compatible" && modelProvider) {
    return new StructuredArtifactRuntime(new ModelProviderAgentRuntime(modelProvider));
  }
  throw new Error(`Artifact runtime is unavailable: ${runtime ?? "missing"}`);
}
