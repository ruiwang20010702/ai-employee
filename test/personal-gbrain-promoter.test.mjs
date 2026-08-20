import assert from "node:assert/strict";
import test from "node:test";
import {
  promoteOnePersonalGbrainCandidate,
  reconcilePromotedPersonalGbrainCandidates,
  retireOnePersonalGbrainCandidate,
} from "../src/personal-gbrain-promoter.mjs";

function config(enabled = true) {
  return {
    personalMemoryWriteEnabled: enabled,
    personalMemoryWriterRoot: "/private/writer",
    personalMemoryGitRemote: "https://github.com/example/private-vault.git",
    personalMemoryGitBranch: "main",
    personalMemoryGbrainPath: "/trusted/gbrain",
  };
}

function lease() {
  return {
    id: "candidate",
    type: "atom",
    projectId: "project",
    factKey: "project.stable_fact",
    title: "Stable fact",
    statement: "The project uses the verified current result.",
    sensitivity: "internal",
    confidence: 0.99,
    createdAt: "2026-08-20T00:00:00Z",
    sourceSessionHash: "e".repeat(64),
    evidence: [{
      relativePath: "summary.json",
      contentSha256: "f".repeat(64),
      description: "summary",
    }],
  };
}

test("promoter is inert while personal gbrain writes are disabled", async () => {
  const result = await promoteOnePersonalGbrainCandidate({
    config: config(false),
    store: { leaseNext: async () => { throw new Error("must not lease"); } },
  });
  assert.deepEqual(result, {
    enabled: false,
    processed: 0,
    reason: "personal_memory_write_disabled",
  });
});

test("promoter leases, writes through dedicated checkout, read-backs and completes", async () => {
  const calls = [];
  const result = await promoteOnePersonalGbrainCandidate({
    config: config(),
    registry: { schemaVersion: 1, projects: [{ id: "project", root: "/private/project" }] },
    owner: "promoter:test",
    store: {
      leaseNext: async (input) => { calls.push(["lease", input.owner]); return lease(); },
      complete: async (id, owner, promotion) => calls.push(["complete", id, owner, promotion.slug]),
      fail: async () => { throw new Error("must not fail"); },
    },
    promote: async (candidate, options) => {
      calls.push(["promote", candidate.projectId, options.projectRoot]);
      return {
        slug: "atoms/agents/foursday/project/key",
        commit: "a".repeat(40),
        contentSha256: "b".repeat(64),
        readBack: true,
      };
    },
  });
  assert.equal(result.status, "promoted");
  assert.deepEqual(calls.map((call) => call[0]), ["lease", "promote", "complete"]);
});

test("promoter keeps failed candidates retryable without leaking error text", async () => {
  const result = await promoteOnePersonalGbrainCandidate({
    config: config(),
    registry: { schemaVersion: 1, projects: [{ id: "project", root: "/private/project" }] },
    owner: "promoter:test",
    store: {
      leaseNext: async () => lease(),
      complete: async () => { throw new Error("must not complete"); },
      fail: async () => ({ status: "retry", lastErrorCode: "promotion_failed" }),
    },
    promote: async () => { throw new Error("secret database content"); },
  });
  assert.deepEqual(result, {
    enabled: true,
    processed: 1,
    status: "retry",
    candidateId: "candidate",
    errorCode: "promotion_failed",
  });
});

test("privacy retirement is processed before the scrubbed candidate leaves PostgreSQL", async () => {
  const calls = [];
  const result = await retireOnePersonalGbrainCandidate({
    config: config(),
    owner: "promoter:retirement",
    store: {
      leaseRetirement: async () => ({
        id: "candidate",
        authoritySlug: "atoms/agents/foursday/project/key",
        authoritySha256: "a".repeat(64),
      }),
      completeRetirement: async (id, owner, retirement) =>
        calls.push(["complete", id, owner, retirement.status]),
      failRetirement: async () => { throw new Error("must not fail"); },
    },
    retire: async (promotion, options) => {
      calls.push(["retire", promotion.slug, options.writerRoot]);
      return {
        status: "revoked",
        slug: promotion.slug,
        commit: "b".repeat(40),
        contentSha256: "c".repeat(64),
        readBack: true,
      };
    },
  });
  assert.equal(result.status, "revoked");
  assert.deepEqual(calls.map((call) => call[0]), ["retire", "complete"]);
});

test("failed privacy retirement remains pending without exposing error text", async () => {
  const result = await retireOnePersonalGbrainCandidate({
    config: config(),
    owner: "promoter:retirement",
    store: {
      leaseRetirement: async () => ({
        id: "candidate",
        authoritySlug: "atoms/agents/foursday/project/key",
        authoritySha256: "a".repeat(64),
      }),
      completeRetirement: async () => { throw new Error("must not complete"); },
      failRetirement: async () => ({
        status: "retirement_pending",
        lastErrorCode: "retirement_failed",
      }),
    },
    retire: async () => { throw new Error("secret git failure"); },
  });
  assert.deepEqual(result, {
    enabled: true,
    processed: 1,
    status: "retirement_pending",
    candidateId: "candidate",
    errorCode: "retirement_failed",
  });
});

test("source drift supersedes and revokes promoted knowledge without deleting it", async () => {
  const promoted = {
    ...lease(),
    status: "promoted",
    authoritySlug: "atoms/agents/foursday/project/key",
    authoritySha256: "a".repeat(64),
  };
  promoted.evidence[0].contentSha256 = "0".repeat(64);
  const calls = [];
  const result = await reconcilePromotedPersonalGbrainCandidates({
    config: config(),
    registry: { schemaVersion: 1, projects: [{ id: "project", root: "/private/project" }] },
    store: {
      list: async () => [promoted],
      revoke: async (id, retirement) => calls.push([id, retirement.status]),
    },
    retire: async () => ({
      status: "revoked",
      commit: "b".repeat(40),
      contentSha256: "c".repeat(64),
      deleted: false,
    }),
  });
  assert.equal(result.revoked, 1);
  assert.deepEqual(calls, [["candidate", "revoked"]]);
});
