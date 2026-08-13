import { adapterContractVersion } from "./adapter-contracts.mjs";

function required(value, name, maximum = 4_000) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function compatibleEndpoint(value) {
  let base;
  try {
    base = new URL(required(value, "FOURSDAY_OPENAI_BASE_URL", 2_000));
  } catch {
    throw new Error("FOURSDAY_OPENAI_BASE_URL must be a valid URL");
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error("OpenAI-compatible base URL cannot contain credentials, query, or fragment");
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(base.hostname.toLowerCase());
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    throw new Error("OpenAI-compatible base URL must use HTTPS or loopback HTTP");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL("chat/completions", base);
}

function combinedSignal(signal, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) {
    throw new Error("OpenAI-compatible timeout must be between 1 and 900000 ms");
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function providerError(kind, status = null) {
  const error = new Error(`OpenAI-compatible structured generation failed [${kind}${status ? ` status=${status}` : ""}]`);
  error.code = `MODEL_PROVIDER_${kind.toUpperCase()}`;
  return error;
}

export class OpenAiCompatibleModelProvider {
  constructor({ baseUrl, apiKey, model, fetchImpl = fetch } = {}) {
    this.id = "openai-compatible";
    this.contractVersion = adapterContractVersion;
    this.endpoint = compatibleEndpoint(baseUrl);
    this.apiKey = required(apiKey, "FOURSDAY_OPENAI_API_KEY", 16_384);
    this.model = required(model, "FOURSDAY_OPENAI_MODEL", 200);
    this.fetchImpl = fetchImpl;
  }

  async generateStructured({ prompt, schema, timeoutMs = 120_000, signal = null }) {
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: required(prompt, "prompt", 1_000_000) }],
          response_format: {
            type: "json_schema",
            json_schema: { name: "foursday_artifact", strict: true, schema },
          },
        }),
        redirect: "error",
        signal: combinedSignal(signal, timeoutMs),
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        const cancelled = new Error("OpenAI-compatible generation cancelled");
        cancelled.code = "WORK_PLAN_CANCELLED";
        throw cancelled;
      }
      if (error?.name === "TimeoutError") throw providerError("timeout");
      throw providerError("network");
    }
    if (!response.ok) throw providerError("response", response.status);
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw providerError("invalid_json");
    }
    const content = envelope?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw providerError("missing_content");
    }
    try {
      const value = JSON.parse(content);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("invalid structured value");
      }
      return value;
    } catch {
      throw providerError("invalid_structured_output");
    }
  }
}

export function openAiCompatibleProviderFromEnvironment(environment = process.env) {
  const values = [
    environment.FOURSDAY_OPENAI_BASE_URL,
    environment.FOURSDAY_OPENAI_API_KEY,
    environment.FOURSDAY_OPENAI_MODEL,
  ];
  if (values.every((value) => !String(value ?? "").trim())) return null;
  if (values.some((value) => !String(value ?? "").trim())) {
    throw new Error("OpenAI-compatible runtime requires BASE_URL, API_KEY, and MODEL together");
  }
  return new OpenAiCompatibleModelProvider({
    baseUrl: values[0],
    apiKey: values[1],
    model: values[2],
  });
}
