import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  authorityMarkdownForMemory,
  authoritySlugForMemory,
  isManagedMemoryAuthority,
  memoryAuthoritySchema,
  parseAuthorityStatement,
  promoteMemoryToAuthority,
  synchronizeMemoryAuthority,
} from "../src/memory-authority.mjs";
import {
  writeGbrainMarkdownAuthority,
  writeGbrainMarkdownAuthorityBatch,
  writeGbrainPage,
  retireGbrainMarkdownAuthority,
} from "../src/gbrain-page.mjs";
import { reconcileMemoryAuthorityCleanup } from "../src/memory-authority-cleanup.mjs";

const now = new Date("2026-08-17T08:00:00.000Z");
const execFileAsync = promisify(execFile);

async function initializeGit(root) {
  await execFileAsync("/usr/bin/git", ["init", "--quiet", root], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
}

function memory(overrides = {}) {
  return {
    id: "memory_source_1",
    type: "project",
    subject: "foursday",
    project_id: "foursday",
    statement: "Foursday 的长期记忆正文以 Markdown 为权威。",
    source_type: "dingtalk_message",
    source_id: "private-message-id",
    source_version: "task-1",
    scope: { factKey: "decision.memory_authority" },
    confidence: 1,
    sensitivity: "internal",
    status: "proposed",
    created_at: now,
    expires_at: new Date("2027-08-17T08:00:00.000Z"),
    ...overrides,
  };
}

test("记忆权威页使用确定性 gbrain atom slug 且不暴露原始来源编号", () => {
  const first = authorityMarkdownForMemory(memory(), { generatedAt: now });
  const second = authorityMarkdownForMemory(memory(), { generatedAt: now });
  assert.equal(first.slug, second.slug);
  assert.equal(first.content, second.content);
  assert.match(first.slug, /^atoms\/foursday\/projects\/[a-f0-9]{24}\/[a-f0-9]{32}$/u);
  assert.doesNotMatch(first.content, /private-message-id/u);
  assert.equal(parseAuthorityStatement(first.content), memory().statement);
});

test("人物 slug 使用不可逆主体摘要，机密或受限材料拒绝写入", () => {
  const person = memory({
    type: "person",
    subject: "private-user-id",
    project_id: null,
    statement: "对方偏好先给结论再给证据。",
    scope: { factKey: "communication.working_style" },
  });
  assert.doesNotMatch(authoritySlugForMemory(person), /private-user-id/u);
  assert.throws(
    () => authorityMarkdownForMemory({ ...person, sensitivity: "confidential" }),
    /Confidential memory/u,
  );
  assert.throws(
    () => authorityMarkdownForMemory({ ...person, statement: "邮箱 alice@example.com" }),
    /Restricted material/u,
  );
});

test("写入必须经过 gbrain 精确回读后才创建 PostgreSQL 投影", async () => {
  const calls = [];
  const source = memory();
  const result = await promoteMemoryToAuthority(source, {
    store: {
      async upsertAuthorityMemoryProjection(input) {
        calls.push(["project", input]);
        return {
          id: "memory_authority_1",
          status: "proposed",
          created: true,
          supersedesId: null,
        };
      },
      async confirmMemory(id) {
        calls.push(["confirm", id]);
      },
    },
    gbrainPath: "/trusted/gbrain",
    autoConfirm: true,
    now,
    writePage: async (path, document) => {
      calls.push(["write", path, document]);
    },
    readPage: async (_path, slug) => {
      const document = calls.find(([kind]) => kind === "write")[2];
      return {
        slug,
        content: document.content,
        updatedAt: "2026-08-17T08:00:01.000Z",
      };
    },
  });
  assert.deepEqual(calls.map(([kind]) => kind), ["write", "project", "confirm"]);
  assert.equal(result.created, true);
  assert.equal(result.confirmed, true);
});

test("回读正文不一致时不允许建立运行投影", async () => {
  let projected = false;
  await assert.rejects(promoteMemoryToAuthority(memory(), {
    store: {
      async upsertAuthorityMemoryProjection() { projected = true; },
    },
    now,
    writePage: async () => {},
    readPage: async (_path, slug) => ({
      slug,
      updatedAt: now.toISOString(),
      content: "<!-- foursday-memory-statement:start -->\n被篡改\n<!-- foursday-memory-statement:end -->",
    }),
  }), /statement mismatch/u);
  assert.equal(projected, false);
});

test("自动确认只接受达到置信阈值的安全候选", async () => {
  let confirmations = 0;
  const source = memory({ confidence: 0.94 });
  await promoteMemoryToAuthority(source, {
    store: {
      async upsertAuthorityMemoryProjection() {
        return { id: "authority-low", status: "proposed", created: true };
      },
      async confirmMemory() { confirmations += 1; },
    },
    autoConfirm: true,
    autoConfirmMinimumConfidence: 0.95,
    now,
    writePage: async () => {},
    readPage: async (_path, slug) => ({
      slug,
      content: authorityMarkdownForMemory(source, { generatedAt: now }).content,
      updatedAt: now.toISOString(),
    }),
  });
  assert.equal(confirmations, 0);
});

test("批量同步只处理可持久化的低风险来源，失败不会冒充成功", async () => {
  const rows = [
    memory(),
    memory({ id: "operator", source_type: "operator" }),
    memory({ id: "secret", sensitivity: "confidential" }),
  ];
  const report = await synchronizeMemoryAuthority({
    store: {
      async listMemories() { return rows; },
      async upsertAuthorityMemoryProjection() {
        return { id: "authority", status: "proposed", created: true };
      },
      async confirmMemory() {},
    },
    now,
    writePage: async () => {},
    readPage: async (_path, slug) => ({
      slug,
      content: authorityMarkdownForMemory(rows[0], { generatedAt: now }).content,
      updatedAt: now.toISOString(),
    }),
  });
  assert.deepEqual(
    { inspected: report.inspected, eligible: report.eligible, promoted: report.promoted },
    { inspected: 3, eligible: 1, promoted: 1 },
  );
});

test("已有受管理投影时不重复写入或同步原始来源", async () => {
  const source = memory();
  let writes = 0;
  const report = await synchronizeMemoryAuthority({
    store: {
      async listMemories({ sourceType }) {
        if (sourceType === "gbrain") {
          return [{
            ...source,
            id: "authority-existing",
            source_type: "gbrain",
            source_id: "atoms/foursday/projects/existing/fact",
            scope: {
              factKey: source.scope.factKey,
              authority: {
                schema: memoryAuthoritySchema,
                managed: true,
                origin: { memoryId: source.id },
              },
            },
          }];
        }
        return sourceType === source.source_type ? [source] : [];
      },
    },
    writePage: async () => { writes += 1; },
    readPage: async () => { throw new Error("must not read"); },
  });
  assert.equal(report.alreadyProjected, 1);
  assert.equal(report.eligible, 0);
  assert.equal(writes, 0);
});

test("默认权威同步批量写入一次并对每页执行精确回读", async () => {
  const sources = [memory(), memory({
    id: "memory_source_2",
    statement: "第二条受治理事实。",
    scope: { factKey: "decision.second_fact" },
  })];
  let batchCalls = 0;
  let readCalls = 0;
  const documents = new Map();
  const report = await synchronizeMemoryAuthority({
    store: {
      async listMemories({ sourceType }) {
        if (sourceType === "gbrain") return [];
        return sourceType === "dingtalk_message" ? sources : [];
      },
      async upsertAuthorityMemoryProjection(input) {
        return {
          id: `authority-${input.sourceMemoryId}`,
          status: "proposed",
          created: true,
        };
      },
      async confirmMemory() {},
    },
    now,
    autoConfirm: true,
    writeBatchPage: async (_path, batch) => {
      batchCalls += 1;
      for (const document of batch) documents.set(document.slug, document);
      return { pages: batch.length, written: batch.length, synchronized: true };
    },
    readPage: async (_path, slug) => {
      readCalls += 1;
      return { slug, content: documents.get(slug).content, updatedAt: now.toISOString() };
    },
  });
  assert.equal(batchCalls, 1);
  assert.equal(readCalls, 2);
  assert.equal(report.promoted, 2);
  assert.equal(report.confirmed, 2);
  assert.equal(report.failed, 0);
});

test("受管理 gbrain 记忆可覆盖人物和原则命名空间", () => {
  assert.equal(isManagedMemoryAuthority({
    source_type: "gbrain",
    source_id: "atoms/foursday/people/abc/fact",
    scope: { authority: { schema: memoryAuthoritySchema, managed: true } },
  }), true);
});

test("gbrain 写适配器使用参数数组和最小环境并校验回执身份", async () => {
  const calls = [];
  await writeGbrainPage("/trusted/gbrain", {
    slug: "atoms/foursday/principles/core/fact",
    content: "# safe",
  }, {
    run: async (path, args, options) => {
      calls.push({ path, args, options });
      return { stdout: JSON.stringify({ slug: "atoms/foursday/principles/core/fact" }) };
    },
  });
  assert.equal(calls[0].path, "/trusted/gbrain");
  assert.deepEqual(calls[0].args.slice(0, 2), ["call", "put_page"]);
  assert.equal(calls[0].options.env.AI_EMPLOYEE_DATA_KEY, undefined);
  await assert.rejects(writeGbrainPage("/trusted/gbrain", {
    slug: "atoms/foursday/principles/core/fact",
    content: "# safe",
  }, {
    run: async () => ({ stdout: JSON.stringify({ slug: "atoms/foursday/other" }) }),
  }), /unexpected write receipt/u);
});

test("Markdown 权威写入先原子落盘再同步 gbrain，且拒绝覆盖人工修改", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foursday-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeGit(root);
  const slug = "atoms/foursday/principles/core/abc";
  const calls = [];
  await writeGbrainMarkdownAuthority("/trusted/gbrain", {
    slug,
    content: "# governed\n",
  }, {
    root,
    run: async (path, args) => {
      calls.push({ path, args });
      return { stdout: "" };
    },
  });
  assert.equal(await readFile(join(root, `${slug}.md`), "utf8"), "# governed\n");
  assert.deepEqual(calls[0].args, ["sync", "--source", "foursday"]);
  await assert.rejects(writeGbrainMarkdownAuthority("/trusted/gbrain", {
    slug,
    content: "# changed\n",
  }, {
    root,
    run: async () => ({ stdout: "" }),
  }), /changed outside Foursday/u);
});

test("受管理 Markdown 撤销后隔离原文件、同步并精确确认 gbrain 不可读", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "foursday-authority-cleanup-"));
  const root = join(temporary, "brain");
  await mkdir(root);
  await initializeGit(root);
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const slug = "atoms/foursday/principles/core/cleanup";
  const content = "# governed\n";
  await writeGbrainMarkdownAuthority("/trusted/gbrain", { slug, content }, {
    root,
    run: async () => ({ stdout: "" }),
  });
  const calls = [];
  const result = await retireGbrainMarkdownAuthority("/trusted/gbrain", {
    slug,
    contentSha256: createHash("sha256").update(content).digest("hex"),
    cleanupId: "memory_cleanup_12345678",
  }, {
    root,
    run: async (_path, args) => {
      calls.push(args);
      if (args[0] === "call") {
        const error = new Error("not found");
        error.stderr = `Page not found: ${slug}`;
        throw error;
      }
      return { stdout: "" };
    },
  });
  assert.equal(result.readback, "page_not_found");
  await assert.rejects(readFile(join(root, `${slug}.md`), "utf8"), { code: "ENOENT" });
  await assert.rejects(
    readFile(join(temporary, ".foursday-memory-trash", "memory_cleanup_12345678.md"), "utf8"),
    { code: "ENOENT" },
  );
  assert.deepEqual(calls.map((args) => args[0]), ["sync", "call"]);
});

test("Markdown 权威批量写入只执行一次 gbrain source 同步", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foursday-authority-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeGit(root);
  const syncCalls = [];
  const result = await writeGbrainMarkdownAuthorityBatch(
    "/trusted/gbrain",
    [
      { slug: "atoms/foursday/principles/core/batch-a", content: "# A\n" },
      { slug: "atoms/foursday/principles/core/batch-b", content: "# B\n" },
    ],
    {
      root,
      run: async (_path, args) => {
        syncCalls.push(args);
        return { stdout: "" };
      },
    },
  );
  assert.deepEqual(result, { pages: 2, written: 2, synchronized: true });
  assert.deepEqual(syncCalls, [["sync", "--source", "foursday"]]);
});

test("记忆权威回收作业失败时保留重试状态且不冒充完成", async () => {
  const events = [];
  let claimed = true;
  const report = await reconcileMemoryAuthorityCleanup({
    store: {
      async claimMemoryAuthorityCleanup() {
        if (!claimed) return null;
        claimed = false;
        return {
          id: "memory_cleanup_12345678",
          slug: "atoms/foursday/principles/core/cleanup",
          authoritySourceId: "foursday",
          contentSha256: "a".repeat(64),
        };
      },
      async completeMemoryAuthorityCleanup() { events.push("completed"); },
      async failMemoryAuthorityCleanup(_id, _owner, code) { events.push(`failed:${code}`); },
    },
    authorityRoot: "/trusted/root",
    owner: "test-owner",
    retirePage: async () => { throw new Error("gbrain unavailable"); },
  });
  assert.deepEqual({ completed: report.completed, failed: report.failed }, { completed: 0, failed: 1 });
  assert.deepEqual(events, ["failed:network_unavailable"]);
});

test("gbrain 删除同步失败时恢复原 Markdown 文件", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "foursday-authority-restore-"));
  const root = join(temporary, "brain");
  await mkdir(root);
  await initializeGit(root);
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const slug = "atoms/foursday/principles/core/restore";
  const content = "# restore me\n";
  await writeGbrainMarkdownAuthority("/trusted/gbrain", { slug, content }, {
    root,
    run: async () => ({ stdout: "" }),
  });
  let calls = 0;
  await assert.rejects(
    retireGbrainMarkdownAuthority("/trusted/gbrain", {
      slug,
      contentSha256: createHash("sha256").update(content).digest("hex"),
      cleanupId: "memory_cleanup_restore123",
    }, {
      root,
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error("sync unavailable");
        return { stdout: "" };
      },
    }),
    /sync unavailable/u,
  );
  assert.equal(await readFile(join(root, `${slug}.md`), "utf8"), content);
});
