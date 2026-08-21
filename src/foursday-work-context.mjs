import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

export const foursdayContextTokenPattern = /^fctx_[a-f0-9]{64}$/u;

export async function loadFoursdayWorkContext({ path, token, cwd, now = Date.now() } = {}) {
  if (!foursdayContextTokenPattern.test(String(token ?? ""))) {
    throw new Error("work_context_invalid");
  }
  const absolute = resolve(path);
  if (await realpath(absolute) !== absolute) throw new Error("work_context_unavailable");
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let content;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 1024 * 1024) {
      throw new Error("work_context_unavailable");
    }
    content = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const document = JSON.parse(content);
  const context = document?.schemaVersion === 1 ? document.contexts?.[token] : null;
  if (
    !context ||
    typeof context.projectId !== "string" ||
    typeof context.workspace !== "string" ||
    typeof context.projectContext !== "string" || context.projectContext.length > 8_000 ||
    typeof context.memoryContext !== "string" || context.memoryContext.length > 16_000 ||
    !/^[a-f0-9]{64}$/u.test(String(context.sourcePrincipalHandle ?? "")) ||
    !/^[a-f0-9]{64}$/u.test(String(context.sourceSessionHash ?? "")) ||
    !Number.isSafeInteger(context.expiresAt) ||
    context.expiresAt * 1000 <= now
  ) throw new Error("work_context_expired");
  const [workspace, current] = await Promise.all([
    realpath(context.workspace),
    realpath(cwd),
  ]);
  if (workspace !== current) throw new Error("work_context_workspace_mismatch");
  return { ...context, workspace };
}
