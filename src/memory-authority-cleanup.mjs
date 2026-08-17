import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { retireGbrainMarkdownAuthority } from "./gbrain-page.mjs";
import { safeErrorCode } from "./logging.mjs";

export async function reconcileMemoryAuthorityCleanup({
  store,
  gbrainPath = "gbrain",
  authorityRoot,
  authoritySourceId = "foursday",
  limit = 100,
  owner = `${hostname()}:${process.pid}:${randomUUID()}`,
  retirePage = retireGbrainMarkdownAuthority,
  now = () => new Date(),
} = {}) {
  if (!store?.claimMemoryAuthorityCleanup) {
    throw new Error("Memory authority cleanup requires PostgreSQL cleanup storage");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Memory authority cleanup limit must be 1-500");
  }
  const report = { claimed: 0, completed: 0, failed: 0, failures: [] };
  for (let index = 0; index < limit; index += 1) {
    const claimed = await store.claimMemoryAuthorityCleanup(owner, now());
    if (!claimed) break;
    report.claimed += 1;
    try {
      if (claimed.authoritySourceId !== authoritySourceId) {
        throw new Error("Memory authority cleanup source does not match production");
      }
      await retirePage(gbrainPath, {
        slug: claimed.slug,
        contentSha256: claimed.contentSha256,
        cleanupId: claimed.id,
      }, {
        root: authorityRoot,
        sourceId: claimed.authoritySourceId,
      });
      await store.completeMemoryAuthorityCleanup(claimed.id, owner, now());
      report.completed += 1;
    } catch (error) {
      const errorCode = safeErrorCode(error);
      await store.failMemoryAuthorityCleanup(
        claimed.id,
        owner,
        errorCode,
        now(),
      );
      report.failed += 1;
      report.failures.push({ cleanupId: claimed.id, errorCode });
    }
  }
  return report;
}
