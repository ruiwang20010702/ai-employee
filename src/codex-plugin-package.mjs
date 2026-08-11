import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const marketplaceRelativePath = ".agents/plugins/marketplace.json";
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(path, label) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} is missing or invalid JSON`);
  }
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function validateInterface(manifest) {
  const value = manifest.interface;
  assert(value && typeof value === "object" && !Array.isArray(value), "Plugin interface is missing");
  for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
    assert(typeof value[field] === "string" && value[field].trim(), `Plugin interface.${field} is invalid`);
  }
  assert(Array.isArray(value.capabilities) && value.capabilities.includes("Read"), "Plugin must declare Read capability");
  assert(!value.capabilities.some((item) => /write|execute|send|delete/iu.test(item)), "Plugin declares a write capability");
  assert(Array.isArray(value.defaultPrompt) && value.defaultPrompt.length >= 1 && value.defaultPrompt.length <= 3, "Plugin starter prompts are invalid");
  assert(value.defaultPrompt.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128), "Plugin starter prompt is invalid");
}

export async function validateCodexPluginPackage({ root }) {
  assert(typeof root === "string" && root, "Plugin package root is required");
  const rootPath = await realpath(root);
  const marketplacePath = join(rootPath, marketplaceRelativePath);
  const marketplace = await readJson(marketplacePath, "Codex marketplace manifest");
  assert(marketplace.name === "foursday-local", "Codex marketplace identity changed");
  assert(marketplace.interface?.displayName === "Foursday（本仓库）", "Codex marketplace display name changed");
  assert(Array.isArray(marketplace.plugins), "Codex marketplace plugins must be an array");
  const matches = marketplace.plugins.filter((item) => item?.name === "foursday");
  assert(matches.length === 1, "Codex marketplace must contain exactly one Foursday compatibility entry");
  const entry = matches[0];
  assert(entry.source?.source === "local", "Codex plugin source must remain local");
  assert(entry.source.path === "./plugins/foursday", "Codex plugin source path changed");
  assert(entry.policy?.installation === "AVAILABLE", "Codex plugin must require an explicit install");
  assert(entry.policy?.authentication === "ON_INSTALL", "Codex plugin authentication policy changed");
  assert(entry.category === "Productivity", "Codex plugin category changed");

  const pluginPath = await realpath(resolve(rootPath, entry.source.path));
  assert(inside(rootPath, pluginPath), "Codex plugin source escapes the package root");
  const manifest = await readJson(join(pluginPath, ".codex-plugin", "plugin.json"), "Codex plugin manifest");
  assert(manifest.name === entry.name, "Codex plugin identity does not match its marketplace entry");
  assert(typeof manifest.version === "string" && semver.test(manifest.version), "Codex plugin version is not semantic versioning");
  assert(typeof manifest.description === "string" && manifest.description.trim(), "Codex plugin description is missing");
  assert(typeof manifest.author?.name === "string" && manifest.author.name.trim(), "Codex plugin author is missing");
  assert(manifest.skills === "./skills/", "Codex plugin skills path changed");
  assert(manifest.mcpServers === "./.mcp.json", "Codex plugin MCP mapping changed");
  validateInterface(manifest);

  const mcp = await readJson(join(pluginPath, ".mcp.json"), "Codex plugin MCP manifest");
  const server = mcp.mcpServers?.foursday;
  assert(server?.type === "stdio", "Codex plugin MCP transport must remain stdio");
  assert(server.command === "node" && server.cwd === ".", "Codex plugin MCP process configuration changed");
  assert(JSON.stringify(server.args) === JSON.stringify(["scripts/mcp-server.mjs"]), "Codex plugin MCP arguments changed");

  const skill = await readFile(join(pluginPath, "skills", "foursday", "SKILL.md"), "utf8");
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/u)?.[1];
  assert(frontmatter && /(?:^|\n)name:\s*foursday\s*(?:\n|$)/u.test(frontmatter), "Codex plugin skill metadata is invalid");
  assert(skill.includes("本插件只读") && skill.includes("不批准、拒绝、发送、执行"), "Codex plugin lost its read-only skill boundary");
  const serverScriptPath = join(pluginPath, "scripts", "mcp-server.mjs");
  const [, serverScript] = await Promise.all([
    access(serverScriptPath),
    readFile(serverScriptPath, "utf8"),
    access(join(pluginPath, "说明.md")),
  ]);
  assert(
    serverScript.includes(`export const pluginVersion = ${JSON.stringify(manifest.version)};`),
    "Codex plugin runtime version does not match its manifest",
  );

  return {
    valid: true,
    marketplace: marketplace.name,
    plugin: manifest.name,
    version: manifest.version,
    installation: entry.policy.installation,
    authentication: entry.policy.authentication,
    readOnly: true,
    checkedDistributionFiles: 6,
    personalConfigurationWrite: false,
  };
}
