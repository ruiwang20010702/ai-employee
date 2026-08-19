import { access, lstat, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const hermesGatewayLabel = "com.foursday.hermes-gateway";
export const hermesLegacyWriterComponents = Object.freeze([
  "listener",
  "worker",
  "executor",
  "proactive",
]);

const modes = new Set(["shadow", "active"]);

function absolute(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

async function canonicalFile(
  value,
  name,
  { executable = false, privateFile = false, preserveLexical = false } = {},
) {
  const lexical = absolute(value, name);
  const metadata = await lstat(lexical);
  if (!metadata.isFile() && !metadata.isSymbolicLink()) {
    throw new Error(`${name} must be a regular file`);
  }
  const canonical = await realpath(lexical);
  const target = await lstat(canonical);
  if (!target.isFile()) throw new Error(`${name} must resolve to a regular file`);
  if (privateFile && (target.mode & 0o077) !== 0) {
    throw new Error(`${name} must not be group or world accessible`);
  }
  if (executable) await access(canonical, constants.X_OK);
  else await access(canonical, constants.R_OK);
  return preserveLexical ? lexical : canonical;
}

async function canonicalDirectory(value, name, { privateDirectory = false } = {}) {
  const lexical = absolute(value, name);
  const metadata = await lstat(lexical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${name} must be a canonical directory`);
  }
  const canonical = await realpath(lexical);
  if (canonical !== lexical) throw new Error(`${name} must not use a symlink`);
  if (privateDirectory && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${name} must not be group or world accessible`);
  }
  return canonical;
}

export async function validateHermesProductionPaths(input) {
  const runtimeRoot = await canonicalDirectory(
    input.runtimeRoot,
    "Hermes runtime root",
    { privateDirectory: true },
  );
  const patchedSource = await canonicalDirectory(
    input.patchedSource ?? join(runtimeRoot, "patched"),
    "Hermes patched source",
  );
  const hermesHome = await canonicalDirectory(
    input.hermesHome ?? join(runtimeRoot, "state", ".hermes"),
    "Hermes home",
    { privateDirectory: true },
  );
  const pythonPath = await canonicalFile(
    input.pythonPath ?? join(runtimeRoot, "venv", "bin", "python"),
    "Hermes Python",
    { executable: true, preserveLexical: true },
  );
  const pythonRelative = relative(runtimeRoot, pythonPath);
  if (
    pythonRelative.startsWith("..") ||
    isAbsolute(pythonRelative) ||
    !/^venv\/bin\/python(?:3(?:\.\d+)?)?$/u.test(pythonRelative)
  ) {
    throw new Error("Hermes Python must be the candidate virtualenv entrypoint");
  }
  await canonicalFile(
    join(runtimeRoot, "venv", "pyvenv.cfg"),
    "Hermes virtualenv configuration",
  );
  await canonicalFile(
    join(patchedSource, "hermes_cli", "main.py"),
    "Hermes CLI entrypoint",
  );
  const projectRegistry = await canonicalFile(
    input.projectRegistry,
    "Hermes project registry",
    { privateFile: true },
  );
  const fallbackWorkspace = await canonicalDirectory(
    input.fallbackWorkspace,
    "Hermes fallback workspace",
  );
  const productionConfig = await canonicalFile(
    input.productionConfig,
    "Foursday production config",
    { privateFile: true },
  );
  const nodePath = await canonicalFile(input.nodePath, "Node executable", {
    executable: true,
  });
  const dwsPath = await canonicalFile(input.dwsPath, "DWS executable", {
    executable: true,
  });
  const dwsSidecar = await canonicalFile(
    input.dwsSidecar,
    "Foursday DWS sidecar",
  );
  const memorySidecar = await canonicalFile(
    input.memorySidecar,
    "Foursday memory sidecar",
  );
  const gatewayLauncher = await canonicalFile(
    input.gatewayLauncher,
    "Foursday Hermes Gateway launcher",
  );
  return {
    runtimeRoot,
    patchedSource,
    hermesHome,
    pythonPath,
    projectRegistry,
    fallbackWorkspace,
    productionConfig,
    nodePath,
    dwsPath,
    dwsSidecar,
    memorySidecar,
    gatewayLauncher,
    stateDirectory: dirname(projectRegistry),
  };
}

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export async function validateHermesProjectRegistry({
  projectRegistry,
  fallbackWorkspace,
  mode,
}) {
  if (!modes.has(mode)) throw new Error("Hermes production mode is invalid");
  const document = JSON.parse(await readFile(projectRegistry, "utf8"));
  if (
    !document ||
    Array.isArray(document) ||
    document.schemaVersion !== 1 ||
    !Array.isArray(document.projects) ||
    document.projects.length === 0 ||
    document.projects.length > 100
  ) {
    throw new Error("Hermes production project registry is invalid");
  }
  const projects = [];
  for (const raw of document.projects) {
    const root = await canonicalDirectory(raw?.root, "Hermes project root");
    const isolation = String(raw?.isolation ?? "workspace-write");
    if (!new Set(["read-only", "workspace-write"]).has(isolation)) {
      throw new Error("Hermes production project isolation is invalid");
    }
    if (mode === "shadow" && isolation !== "read-only") {
      throw new Error("Hermes shadow registry must make every project read-only");
    }
    if (overlaps(fallbackWorkspace, root)) {
      throw new Error("Hermes fallback workspace must be outside every registered project");
    }
    projects.push({ id: String(raw?.id ?? ""), root, isolation });
  }
  return { schemaVersion: 1, projectCount: projects.length, projects };
}

function csv(values) {
  if (!Array.isArray(values)) return "";
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
    .join(",");
}

export function narrowHermesTargets(configured, requested, name) {
  const available = [...new Set((configured ?? []).map(String).filter(Boolean))];
  if (requested == null || String(requested).trim() === "") return available;
  const selected = [...new Set(String(requested).split(",").map(
    (value) => value.trim(),
  ).filter(Boolean))];
  if (selected.length === 0 || selected.some((value) => !available.includes(value))) {
    throw new Error(`${name} must be a non-empty subset of the production allowlist`);
  }
  return selected;
}

function bounded(value, fallback, minimum, maximum, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return String(parsed);
}

export function assertHermesWriterBoundary({ mode, legacyServiceStates = {} }) {
  if (!modes.has(mode)) throw new Error("Hermes production mode is invalid");
  if (mode === "shadow") return { mode, sendEnabled: false };
  const activeLegacy = hermesLegacyWriterComponents.filter(
    (component) => legacyServiceStates[component] !== "stopped",
  );
  if (activeLegacy.length > 0) {
    throw new Error(
      `Hermes active mode requires legacy writers to be stopped: ${activeLegacy.join(",")}`,
    );
  }
  return { mode, sendEnabled: true };
}

export function hermesCheckpointFresh({ metadata, state, startedAt }) {
  const fullSuccessAt = new Date(state?.lastFullSuccessAt ?? "").getTime();
  return Boolean(
    metadata?.isFile?.() &&
    (metadata.mode & 0o077) === 0 &&
    Number.isFinite(metadata.mtimeMs) &&
    metadata.mtimeMs >= Number(startedAt) - 5_000 &&
    Number.isFinite(fullSuccessAt) &&
    fullSuccessAt >= Number(startedAt) - 5_000 &&
    state?.lastErrorCount === 0,
  );
}

export function hermesCheckpointCurrentlyHealthy({
  metadata,
  state,
  now = Date.now(),
  maxAgeMs,
}) {
  const fullSuccessAt = new Date(state?.lastFullSuccessAt ?? "").getTime();
  return Boolean(
    Number.isFinite(maxAgeMs) &&
    maxAgeMs > 0 &&
    metadata?.isFile?.() &&
    (metadata.mode & 0o077) === 0 &&
    Number.isFinite(metadata.mtimeMs) &&
    now - metadata.mtimeMs <= maxAgeMs &&
    Number.isFinite(fullSuccessAt) &&
    now - fullSuccessAt <= maxAgeMs &&
    state?.lastErrorCount === 0,
  );
}

export function hermesGatewayPid(record, expectedHome) {
  if (!record || Array.isArray(record) || typeof record !== "object") return null;
  const pid = Number(record.pid);
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (record.kind !== "hermes-gateway") return null;
  if (resolve(String(record.hermes_home ?? "")) !== resolve(expectedHome)) return null;
  return pid;
}

export function hermesGatewayOwnedByService({ gatewayPid, servicePid, parentPid }) {
  return Boolean(
    Number.isSafeInteger(gatewayPid) &&
    gatewayPid > 1 &&
    Number.isSafeInteger(servicePid) &&
    servicePid > 1 &&
    Number.isSafeInteger(parentPid) &&
    parentPid === servicePid,
  );
}

export function buildHermesGatewayEnvironment({
  mode,
  paths,
  config,
  baseEnvironment = process.env,
  legacyServiceStates = {},
}) {
  const boundary = assertHermesWriterBoundary({ mode, legacyServiceStates });
  const dwsHome = absolute(baseEnvironment.HOME, "DWS host home");
  const allowedHost = Object.fromEntries(
    ["USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"]
      .flatMap((name) => typeof baseEnvironment[name] === "string"
        ? [[name, baseEnvironment[name]]]
        : []),
  );
  const stateDirectory = paths.stateDirectory ?? dirname(paths.projectRegistry);
  const fallbackMs = Math.min(Number(config.fallbackMs ?? 30_000), 300_000);
  return {
    ...allowedHost,
    HOME: dirname(dirname(paths.hermesHome)),
    PATH: [
      dirname(paths.nodePath),
      dirname(paths.dwsPath),
      isAbsolute(String(config.codexPath ?? ""))
        ? dirname(config.codexPath)
        : null,
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].filter((value, index, values) => values.indexOf(value) === index).join(":"),
    HERMES_HOME: paths.hermesHome,
    PYTHONPATH: [paths.patchedSource, join(paths.hermesHome, "plugins")].join(":"),
    HERMES_ACCEPT_HOOKS: "1",
    FOURSDAY_HERMES_MODE: mode,
    FOURSDAY_NODE_PATH: paths.nodePath,
    FOURSDAY_HERMES_PYTHON: paths.pythonPath,
    FOURSDAY_DWS_HOME: dwsHome,
    FOURSDAY_MEMORY_HOME: dwsHome,
    FOURSDAY_DWS_SIDECAR: paths.dwsSidecar,
    FOURSDAY_MEMORY_CONTEXT_SIDECAR: paths.memorySidecar,
    FOURSDAY_PRODUCTION_CONFIG: paths.productionConfig,
    FOURSDAY_PROJECT_REGISTRY: paths.projectRegistry,
    FOURSDAY_FALLBACK_WORKSPACE: paths.fallbackWorkspace,
    FOURSDAY_ROUTE_STATE_FILE: join(stateDirectory, "routes.production.json"),
    FOURSDAY_SHADOW_EVIDENCE_FILE: join(stateDirectory, "shadow-evidence.jsonl"),
    DWS_PATH: paths.dwsPath,
    DINGTALK_DATA_ROOT: String(config.dingtalkRoot ?? ""),
    DINGTALK_SELF_USER_ID: String(config.selfUserId ?? ""),
    DWS_PERSONAL_ALLOWED_USERS: csv(config.targetUserIds),
    DWS_PERSONAL_FETCH_USERS: csv(config.targetUserIds),
    DWS_PERSONAL_ALLOWED_GROUPS: csv(config.targetGroupIds),
    DWS_PERSONAL_STATE_FILE: join(stateDirectory, "dws.production.json"),
    DWS_PERSONAL_INITIAL_LOOKBACK_MS: bounded(
      config.initialLookbackMs,
      10 * 60 * 1_000,
      10_000,
      24 * 60 * 60 * 1_000,
      "Hermes DWS initial lookback",
    ),
    DWS_PERSONAL_FALLBACK_MS: bounded(
      fallbackMs,
      30_000,
      5_000,
      5 * 60 * 1_000,
      "Hermes DWS fallback",
    ),
    DWS_PERSONAL_BUNDLE_QUIET_MS: bounded(
      config.quietWindowMs,
      3_000,
      0,
      8_000,
      "Hermes DWS quiet window",
    ),
    DWS_PERSONAL_BUNDLE_MAX_WAIT_MS: bounded(
      config.bundleMaxWaitMs,
      8_000,
      1,
      8_000,
      "Hermes DWS maximum wait",
    ),
    DWS_PERSONAL_SEND_ENABLED: boundary.sendEnabled ? "true" : "false",
    NO_COLOR: "1",
  };
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderHermesGatewayLaunchAgent({
  paths,
  environment,
  stdoutPath,
  stderrPath,
}) {
  const environmentRows = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${hermesGatewayLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(paths.nodePath)}</string>
    <string>${xml(paths.gatewayLauncher)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(paths.patchedSource)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentRows}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderrPath)}</string>
</dict>
</plist>
`;
}

export function hermesGatewayPlan({ mode, paths, environment }) {
  const boundary = assertHermesWriterBoundary({ mode });
  return {
    schema: "foursday-hermes-gateway-plan/v1",
    mode,
    label: hermesGatewayLabel,
    sendEnabled: boundary.sendEnabled,
    runtimeRoot: paths.runtimeRoot,
    hermesHome: paths.hermesHome,
    patchedSource: paths.patchedSource,
    projectRegistry: paths.projectRegistry,
    stateFile: environment.DWS_PERSONAL_STATE_FILE,
    routeStateFile: environment.FOURSDAY_ROUTE_STATE_FILE,
    productionWrite: false,
  };
}
