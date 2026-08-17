import { configureAdminLogin } from "../src/admin-login-config.mjs";
import { isMainModule } from "../src/main-module.mjs";
import { readStdin } from "../src/stdin.mjs";

export { configureAdminLogin } from "../src/admin-login-config.mjs";

export const adminLoginUsage =
  "Usage: 设置管理台登录.mjs --identifier <username-or-email> [--identifier <alias>] [--session-hours 8] [--apply]";

function argumentValues(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    if (!argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    values.push(argv[index + 1]);
    index += 1;
  }
  return values;
}

function argumentValue(argv, name) {
  const values = argumentValues(argv, name);
  if (values.length > 1) throw new Error(`${name} may be provided only once`);
  return values[0];
}

async function hiddenPassword({ input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const value = (await readStdin()).replace(/[\r\n]+$/u, "");
    if (!value) throw new Error("Admin password is required on stdin");
    return value;
  }
  output.write("管理台密码（输入不会回显）：");
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  return new Promise((accept, reject) => {
    let value = "";
    const finish = (error = null) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else accept(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new Error("Password input cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (!/[\p{Cc}]/u.test(character)) {
          value += character;
        }
      }
    };
    input.on("data", onData);
  });
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(adminLoginUsage);
  } else {
    const identifiers = argumentValues(argv, "--identifier");
    if (identifiers.length === 0) throw new Error(adminLoginUsage);
    const sessionHours = Number(argumentValue(argv, "--session-hours") ?? 8);
    if (!Number.isFinite(sessionHours)) throw new Error("--session-hours must be a number");
    const result = await configureAdminLogin({
      configPath: process.env.AI_EMPLOYEE_CONFIG_FILE,
      identifiers,
      password: await hiddenPassword(),
      sessionTtlMs: Math.round(sessionHours * 3_600_000),
      apply: argv.includes("--apply"),
    });
    console.log(JSON.stringify(result, null, 2));
  }
}
