import { dirname } from "node:path";

const allowedNames = [
  "HOME",
  "CODEX_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
];

export function safeCodexEnvironment(executable, source = process.env) {
  const environment = Object.fromEntries(
    allowedNames
      .filter((name) => typeof source[name] === "string")
      .map((name) => [name, source[name]]),
  );
  return {
    ...environment,
    PATH: [
      executable.includes("/") ? dirname(executable) : null,
      source.HOME ? `${source.HOME}/.local/bin` : null,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].filter(Boolean).join(":"),
    CI: "1",
    NO_COLOR: "1",
  };
}
