import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  normalizePersonalGbrainCandidate,
  personalGbrainCandidateKey,
  renderPersonalGbrainCandidate,
  verifyPersonalGbrainCandidateEvidence,
} from "../src/personal-gbrain-candidate.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function candidate(content = "verified evidence\n") {
  return {
    schema: "foursday-personal-gbrain-candidate/v1",
    type: "atom",
    projectId: "vocab_2_2",
    factKey: "production.formal_question_count",
    title: "单词 2.2 正式试题口径",
    statement: "当前正式生产试题应按成品题目口径统计，而不是释义级源记录口径。",
    sensitivity: "internal",
    confidence: 0.99,
    observedAt: "2026-08-20T00:00:00.000Z",
    sourceSessionHash: "a".repeat(64),
    evidence: [{
      relativePath: "data/summary.json",
      contentSha256: digest(content),
      description: "项目汇总文件",
    }],
  };
}

test("personal gbrain candidates are deterministic create-only pages in the default vault", () => {
  const input = candidate();
  const first = renderPersonalGbrainCandidate(input, {
    generatedAt: "2026-08-20T01:00:00.000Z",
  });
  const second = renderPersonalGbrainCandidate(input, {
    generatedAt: "2026-08-20T01:00:00.000Z",
  });
  assert.deepEqual(first, second);
  assert.match(first.slug, /^atoms\/agents\/foursday\/vocab_2_2\/[a-f0-9]{24}$/u);
  assert.match(first.content, /source_agent: "foursday"/u);
  assert.match(first.content, /data\/summary\.json/u);
  assert.equal(first.candidateKey, personalGbrainCandidateKey(input));
});

test("personal gbrain automatic candidates reject secrets, people data and weak evidence", () => {
  for (const statement of [
    "password: abc123",
    "张三手机号是 13800138000",
    "He was diagnosed with depression.",
  ]) {
    assert.throws(
      () => normalizePersonalGbrainCandidate({ ...candidate(), statement }),
      /restricted/u,
    );
  }
  assert.throws(
    () => normalizePersonalGbrainCandidate({ ...candidate(), confidence: 0.9 }),
    /threshold/u,
  );
  assert.throws(
    () => normalizePersonalGbrainCandidate({ ...candidate(), evidence: [] }),
    /evidence/u,
  );
});

test("candidate evidence is hashed from the registered project and symlinks fail closed", async (t) => {
  const root = await realpath(await mkdtemp(join(
    tmpdir(),
    "foursday-gbrain-candidate-",
  )));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data", "summary.json"), "verified evidence\n");
  const verified = await verifyPersonalGbrainCandidateEvidence(candidate(), {
    projectRoot: root,
  });
  assert.equal(verified.evidence[0].size, 18);

  await symlink(join(root, "data", "summary.json"), join(root, "data", "alias.json"));
  const linked = candidate();
  linked.evidence[0].relativePath = "data/alias.json";
  await assert.rejects(
    verifyPersonalGbrainCandidateEvidence(linked, { projectRoot: root }),
    /regular file|symlink/u,
  );
});

test("source candidates preserve a pointer instead of copying project source content", () => {
  const input = { ...candidate(), type: "source", factKey: "source.production_summary" };
  const page = renderPersonalGbrainCandidate(input, {
    generatedAt: "2026-08-20T01:00:00.000Z",
  });
  assert.match(page.slug, /^source\/agents\/foursday\//u);
  assert.match(page.content, /source_mode: pointer/u);
  assert.doesNotMatch(page.content, /verified evidence/u);
});
