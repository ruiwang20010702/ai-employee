import assert from "node:assert/strict";
import test from "node:test";
import {
  checkMemorySourceAccess,
  reconcileMemorySources,
  validateSourceAccessChange,
} from "../src/memory-source-access.mjs";
import { memoryIsUsable, validateMemoryProposal } from "../src/memory-policy.mjs";
import { createHash } from "node:crypto";

const now = new Date("2026-08-05T08:00:00.000Z");
const memory = {
  id: "memory_1",
  type: "knowledge",
  project_id: "project_1",
  source_type: "gbrain",
  source_id: "projects/one/rule",
  source_version: "2026-08-05T07:00:00.000Z",
  status: "confirmed",
  deleted_at: null,
  expires_at: null,
};

function projects(mode = "automatic") {
  return new Map([["project_1", {
    capabilities: {
      knowledge_read: {
        mode,
        expiresAt: null,
        allowedSlugPrefixes: ["projects/one/"],
        timeoutMs: 30_000,
        maxContentBytes: 100_000,
      },
    },
  }]]);
}

test("gbrain 记忆必须绑定项目且只能是项目或知识类型", () => {
  assert.throws(() => validateMemoryProposal({
    type: "principle",
    subject: "规则",
    statement: "内容",
    sourceType: "gbrain",
    sourceId: "projects/one/rule",
    createdBy: "owner",
  }), /require a project/u);
  assert.doesNotThrow(() => validateMemoryProposal({
    type: "principle",
    subject: "规则",
    statement: "先核对来源再使用。",
    sourceType: "gbrain",
    sourceId: "atoms/foursday/principles/core/fact",
    sourceVersion: "v1",
    scope: {
      factKey: "principle.source_readback",
      authority: {
        schema: "foursday-memory-authority/v1",
        managed: true,
        sourceId: "foursday",
      },
    },
    createdBy: "system:memory-authority",
  }));
});

test("受管理的 Markdown 权威记忆不依赖项目知识授权但必须逐字回读", async () => {
  const content = [
    "# Foursday memory",
    "<!-- foursday-memory-statement:start -->",
    "先核对来源再使用。",
    "<!-- foursday-memory-statement:end -->",
  ].join("\n");
  const authority = {
    id: "authority-1",
    type: "principle",
    project_id: null,
    statement: "先核对来源再使用。",
    source_type: "gbrain",
    source_id: "atoms/foursday/principles/core/fact",
    source_version: "2026-08-17T08:00:00.000Z",
    scope: {
      factKey: "principle.source_readback",
      authority: {
        schema: "foursday-memory-authority/v1",
        managed: true,
        sourceId: "foursday",
        contentSha256: createHash("sha256").update(content).digest("hex"),
      },
    },
  };
  const verified = await checkMemorySourceAccess(authority, {
    projects: new Map(),
    now,
    readPage: async (_path, _slug, options) => {
      assert.equal(options.sourceId, "foursday");
      return ({
      slug: authority.source_id,
      updatedAt: authority.source_version,
      content,
      });
    },
  });
  assert.equal(verified.status, "verified");
  const changed = await checkMemorySourceAccess(authority, {
    projects: new Map(),
    now,
    readPage: async () => ({
      slug: authority.source_id,
      updatedAt: authority.source_version,
      content: content.replace("先核对来源再使用。", "未经同步的修改。"),
    }),
  });
  assert.equal(changed.reason, "authority_statement_changed");
});

test("来源访问租约只在精确页面、项目授权和版本一致时签发", async () => {
  const verified = await checkMemorySourceAccess(memory, {
    projects: projects(),
    now,
    leaseMs: 900_000,
    readPage: async () => ({
      slug: memory.source_id,
      updatedAt: memory.source_version,
      content: "内容",
    }),
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.sourceVersion, memory.source_version);
  assert.equal(verified.expiresAt.toISOString(), "2026-08-05T08:15:00.000Z");
  assert.equal(memoryIsUsable({
    ...memory,
    source_access_status: verified.status,
    source_access_expires_at: verified.expiresAt,
  }, new Date("2026-08-05T08:14:59.000Z")), true);
  assert.equal(memoryIsUsable({
    ...memory,
    source_access_status: verified.status,
    source_access_expires_at: verified.expiresAt,
  }, verified.expiresAt), false);

  const expiringProjects = projects();
  expiringProjects.get("project_1").capabilities.knowledge_read.expiresAt =
    "2026-08-05T08:05:00.000Z";
  const capped = await checkMemorySourceAccess(memory, {
    projects: expiringProjects,
    now,
    leaseMs: 900_000,
    readPage: async () => ({
      updatedAt: memory.source_version,
      content: "内容",
    }),
  });
  assert.equal(capped.expiresAt.toISOString(), "2026-08-05T08:05:00.000Z");

  const sameInstant = await checkMemorySourceAccess({
    ...memory,
    source_version: "2026-08-05T15:00:00+08:00",
  }, {
    projects: projects(),
    now,
    readPage: async () => ({
      updatedAt: "2026-08-05T07:00:00.000Z",
      content: "内容",
    }),
  });
  assert.equal(sameInstant.status, "verified");

  const changed = await checkMemorySourceAccess(memory, {
    projects: projects(),
    now,
    readPage: async () => ({ updatedAt: "new-version", content: "新内容" }),
  });
  assert.deepEqual(
    { status: changed.status, reason: changed.reason },
    { status: "unavailable", reason: "source_version_changed" },
  );

  const hashed = await checkMemorySourceAccess({ ...memory, source_version: null }, {
    projects: projects(),
    now,
    readPage: async () => ({ updatedAt: null, content: "稳定正文" }),
  });
  assert.match(hashed.sourceVersion, /^sha256:[a-f0-9]{64}$/u);
});

test("权限移除会撤销访问，临时读取失败只暂停使用", async () => {
  const revoked = await checkMemorySourceAccess(memory, {
    projects: projects("disabled"),
    now,
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.reason, "knowledge_read_disabled");

  const unavailable = await checkMemorySourceAccess(memory, {
    projects: projects(),
    now,
    readPage: async () => { throw new Error("temporary failure"); },
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.expiresAt, null);

  const oversized = await checkMemorySourceAccess(memory, {
    projects: projects(),
    now,
    readPage: async () => ({
      updatedAt: memory.source_version,
      content: "x".repeat(100_001),
    }),
  });
  assert.equal(oversized.reason, "source_content_exceeded");
});

test("批量复核有上限且只保存稳定状态，不暴露正文", async () => {
  const changes = [];
  const store = {
    async listMemories() { return [memory]; },
    async setMemorySourceAccess(id, change, actor) {
      changes.push({ id, change, actor });
    },
  };
  const report = await reconcileMemorySources({
    store,
    projects: projects(),
    now,
    readPage: async () => ({
      updatedAt: memory.source_version,
      content: "不得进入报告的正文",
    }),
  });
  assert.deepEqual(report, {
    checkedAt: now.toISOString(),
    checked: 1,
    verified: 1,
    unavailable: 0,
    revoked: 0,
  });
  assert.equal(changes[0].actor, "system:memory-source");
  assert.doesNotMatch(JSON.stringify(report), /不得进入报告/u);

  await assert.rejects(reconcileMemorySources({
    store: { ...store, async listMemories() { return [memory, memory]; } },
    projects: projects(),
    now,
    limit: 1,
  }), /limit reached/u);
  assert.throws(() => validateSourceAccessChange({
    status: "verified",
    reason: "ok",
    checkedAt: now,
    expiresAt: now,
  }), /future expiry/u);
});
