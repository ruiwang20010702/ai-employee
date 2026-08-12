import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenAiCompatibleModelProvider,
  openAiCompatibleProviderFromEnvironment,
} from "../src/openai-compatible-provider.mjs";

test("OpenAI-compatible provider requests strict structured output without exposing its key", async () => {
  let request;
  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: "https://models.example.test/v1",
    apiKey: "secret-provider-key",
    model: "example-model",
    async fetchImpl(url, options) {
      request = { url: String(url), options };
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ artifact: "patch" }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(await provider.generateStructured({
    prompt: "prepare the approved artifact",
    schema: { type: "object", required: ["artifact"] },
  }), { artifact: "patch" });
  assert.equal(request.url, "https://models.example.test/v1/chat/completions");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.authorization, "Bearer secret-provider-key");
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "example-model");
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);

  const failing = new OpenAiCompatibleModelProvider({
    baseUrl: "https://models.example.test/v1/",
    apiKey: "secret-provider-key",
    model: "example-model",
    fetchImpl: async () => new Response("secret-provider-key", { status: 401 }),
  });
  await assert.rejects(
    failing.generateStructured({ prompt: "fixture", schema: {} }),
    (error) => error.code === "MODEL_PROVIDER_RESPONSE" &&
      !error.message.includes("secret-provider-key"),
  );
});

test("OpenAI-compatible provider allows only HTTPS or loopback HTTP targets", () => {
  for (const baseUrl of [
    "http://models.example.test/v1/",
    "https://user:password@models.example.test/v1/",
    "https://models.example.test/v1/?target=other",
  ]) {
    assert.throws(() => new OpenAiCompatibleModelProvider({
      baseUrl,
      apiKey: "secret",
      model: "model",
    }));
  }
  assert.doesNotThrow(() => new OpenAiCompatibleModelProvider({
    baseUrl: "http://127.0.0.1:11434/v1/",
    apiKey: "local-placeholder",
    model: "local-model",
  }));
});

test("OpenAI-compatible configuration is all-or-nothing and cancellation propagates", async () => {
  assert.equal(openAiCompatibleProviderFromEnvironment({}), null);
  assert.throws(
    () => openAiCompatibleProviderFromEnvironment({
      FOURSDAY_OPENAI_BASE_URL: "https://models.example.test/v1/",
    }),
    /requires BASE_URL, API_KEY, and MODEL together/u,
  );
  const controller = new AbortController();
  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: "https://models.example.test/v1/",
    apiKey: "secret",
    model: "model",
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    }),
  });
  const run = provider.generateStructured({ prompt: "fixture", schema: {}, signal: controller.signal });
  controller.abort();
  await assert.rejects(run, (error) => error.code === "WORK_PLAN_CANCELLED");
});
