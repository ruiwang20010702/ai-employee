import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../src/main-module.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

async function moduleFiles(directory) {
  const output = [];
  const visit = async (path) => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) output.push(target);
    }
  };
  await visit(directory);
  return output.sort();
}

function run(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) accept();
      else reject(new Error(
        signal ? `代码检查被 ${signal} 中断` : `代码检查失败，退出码 ${code}`,
      ));
    });
  });
}

export async function discoverCodeCheck({ root = projectRoot } = {}) {
  const [sourceFiles, scriptFiles, pluginFiles, testFiles] = await Promise.all([
    moduleFiles(join(root, "src")),
    moduleFiles(join(root, "scripts")),
    moduleFiles(join(root, "plugins")),
    moduleFiles(join(root, "test")),
  ]);
  return { sourceFiles, scriptFiles, pluginFiles, testFiles };
}

export async function runCodeCheck({ root = projectRoot, runner = run } = {}) {
  const files = await discoverCodeCheck({ root });
  const productionModules = [
    ...files.sourceFiles,
    ...files.scriptFiles,
    ...files.pluginFiles,
  ];
  if (productionModules.length === 0) throw new Error("没有找到可检查的生产模块");
  for (const path of productionModules) {
    await runner(process.execPath, ["--check", path], { cwd: root });
  }
  if (files.testFiles.length > 0) {
    await runner(process.execPath, [
      "--test",
      "--test-concurrency=4",
      ...files.testFiles,
    ], { cwd: root });
  }
  return {
    valid: true,
    sourceModules: files.sourceFiles.length,
    scriptModules: files.scriptFiles.length,
    pluginModules: files.pluginFiles.length,
    tests: files.testFiles.length,
    mode: files.testFiles.length > 0 ? "source_with_tests" : "installed_package",
  };
}

if (isMainModule(import.meta.url)) {
  console.log(JSON.stringify(await runCodeCheck(), null, 2));
}
