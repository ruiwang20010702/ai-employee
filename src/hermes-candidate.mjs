import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  hermesRuntimeLayout,
  validateHermesUpstreamLock,
} from "./hermes-upstream.mjs";

function executable(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute executable path`);
  }
  return value;
}

export function buildHermesCandidatePlan({
  projectRoot,
  lock,
  uvPath,
  pythonPath,
}) {
  const normalizedLock = validateHermesUpstreamLock(lock);
  const layout = hermesRuntimeLayout(projectRoot);
  const uv = executable(uvPath, "uvPath");
  const python = executable(pythonPath, "pythonPath");
  const environment = {
    HOME: layout.state,
    UV_CACHE_DIR: join(layout.root, "uv-cache"),
    UV_PROJECT_ENVIRONMENT: layout.venv,
    PATH: [dirname(uv), dirname(python), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    CI: "1",
    NO_COLOR: "1",
  };
  return {
    lock: normalizedLock,
    layout,
    environment,
    commands: [
      { executable: "/usr/bin/git", args: ["init", layout.source] },
      {
        executable: "/usr/bin/git",
        args: ["-C", layout.source, "remote", "add", "origin", normalizedLock.repository],
      },
      {
        executable: "/usr/bin/git",
        args: ["-C", layout.source, "fetch", "--depth", "1", "origin", normalizedLock.commit],
      },
      {
        executable: "/usr/bin/git",
        args: ["-C", layout.source, "sparse-checkout", "init", "--no-cone"],
      },
      {
        executable: "/usr/bin/git",
        args: [
          "-C",
          layout.source,
          "sparse-checkout",
          "set",
          "/*",
          "!/contributors/emails/",
        ],
      },
      {
        executable: "/usr/bin/git",
        args: ["-C", layout.source, "checkout", "--detach", "FETCH_HEAD"],
      },
      {
        executable: uv,
        args: ["venv", layout.venv, "--python", python],
      },
      {
        executable: uv,
        args: [
          "sync",
          "--frozen",
          "--no-dev",
          "--project",
          layout.source,
          "--python",
          python,
        ],
      },
    ],
  };
}

async function existingPathIsSymlink(path) {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function assertHermesRuntimeRoot(projectRoot, candidateRoot) {
  const projectRuntime = resolve(projectRoot, ".runtime");
  const candidate = resolve(candidateRoot);
  const difference = relative(projectRuntime, candidate);
  if (
    candidate === projectRuntime ||
    difference.startsWith("..") ||
    isAbsolute(difference)
  ) {
    throw new Error("Hermes runtime root must stay inside the project runtime");
  }
  const project = resolve(projectRoot);
  const relativeCandidate = relative(project, candidate);
  let current = project;
  for (const part of relativeCandidate.split("/").filter(Boolean)) {
    current = join(current, part);
    if (await existingPathIsSymlink(current)) {
      throw new Error("Hermes runtime root must not contain symbolic links");
    }
  }
  return candidate;
}
