import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { safeCommandEnvironment } from "./controlled-command-runner.mjs";

const execFileAsync = promisify(execFile);

export async function readGbrainPage(
  gbrainPath,
  slug,
  {
    timeoutMs = 30_000,
    maxBuffer = 8 * 1024 * 1024,
    signal,
    run = execFileAsync,
  } = {},
) {
  try {
    const { stdout } = await run(
      gbrainPath,
      ["call", "get_page", JSON.stringify({ slug })],
      {
        timeout: timeoutMs,
        maxBuffer,
        signal,
        env: safeCommandEnvironment(gbrainPath),
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
