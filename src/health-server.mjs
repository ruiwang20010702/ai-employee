import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { evaluateHealth, prometheusMetrics } from "./health-check.mjs";
import { createProductionStore } from "./production-store.mjs";

export async function startHealthServer({
  config = loadConfig({ requireTargets: false, production: true }),
  store = null,
} = {}) {
  if (
    !["127.0.0.1", "::1", "localhost"].includes(config.healthHost) &&
    !config.healthAuthToken
  ) {
    throw new Error(
      "AI_EMPLOYEE_HEALTH_AUTH_TOKEN is required when health server is not loopback-only",
    );
  }
  store = store ?? (await createProductionStore(config));
  const authorized = (request) =>
    !config.healthAuthToken ||
    request.headers.authorization === `Bearer ${config.healthAuthToken}`;

  const server = createServer(async (request, response) => {
    if (request.url === "/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"alive"}\n');
      return;
    }
    if (!authorized(request)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"unauthorized"}\n');
      return;
    }
    try {
      const health = await evaluateHealth({ store, config });
      if (request.url === "/ready") {
        response.writeHead(health.ready ? 200 : 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(
          `${JSON.stringify({
            status: health.ready ? "ready" : "degraded",
            checks: health.checks,
          })}\n`,
        );
        return;
      }
      if (request.url === "/metrics") {
        response.writeHead(200, {
          "content-type": "text/plain; version=0.0.4",
          "cache-control": "no-store",
        });
        response.end(prometheusMetrics(health));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}\n');
    } catch {
      response.writeHead(503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end('{"status":"degraded","error":"dependency_check_failed"}\n');
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(config.healthPort, config.healthHost, resolveListen);
  });
  console.log(JSON.stringify({ type: "health.started" }));

  return {
    server,
    async stop(signal = "manual") {
      await new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
      await store.close();
      console.log(JSON.stringify({ type: "health.stopped", signal }));
    },
  };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const service = await startHealthServer();
  const shutdown = async (signal) => {
    await service.stop(signal);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
