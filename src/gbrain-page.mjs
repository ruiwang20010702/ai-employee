import { execFile } from "node:child_process";
import {
  access,
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { safeCommandEnvironment } from "./controlled-command-runner.mjs";

const execFileAsync = promisify(execFile);

export async function resolveGbrainPath(gbrainPath, lookup = execFileAsync) {
  if (typeof gbrainPath !== "string" || !gbrainPath.trim()) {
    throw new Error("gbrain executable is required");
  }
  if (gbrainPath.includes("/")) {
    await access(gbrainPath, constants.X_OK);
    return gbrainPath;
  }
  const { stdout } = await lookup("/usr/bin/which", [gbrainPath], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  const resolved = String(stdout).trim();
  if (!resolved.startsWith("/") || resolved.includes("\n")) {
    throw new Error("gbrain executable could not be resolved safely");
  }
  await access(resolved, constants.X_OK);
  return resolved;
}

export async function readGbrainPage(
  gbrainPath,
  slug,
  {
    timeoutMs = 30_000,
    maxBuffer = 8 * 1024 * 1024,
    signal,
    sourceId = null,
    run = execFileAsync,
  } = {},
) {
  try {
    const executable = run === execFileAsync
      ? await resolveGbrainPath(gbrainPath)
      : gbrainPath;
    const { stdout } = await run(
      executable,
      ["call", "get_page", JSON.stringify({ slug })],
      {
        timeout: timeoutMs,
        maxBuffer,
        signal,
        env: {
          ...safeCommandEnvironment(executable),
          ...(sourceId ? { GBRAIN_SOURCE: sourceId } : {}),
        },
      },
    );
    const page = JSON.parse(stdout);
    if (
      !page ||
      Array.isArray(page) ||
      typeof page !== "object" ||
      page.slug !== slug ||
      page.deleted_at != null
    ) {
      throw new Error("gbrain returned an unexpected page identity");
    }
    if (typeof page.compiled_truth !== "string" || !page.compiled_truth.trim()) {
      throw new Error("gbrain page did not contain compiled knowledge");
    }
    return {
      slug: page.slug,
      title: typeof page.title === "string" ? page.title : "",
      type: typeof page.type === "string" ? page.type : "",
      tags: Array.isArray(page.tags)
        ? page.tags.filter((tag) => typeof tag === "string").slice(0, 30)
        : [],
      content: page.compiled_truth,
      updatedAt: page.updated_at ?? null,
    };
  } catch (error) {
    if (signal?.aborted) {
      const interrupted = new Error("gbrain read interrupted by operator");
      interrupted.code = "WORK_PLAN_CANCELLED";
      throw interrupted;
    }
    throw error;
  }
}

export async function writeGbrainPage(
  gbrainPath,
  { slug, content },
  {
    timeoutMs = 30_000,
    maxBuffer = 8 * 1024 * 1024,
    signal,
    run = execFileAsync,
  } = {},
) {
  if (typeof slug !== "string" || !slug.trim()) {
    throw new Error("gbrain write requires an exact slug");
  }
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("gbrain write requires non-empty markdown");
  }
  try {
    const executable = run === execFileAsync
      ? await resolveGbrainPath(gbrainPath)
      : gbrainPath;
    const { stdout } = await run(
      executable,
      ["call", "put_page", JSON.stringify({ slug, content })],
      {
        timeout: timeoutMs,
        maxBuffer,
        signal,
        env: safeCommandEnvironment(executable),
      },
    );
    const result = JSON.parse(stdout);
    if (
      !result ||
      Array.isArray(result) ||
      typeof result !== "object" ||
      (result.slug != null && result.slug !== slug)
    ) {
      throw new Error("gbrain returned an unexpected write receipt");
    }
    return { slug, written: true };
  } catch (error) {
    if (signal?.aborted) {
      const interrupted = new Error("gbrain write interrupted by operator");
      interrupted.code = "WORK_PLAN_CANCELLED";
      throw interrupted;
    }
    throw error;
  }
}

export async function writeGbrainMarkdownAuthority(
  gbrainPath,
  { slug, content },
  {
    root,
    sourceId = "foursday",
    timeoutMs = 120_000,
    run = execFileAsync,
  } = {},
) {
  if (!isAbsolute(String(root ?? ""))) {
    throw new Error("Memory authority Markdown root must be absolute");
  }
  if (!/^atoms\/foursday\/[a-z0-9/_-]+$/u.test(String(slug ?? ""))) {
    throw new Error("Memory authority slug is outside the managed namespace");
  }
  if (!/^[a-z0-9-]{1,32}$/u.test(String(sourceId ?? ""))) {
    throw new Error("Memory authority source id is invalid");
  }
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Memory authority Markdown root must be a real directory");
  }
  const canonicalRoot = await realpath(root);
  const destination = resolve(canonicalRoot, `${slug}.md`);
  const difference = relative(canonicalRoot, destination);
  if (!difference || difference.startsWith("..") || isAbsolute(difference)) {
    throw new Error("Memory authority page escapes the Markdown root");
  }
  let current = canonicalRoot;
  for (const part of dirname(difference).split("/")) {
    current = resolve(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Memory authority path contains an unsafe directory");
    }
  }
  const existing = await lstat(destination).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("Memory authority destination is not a regular file");
    }
    if (await readFile(destination, "utf8") !== content) {
      throw new Error("Memory authority page changed outside Foursday");
    }
  } else {
    const temporary = `${destination}.tmp-${process.pid}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, destination);
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  const executable = run === execFileAsync
    ? await resolveGbrainPath(gbrainPath)
    : gbrainPath;
  await run(executable, ["sync", "--source", sourceId], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: safeCommandEnvironment(executable),
  });
  return { slug, written: !existing, markdownPathVerified: true };
}
