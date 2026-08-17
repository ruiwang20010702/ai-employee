import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const postgresIdentityOverrideParameters = new Set([
  "host",
  "hostaddr",
  "port",
  "database",
  "dbname",
  "user",
  "password",
]);

export function gbrainCommandEnvironment(
  executable,
  { sourceId = null, gbrainHome = null, gbrainDatabaseUrl = null } = {},
) {
  if (sourceId != null && !/^[a-z0-9-]{1,32}$/u.test(String(sourceId))) {
    throw new Error("gbrain source id is invalid");
  }
  if (gbrainHome != null && !isAbsolute(String(gbrainHome))) {
    throw new Error("GBRAIN_HOME must be absolute");
  }
  if (gbrainDatabaseUrl != null) {
    let url;
    try {
      url = new URL(String(gbrainDatabaseUrl));
    } catch {
      throw new Error("Foursday gbrain database URL is invalid");
    }
    if (!/^postgres(?:ql)?:$/u.test(url.protocol) || !url.username || !url.password) {
      throw new Error("Foursday gbrain database URL must be an authenticated PostgreSQL URL");
    }
    if ([...url.searchParams.keys()].some((key) =>
      postgresIdentityOverrideParameters.has(key.toLowerCase()))) {
      throw new Error("Foursday gbrain database URL must not override database identity in query parameters");
    }
  }
  return {
    ...safeCommandEnvironment(executable),
    GBRAIN_SKIP_STARTUP_HOOKS: "1",
    ...(sourceId ? { GBRAIN_SOURCE: String(sourceId) } : {}),
    ...(gbrainHome ? { GBRAIN_HOME: String(gbrainHome) } : {}),
    ...(gbrainDatabaseUrl
      ? { GBRAIN_DATABASE_URL: String(gbrainDatabaseUrl) }
      : {}),
  };
}

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
    gbrainHome = null,
    gbrainDatabaseUrl = null,
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
        env: gbrainCommandEnvironment(executable, {
          sourceId,
          gbrainHome,
          gbrainDatabaseUrl,
        }),
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
    sourceId = null,
    gbrainHome = null,
    gbrainDatabaseUrl = null,
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
        env: gbrainCommandEnvironment(executable, {
          sourceId,
          gbrainHome,
          gbrainDatabaseUrl,
        }),
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
    gitRun = execFileAsync,
    gbrainHome = null,
    gbrainDatabaseUrl = null,
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
  await commitAuthorityPath(
    canonicalRoot,
    difference,
    `memory: write ${createHash("sha256").update(content).digest("hex").slice(0, 12)}`,
    { gitRun },
  );
  await run(executable, ["sync", "--source", sourceId], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: gbrainCommandEnvironment(executable, {
      sourceId,
      gbrainHome,
      gbrainDatabaseUrl,
    }),
  });
  return { slug, written: !existing, markdownPathVerified: true };
}

export async function writeGbrainMarkdownAuthorityBatch(
  gbrainPath,
  documents,
  {
    root,
    sourceId = "foursday",
    timeoutMs = 120_000,
    run = execFileAsync,
    gitRun = execFileAsync,
    gbrainHome = null,
    gbrainDatabaseUrl = null,
  } = {},
) {
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > 500) {
    throw new Error("Memory authority batch must contain 1-500 pages");
  }
  const seen = new Set();
  let written = 0;
  const deferredSync = async (_path, args) => {
    if (args[0] !== "sync") {
      throw new Error("Memory authority batch attempted an unexpected command");
    }
    return { stdout: "", stderr: "" };
  };
  for (const document of documents) {
    if (seen.has(document.slug)) {
      throw new Error("Memory authority batch contains a duplicate slug");
    }
    seen.add(document.slug);
    const result = await writeGbrainMarkdownAuthority(gbrainPath, document, {
      root,
      sourceId,
      timeoutMs,
      run: deferredSync,
      gitRun,
      gbrainHome,
      gbrainDatabaseUrl,
    });
    if (result.written) written += 1;
  }
  const executable = run === execFileAsync
    ? await resolveGbrainPath(gbrainPath)
    : gbrainPath;
  await run(executable, ["sync", "--source", sourceId], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: gbrainCommandEnvironment(executable, {
      sourceId,
      gbrainHome,
      gbrainDatabaseUrl,
    }),
  });
  return {
    pages: documents.length,
    written,
    synchronized: true,
  };
}

function managedAuthorityDestination(root, slug) {
  if (!isAbsolute(String(root ?? ""))) {
    throw new Error("Memory authority Markdown root must be absolute");
  }
  if (!/^atoms\/foursday\/[a-z0-9/_-]+$/u.test(String(slug ?? ""))) {
    throw new Error("Memory authority slug is outside the managed namespace");
  }
  return resolve(root, `${slug}.md`);
}

async function assertRealDirectory(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpath(path);
}

async function commitAuthorityPath(
  canonicalRoot,
  relativePath,
  subject,
  { gitRun = execFileAsync } = {},
) {
  const options = {
    cwd: canonicalRoot,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: safeCommandEnvironment("/usr/bin/git"),
  };
  const repository = await gitRun(
    "/usr/bin/git",
    ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
    options,
  );
  if (await realpath(String(repository.stdout).trim()) !== canonicalRoot) {
    throw new Error("Memory authority root is not the Git repository root");
  }
  await gitRun(
    "/usr/bin/git",
    ["-c", "core.fsmonitor=false", "add", "--", relativePath],
    options,
  );
  const staged = await gitRun(
    "/usr/bin/git",
    ["-c", "core.fsmonitor=false", "diff", "--cached", "--name-only", "--", relativePath],
    options,
  );
  const paths = String(staged.stdout).trim().split("\n").filter(Boolean);
  if (paths.length === 0) return false;
  if (paths.length !== 1 || paths[0] !== relativePath) {
    throw new Error("Memory authority Git staging escaped the managed page");
  }
  await gitRun(
    "/usr/bin/git",
    [
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null",
      "-c", "user.name=Foursday",
      "-c", "user.email=foursday@localhost",
      "commit", "--no-gpg-sign", "-m", subject, "--", relativePath,
    ],
    options,
  );
  const remaining = await gitRun(
    "/usr/bin/git",
    ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--", relativePath],
    options,
  );
  if (String(remaining.stdout).trim()) {
    throw new Error("Memory authority Git path remained dirty after commit");
  }
  return true;
}

export async function retireGbrainMarkdownAuthority(
  gbrainPath,
  { slug, contentSha256, cleanupId },
  {
    root,
    sourceId = "foursday",
    timeoutMs = 120_000,
    run = execFileAsync,
    gitRun = execFileAsync,
    gbrainHome = null,
    gbrainDatabaseUrl = null,
  } = {},
) {
  if (!/^[a-z0-9-]{1,32}$/u.test(String(sourceId ?? ""))) {
    throw new Error("Memory authority source id is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(String(contentSha256 ?? ""))) {
    throw new Error("Memory authority cleanup digest is invalid");
  }
  if (!/^[a-z0-9_-]{8,100}$/u.test(String(cleanupId ?? ""))) {
    throw new Error("Memory authority cleanup id is invalid");
  }
  const canonicalRoot = await assertRealDirectory(root, "Memory authority Markdown root");
  const destination = managedAuthorityDestination(canonicalRoot, slug);
  const difference = relative(canonicalRoot, destination);
  if (!difference || difference.startsWith("..") || isAbsolute(difference)) {
    throw new Error("Memory authority cleanup escapes the Markdown root");
  }
  let current = canonicalRoot;
  for (const part of dirname(difference).split("/")) {
    current = resolve(current, part);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Memory authority cleanup path contains an unsafe directory");
    }
  }
  const authorityParent = await assertRealDirectory(
    dirname(canonicalRoot),
    "Memory authority parent directory",
  );
  const trashRoot = resolve(authorityParent, ".foursday-memory-trash");
  await mkdir(trashRoot, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (await assertRealDirectory(trashRoot, "Memory authority trash directory") !== trashRoot) {
    throw new Error("Memory authority trash directory changed identity");
  }
  const quarantine = resolve(trashRoot, `${cleanupId}.md`);
  const destinationMetadata = await lstat(destination).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const quarantineMetadata = await lstat(quarantine).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (destinationMetadata && quarantineMetadata) {
    throw new Error("Memory authority cleanup has both active and quarantined files");
  }
  if (destinationMetadata) {
    if (!destinationMetadata.isFile() || destinationMetadata.isSymbolicLink()) {
      throw new Error("Memory authority cleanup target is not a regular file");
    }
    const content = await readFile(destination, "utf8");
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== contentSha256) {
      throw new Error("Memory authority cleanup target changed outside Foursday");
    }
    await rename(destination, quarantine);
  } else if (!quarantineMetadata) {
    throw new Error("Memory authority cleanup target and quarantine are both missing");
  } else if (!quarantineMetadata.isFile() || quarantineMetadata.isSymbolicLink()) {
    throw new Error("Memory authority quarantine is not a regular file");
  }
  const quarantinedContent = await readFile(quarantine, "utf8");
  if (createHash("sha256").update(quarantinedContent).digest("hex") !== contentSha256) {
    throw new Error("Memory authority quarantine digest changed");
  }
  const executable = run === execFileAsync
    ? await resolveGbrainPath(gbrainPath)
    : gbrainPath;
  try {
    await commitAuthorityPath(
      canonicalRoot,
      difference,
      `memory: retire ${contentSha256.slice(0, 12)}`,
      { gitRun },
    );
    await run(executable, ["sync", "--source", sourceId], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: gbrainCommandEnvironment(executable, {
        sourceId,
        gbrainHome,
        gbrainDatabaseUrl,
      }),
    });
    try {
      await run(
        executable,
        ["call", "get_page", JSON.stringify({ slug })],
        {
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024,
          env: gbrainCommandEnvironment(executable, {
            sourceId,
            gbrainHome,
            gbrainDatabaseUrl,
          }),
        },
      );
      throw new Error("Memory authority page remained readable after cleanup");
    } catch (error) {
      if (!/Page not found:/u.test(String(error?.stderr ?? ""))) throw error;
    }
    await unlink(quarantine);
    return {
      slug,
      cleanupId,
      removed: true,
      readback: "page_not_found",
    };
  } catch (error) {
    const active = await lstat(destination).catch(() => null);
    const quarantined = await lstat(quarantine).catch(() => null);
    if (!active && quarantined?.isFile() && !quarantined.isSymbolicLink()) {
      await rename(quarantine, destination);
      await commitAuthorityPath(
        canonicalRoot,
        difference,
        `memory: restore ${contentSha256.slice(0, 12)}`,
        { gitRun },
      ).catch(() => {});
      await run(executable, ["sync", "--source", sourceId], {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: gbrainCommandEnvironment(executable, {
          sourceId,
          gbrainHome,
          gbrainDatabaseUrl,
        }),
      }).catch(() => {});
    }
    throw error;
  }
}
