import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

async function privateFile(path, label) {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 || await realpath(absolute) !== absolute
  ) throw new Error(`${label} must be a private regular file`);
  return absolute;
}

function runInteractive(command, args, options) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) accept();
      else reject(new Error(signal ? `Codex login stopped by ${signal}` : "Codex login failed"));
    });
  });
}

export async function runFoursdayCodexLogin({
  layout,
  configPath,
  apply = false,
  run = runInteractive,
} = {}) {
  const source = await privateFile(configPath, "Foursday config");
  const values = JSON.parse(await readFile(source, "utf8"));
  const codexPath = String(values.FOURSDAY_CODEX_PATH ?? "").trim();
  if (!isAbsolute(codexPath)) throw new Error("FOURSDAY_CODEX_PATH must be absolute before login");
  const configuredCodex = resolve(codexPath);
  const codex = await realpath(codexPath);
  const codexHome = join(layout.profileDirectory, "local", "foursday", "codex");
  await privateFile(join(codexHome, "config.toml"), "Foursday Codex config");
  const plan = {
    schema: "foursday-codex-login/v1",
    apply,
    codexHome,
    isolatedFromUserCodex: true,
    credentialsCopied: false,
    credentialWrite: false,
    productionWrite: false,
  };
  if (!apply) return plan;
  const runOptions = {
    cwd: codexHome,
    env: {
      HOME: layout.userHome,
      CODEX_HOME: codexHome,
      PATH: [...new Set([
        dirname(configuredCodex), dirname(codex),
        "/usr/bin", "/bin", "/usr/sbin", "/sbin",
      ])].join(":"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
  };
  await run(codex, ["login"], runOptions);
  await run(codex, ["login", "status"], runOptions);
  return {
    ...plan,
    authenticated: true,
    verified: true,
    credentialWrite: true,
    productionWrite: false,
  };
}
