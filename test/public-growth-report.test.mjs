import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildPublicGrowthReport,
  countVerifiedCommunityExtensions,
  countExternalPilotStarts,
  countValidSetupCheckins,
  countVerifiedExternalLoops,
  summarizeMergedExternalPulls,
  validSetupCheckin,
} from "../src/public-growth-report.mjs";
import { runPublicGrowthReport } from "../scripts/报告公开增长.mjs";

const sha = "a".repeat(40);
const communityBlobSha = "c".repeat(40);
const communityArtifact = JSON.stringify({ id: "community-safe-review" });
const communityArtifactSha256 = createHash("sha256").update(communityArtifact).digest("hex");

function verifiedPilot({ selfLoops = 10, externalTesters = 10 } = {}) {
  return {
    valid: true,
    schema: "foursday-pilot-evidence/v1",
    candidateSha: sha,
    verifiedLoops: selfLoops + externalTesters,
    selfLoops,
    externalTesters,
    distinctVerifiedClosedLoopUsers: externalTesters + (selfLoops > 0 ? 1 : 0),
    localIntegrityVerified: true,
    targetReadbackReverificationRequired: true,
  };
}

function verifiedTargets(targets = 20) {
  return {
    valid: true,
    schema: "foursday-pilot-target-readback/v1",
    candidateSha: sha,
    verifiedTargets: targets,
    verifiedIssues: targets,
    verifiedDraftPullRequests: targets,
    targetReadbackReverificationRequired: false,
    identitiesEmitted: false,
    targetContentsEmitted: false,
    externalSystemsModified: false,
  };
}

function setupBody(candidate = sha, { deployment = "no", friction = "none" } = {}) {
  return `### Foursday v0.5 setup check-in

- immutable candidate: ${candidate}
- Node.js: 24
- platform: macOS
- loopback Web page opened: yes
- read-only readiness check completed: yes
- fork, branch, push, or PR created by this readiness check: no
- production deployment performed by this launch or readiness check: ${deployment}
- automatic sending, execution, or proactive work enabled by this launch or readiness check: no
- approximate setup time: 4 minutes
- one friction point or none: ${friction}`;
}

function comment(login, body = setupBody(), type = "User") {
  return { user: { login, type }, body };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixtureFetch({
  externalLoops = 2,
  issue50Sha = sha,
  mergeBase = "b".repeat(40),
} = {}) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url: url.toString(), options });
    if (url.pathname === "/repos/ruiwang20010702/foursday") {
      return jsonResponse({
        full_name: "ruiwang20010702/foursday",
        private: false,
        default_branch: "main",
        stargazers_count: 7,
        forks_count: 3,
      });
    }
    if (url.pathname.endsWith("/issues/49")) {
      const slots = Array.from({ length: 10 }, (_, index) => {
        const number = String(index + 1).padStart(2, "0");
        return `- [${index < externalLoops ? "x" : " "}] external loop ${number}`;
      }).join("\n");
      return jsonResponse({
        number: 49,
        state: "open",
        body: `github:ruiwang20010702/foursday#${sha}\n${slots}`,
      });
    }
    if (url.pathname.endsWith("/issues/50")) {
      return jsonResponse({
        number: 50,
        state: "open",
        body: `github:ruiwang20010702/foursday#${issue50Sha}`,
      });
    }
    if (url.pathname.endsWith("/issues/50/comments")) {
      return jsonResponse([
        comment("external-one"),
        comment("EXTERNAL-ONE"),
        comment("ruiwang20010702"),
        comment("external-two", setupBody(sha, { deployment: "yes" })),
      ]);
    }
    if (url.pathname.endsWith("/issues/49/comments")) {
      return jsonResponse([
        comment("external-one", "I started the pilot"),
        comment("EXTERNAL-ONE", "I started the pilot"),
        comment("external-two", "I started the pilot\nI also finished"),
        comment("ruiwang20010702", "I started the pilot"),
      ]);
    }
    if (url.pathname.endsWith("/pulls")) {
      return jsonResponse([
        {
          number: 10,
          user: { login: "ruiwang20010702", type: "User" },
          base: { ref: "main" },
          merged_at: "2026-08-12T00:00:00.000Z",
          labels: [{ name: "recipe" }],
        },
        {
          number: 11,
          user: { login: "external-one", type: "User" },
          base: { ref: "main" },
          merged_at: "2026-08-12T00:00:00.000Z",
          labels: [{ name: "recipe" }],
        },
        {
          number: 12,
          user: { login: "external-one", type: "User" },
          base: { ref: "main" },
          merged_at: "2026-08-12T00:00:00.000Z",
          labels: [{ name: "documentation" }],
        },
        {
          number: 13,
          user: { login: "external-two", type: "User" },
          base: { ref: "main" },
          merged_at: null,
          labels: [{ name: "adapter" }],
        },
      ]);
    }
    if (url.pathname.endsWith("/pulls/11/files")) {
      return jsonResponse([{
        filename: "examples/recipes/community-safe-review.json",
        status: "added",
        sha: communityBlobSha,
      }]);
    }
    if (url.pathname.endsWith("/contents/examples/recipes/community-safe-review.json")) {
      return jsonResponse({
        type: "file",
        path: "examples/recipes/community-safe-review.json",
        sha: communityBlobSha,
        encoding: "base64",
        size: Buffer.byteLength(communityArtifact),
        content: Buffer.from(communityArtifact).toString("base64"),
      });
    }
    if (url.pathname.includes("/compare/")) {
      return jsonResponse({ merge_base_commit: { sha: mergeBase } });
    }
    return jsonResponse({}, 404);
  };
  return { fetchImpl, calls };
}

test("安装签到只接受当前提交、完整零副作用声明和外部用户", () => {
  assert.equal(validSetupCheckin(comment("external-one"), { candidateSha: sha }), true);
  assert.equal(validSetupCheckin(comment("ruiwang20010702"), { candidateSha: sha }), false);
  assert.equal(validSetupCheckin(comment("external-one", setupBody("b".repeat(40))), { candidateSha: sha }), false);
  assert.equal(validSetupCheckin(comment("external-one", setupBody(sha, { deployment: "yes" })), { candidateSha: sha }), false);
  assert.equal(validSetupCheckin(comment("external-one", setupBody(sha, { friction: "__" })), { candidateSha: sha }), false);
  assert.equal(validSetupCheckin(comment("external-one", `${setupBody()}\n- token: ghp_example1234567890`), { candidateSha: sha }), false);
  assert.equal(validSetupCheckin(comment("external-one", setupBody(sha, { friction: "see /Users/alice/private.log" })), { candidateSha: sha }), false);
  assert.equal(validSetupCheckin(comment("external-one", setupBody(sha, { friction: "email me at alice@example.com" })), { candidateSha: sha }), false);
  assert.equal(validSetupCheckin(comment("external-one", setupBody(sha, { friction: "API key: sk-example1234567890" })), { candidateSha: sha }), false);
  assert.equal(validSetupCheckin(comment("external-one", setupBody(sha, { friction: "GitHub auth was unclear" })), { candidateSha: sha }), true);
  assert.equal(countValidSetupCheckins([
    comment("external-one"),
    comment("EXTERNAL-ONE"),
    comment("external-two"),
  ], { candidateSha: sha }), 2);
});

test("外部闭环只读取维护者勾选的十个固定槽位", () => {
  assert.equal(countVerifiedExternalLoops(`
- [x] external loop 01
- [X] external loop 02
- [x] external loop 02
- [x] external loop 11
- [ ] external loop 03
  `), 2);
});

test("外部启动意向只聚合唯一外部账号的精确自愿短语", () => {
  assert.equal(countExternalPilotStarts([
    comment("external-one", "I started the pilot"),
    comment("EXTERNAL-ONE", "I started the pilot"),
    comment("external-two", " I started the pilot "),
    comment("external-three", "I started the pilot and need help"),
    comment("ruiwang20010702", "I started the pilot"),
  ]), 2);
});

test("外部贡献者和社区扩展只统计合入默认分支的外部 PR", () => {
  assert.deepEqual(summarizeMergedExternalPulls([
    {
      user: { login: "external-one", type: "User" },
      base: { ref: "main" },
      merged_at: "2026-08-12T00:00:00Z",
      labels: [{ name: "recipe" }],
    },
    {
      user: { login: "EXTERNAL-ONE", type: "User" },
      base: { ref: "main" },
      merged_at: "2026-08-12T00:01:00Z",
      labels: [{ name: "documentation" }],
    },
    {
      user: { login: "external-two", type: "User" },
      base: { ref: "release" },
      merged_at: "2026-08-12T00:02:00.000Z",
      labels: [{ name: "adapter" }],
    },
    {
      user: { login: "external-three", type: "User" },
      base: { ref: "main" },
      merged_at: null,
      labels: [{ name: "community-extension" }],
    },
    {
      user: { login: "ruiwang20010702", type: "User" },
      base: { ref: "main" },
      merged_at: "2026-08-12T00:03:00.000Z",
      labels: [{ name: "recipe" }],
    },
  ], { defaultBranch: "main" }), {
    mergedExternalContributors: 1,
    maintainerAttestedCommunityRecipesOrAdapters: 1,
  });
});

test("社区扩展强证据必须同时命中外部合并、审核标签和真实改动文件", () => {
  const entries = [{
    kind: "recipe",
    extensionId: "community-safe-review",
    extensionPath: "examples/recipes/community-safe-review.json",
    contentSha256: communityArtifactSha256,
    pullNumber: 11,
  }];
  const pulls = [{
    number: 11,
    user: { login: "external-one", type: "User" },
    base: { ref: "main" },
    merged_at: "2026-08-12T00:00:00Z",
    labels: [{ name: "recipe" }],
  }];
  assert.equal(countVerifiedCommunityExtensions(
    entries,
    pulls,
    new Map([[11, [{
      filename: entries[0].extensionPath,
      status: "added",
      sha: communityBlobSha,
    }]]]),
    new Map([[entries[0].extensionPath, {
      type: "file",
      path: entries[0].extensionPath,
      sha: communityBlobSha,
      encoding: "base64",
      size: Buffer.byteLength(communityArtifact),
      content: Buffer.from(communityArtifact).toString("base64"),
    }]]),
    { defaultBranch: "main" },
  ), 1);
  assert.throws(() => countVerifiedCommunityExtensions(
    entries,
    pulls,
    new Map([[11, [{ filename: "docs/unrelated.md", status: "modified", sha: communityBlobSha }]]]),
    new Map([[entries[0].extensionPath, {
      type: "file",
      path: entries[0].extensionPath,
      sha: communityBlobSha,
      encoding: "base64",
      size: Buffer.byteLength(communityArtifact),
      content: Buffer.from(communityArtifact).toString("base64"),
    }]]),
    { defaultBranch: "main" },
  ), /does not contain the validated extension file/u);
  assert.throws(() => countVerifiedCommunityExtensions(
    entries,
    [{ ...pulls[0], labels: [{ name: "documentation" }] }],
    new Map([[11, [{
      filename: entries[0].extensionPath,
      status: "added",
      sha: communityBlobSha,
    }]]]),
    new Map([[entries[0].extensionPath, {
      type: "file",
      path: entries[0].extensionPath,
      sha: communityBlobSha,
      encoding: "base64",
      size: Buffer.byteLength(communityArtifact),
      content: Buffer.from(communityArtifact).toString("base64"),
    }]]),
    { defaultBranch: "main" },
  ), /missing its reviewed extension label/u);
  assert.throws(() => countVerifiedCommunityExtensions(
    entries,
    pulls,
    new Map([[11, [{
      filename: entries[0].extensionPath,
      status: "added",
      sha: "d".repeat(40),
    }]]]),
    new Map([[entries[0].extensionPath, {
      type: "file",
      path: entries[0].extensionPath,
      sha: communityBlobSha,
      encoding: "base64",
      size: Buffer.byteLength(communityArtifact),
      content: Buffer.from(communityArtifact).toString("base64"),
    }]]),
    { defaultBranch: "main" },
  ), /PR file differs from the candidate file/u);
});

test("公开增长报告只读聚合并且不输出身份或评论正文", async () => {
  const { fetchImpl, calls } = fixtureFetch();
  const result = await buildPublicGrowthReport({
    candidateSha: sha,
    fetchImpl,
    now: () => new Date("2026-08-12T00:00:00.000Z"),
  });
  assert.equal(result.schema, "foursday-public-growth-report/v1");
  assert.equal(result.current.githubStars, 7);
  assert.equal(result.current.githubForks, 3);
  assert.equal(result.current.externalPilotStarts, 1);
  assert.equal(result.current.successfulExternalSetups, 1);
  assert.equal(result.current.maintainerAttestedExternalPilotLoops, 2);
  assert.equal(result.current.locallyVerifiedExternalPilotLoops, null);
  assert.equal(result.current.onlineVerifiedPilotTargets, null);
  assert.equal(result.current.locallyVerifiedClosedLoopUsers, null);
  assert.equal(result.current.mergedExternalContributors, 1);
  assert.equal(result.current.maintainerAttestedCommunityRecipesOrAdapters, 1);
  assert.equal(result.current.locallyVerifiedCommunityRecipesOrAdapters, null);
  assert.equal(result.entrypoints.issue49CandidateMatches, true);
  assert.equal(result.entrypoints.issue50CandidateMatches, true);
  assert.equal(result.entrypoints.candidateVisibleFromDefault, false);
  assert.equal(result.broadLaunchReady, false);
  assert.equal(result.nextGate, "complete_10_distinct_external_pilot_loops");
  assert.deepEqual(result.safety, {
    readOnly: true,
    credentialsRequired: false,
    apiAuthenticationUsed: false,
    identitiesEmitted: false,
    commentBodiesEmitted: false,
    localEvidenceIdentitiesEmitted: false,
    externalSystemsModified: false,
    automaticPublishing: false,
    productionWrite: false,
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /external-one|Foursday v0\.5 setup check-in/u);
  assert.ok(calls.every((entry) => entry.url.startsWith("https://api.github.com/repos/ruiwang20010702/foursday")));
  assert.ok(calls.every((entry) => entry.options.redirect === "error"));
  assert.ok(calls.every((entry) => !Object.keys(entry.options.headers).some((key) => /authorization|token/iu.test(key))));
});

test("公开增长报告把本地扩展完整性与 GitHub PR 文件回读交叉验证", async () => {
  const { fetchImpl, calls } = fixtureFetch();
  const result = await buildPublicGrowthReport({
    candidateSha: sha,
    fetchImpl,
    extensionVerification: {
      valid: true,
      schema: "foursday-community-extension-evidence/v1",
      candidateSha: sha,
      verifiedCommunityRecipesOrAdapters: 1,
      entries: [{
        kind: "recipe",
        extensionId: "community-safe-review",
        extensionPath: "examples/recipes/community-safe-review.json",
        contentSha256: communityArtifactSha256,
        pullNumber: 11,
      }],
      localIntegrityVerified: true,
      targetReadbackReverificationRequired: true,
      contributorIdentitiesEmitted: false,
    },
  });
  assert.equal(result.current.locallyVerifiedCommunityRecipesOrAdapters, 1);
  assert.ok(calls.some((entry) => new URL(entry.url).pathname.endsWith("/pulls/11/files")));
  assert.doesNotMatch(JSON.stringify(result), /community-safe-review|external-one/u);
});

test("公开入口提交漂移时报告拒绝宣称可大范围发布", async () => {
  const { fetchImpl } = fixtureFetch({
    externalLoops: 10,
    issue50Sha: "c".repeat(40),
    mergeBase: sha,
  });
  const result = await buildPublicGrowthReport({
    candidateSha: sha,
    fetchImpl,
    pilotVerification: verifiedPilot(),
  });
  assert.equal(result.entrypoints.issue50CandidateMatches, false);
  assert.equal(result.entrypoints.candidateVisibleFromDefault, true);
  assert.equal(result.broadLaunchReady, false);
  assert.equal(result.nextGate, "align_public_candidate_entrypoints");
});

test("只有候选进入默认分支、入口一致且二十个目标在线回读时才允许大范围发布", async () => {
  const { fetchImpl } = fixtureFetch({ externalLoops: 10, mergeBase: sha });
  const result = await buildPublicGrowthReport({
    candidateSha: sha,
    fetchImpl,
    pilotVerification: verifiedPilot(),
    pilotTargetVerification: verifiedTargets(),
  });
  assert.equal(result.current.maintainerAttestedExternalPilotLoops, 10);
  assert.equal(result.current.locallyVerifiedExternalPilotLoops, 10);
  assert.equal(result.current.onlineVerifiedPilotTargets, 20);
  assert.equal(result.current.locallyVerifiedClosedLoopUsers, 11);
  assert.equal(result.entrypoints.issue49CandidateMatches, true);
  assert.equal(result.entrypoints.issue50CandidateMatches, true);
  assert.equal(result.broadLaunchReady, true);
  assert.equal(result.nextGate, "review_default_branch_or_immutable_release_launch");
});

test("本机十加十证据没有在线目标回读时不能解锁大范围发布", async () => {
  const { fetchImpl } = fixtureFetch({ externalLoops: 10, mergeBase: sha });
  const result = await buildPublicGrowthReport({
    candidateSha: sha,
    fetchImpl,
    pilotVerification: verifiedPilot(),
  });
  assert.equal(result.current.locallyVerifiedExternalPilotLoops, 10);
  assert.equal(result.current.onlineVerifiedPilotTargets, null);
  assert.equal(result.broadLaunchReady, false);
  assert.equal(result.nextGate, "verify_pilot_target_readback");
});

test("公开勾选十个槽位但没有本机证据清单时仍不允许大范围发布", async () => {
  const { fetchImpl } = fixtureFetch({ externalLoops: 10, mergeBase: sha });
  const result = await buildPublicGrowthReport({ candidateSha: sha, fetchImpl });
  assert.equal(result.current.maintainerAttestedExternalPilotLoops, 10);
  assert.equal(result.current.locallyVerifiedExternalPilotLoops, null);
  assert.equal(result.broadLaunchReady, false);
  assert.equal(result.nextGate, "verify_external_pilot_manifest");
});

test("本机证据已经完成但公开槽位未同步时要求先更新公开确认", async () => {
  const { fetchImpl } = fixtureFetch({ externalLoops: 2, mergeBase: sha });
  const result = await buildPublicGrowthReport({
    candidateSha: sha,
    fetchImpl,
    pilotVerification: verifiedPilot(),
  });
  assert.equal(result.broadLaunchReady, false);
  assert.equal(result.nextGate, "synchronize_public_cohort_attestation");
});

test("不完整或伪造的本机体验验证结果会被拒绝", async () => {
  const { fetchImpl } = fixtureFetch({ externalLoops: 10, mergeBase: sha });
  await assert.rejects(() => buildPublicGrowthReport({
    candidateSha: sha,
    fetchImpl,
    pilotVerification: verifiedPilot({ externalTesters: 9 }),
  }), /invalid or incomplete/u);
  await assert.rejects(() => buildPublicGrowthReport({
    candidateSha: sha,
    fetchImpl,
    pilotVerification: { ...verifiedPilot(), candidateSha: "b".repeat(40) },
  }), /invalid or incomplete/u);
});

test("闭环增长清单从第一位用户起累计但不会冒充首发十人门禁", async () => {
  const { fetchImpl } = fixtureFetch({ externalLoops: 2, mergeBase: sha });
  const result = await buildPublicGrowthReport({
    candidateSha: sha,
    fetchImpl,
    growthVerification: verifiedPilot({ selfLoops: 1, externalTesters: 3 }),
  });
  assert.equal(result.current.locallyVerifiedClosedLoopUsers, 4);
  assert.equal(result.current.locallyVerifiedExternalPilotLoops, null);
  assert.equal(result.broadLaunchReady, false);
});

test("增长报告命令必须显式提供完整候选提交且只写聚合 JSON", async () => {
  await assert.rejects(() => runPublicGrowthReport({ args: [], build: async () => ({}) }), /Usage/u);
  const writes = [];
  const result = await runPublicGrowthReport({
    args: ["--sha", sha],
    output: { write: (value) => writes.push(value) },
    environment: {},
    build: async ({
      candidateSha,
      pilotVerification,
      pilotTargetVerification,
      growthVerification,
      extensionVerification,
      githubToken,
    }) => ({
      valid: true,
      candidateSha,
      pilotVerification,
      pilotTargetVerification,
      growthVerification,
      extensionVerification,
      githubToken,
    }),
  });
  assert.deepEqual(result, {
    valid: true,
    candidateSha: sha,
    pilotVerification: null,
    pilotTargetVerification: null,
    growthVerification: null,
    extensionVerification: null,
    githubToken: null,
  });
  assert.deepEqual(JSON.parse(writes.join("")), result);
});

test("增长报告仅在显式提供清单时运行本机体验证据验证", async () => {
  const observed = [];
  const targetObserved = [];
  const result = await runPublicGrowthReport({
    args: ["--sha", sha, "--pilot-manifest", "./private/pilot.json"],
    output: { write() {} },
    environment: {},
    verify: async (path, options) => {
      observed.push({ path, options });
      return verifiedPilot();
    },
    verifyTargets: async (path, options) => {
      targetObserved.push({ path, options });
      return verifiedTargets();
    },
    build: async (input) => input,
  });
  assert.deepEqual(observed, [{
    path: "./private/pilot.json",
    options: { candidateSha: sha },
  }]);
  assert.deepEqual(targetObserved, [{
    path: "./private/pilot.json",
    options: { candidateSha: sha, githubToken: null },
  }]);
  assert.equal(result.candidateSha, sha);
  assert.equal(result.pilotVerification.externalTesters, 10);
  assert.equal(result.pilotTargetVerification.verifiedTargets, 20);
});

test("增长报告使用独立闭环清单渐进统计真实用户", async () => {
  const observed = [];
  const result = await runPublicGrowthReport({
    args: ["--sha", sha, "--closed-loop-manifest", "./private/growth.json"],
    output: { write() {} },
    environment: {},
    verifyGrowth: async (path) => {
      observed.push(path);
      return verifiedPilot({ selfLoops: 1, externalTesters: 2 });
    },
    build: async (input) => input,
  });
  assert.deepEqual(observed, ["./private/growth.json"]);
  assert.equal(result.growthVerification.distinctVerifiedClosedLoopUsers, 3);
  assert.equal(result.pilotVerification, null);
});

test("增长报告只在显式提供扩展清单时绑定同一候选提交", async () => {
  const observed = [];
  const result = await runPublicGrowthReport({
    args: ["--sha", sha, "--extension-manifest", "./private/extensions.json"],
    output: { write() {} },
    environment: {},
    verifyExtensions: async (path, options) => {
      observed.push({ path, options });
      return { valid: true, candidateSha: options.candidateSha, entries: [] };
    },
    build: async (input) => input,
  });
  assert.deepEqual(observed, [{
    path: "./private/extensions.json",
    options: { candidateSha: sha },
  }]);
  assert.equal(result.extensionVerification.candidateSha, sha);
  assert.equal(result.pilotVerification, null);
});

test("可选 GitHub 令牌只进入固定 API 请求且不进入报告", async () => {
  const token = "github_pat_example_for_rate_limit_only";
  const { fetchImpl, calls } = fixtureFetch();
  const result = await buildPublicGrowthReport({
    candidateSha: sha,
    fetchImpl,
    githubToken: token,
  });
  assert.equal(result.safety.apiAuthenticationUsed, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token, "u"));
  assert.ok(calls.every((entry) => entry.options.headers.Authorization === `Bearer ${token}`));
  await assert.rejects(() => buildPublicGrowthReport({
    candidateSha: sha,
    fetchImpl,
    githubToken: "bad token with spaces",
  }), /token is invalid/u);
});

test("命令只从标准环境变量向构建器传递可选 API 令牌", async () => {
  const observed = [];
  await runPublicGrowthReport({
    args: ["--sha", sha],
    output: { write() {} },
    environment: { GH_TOKEN: "rate-limit-token", UNRELATED_SECRET: "never-forward" },
    build: async (input) => {
      observed.push(input);
      return { valid: true };
    },
  });
  assert.equal(observed[0].githubToken, "rate-limit-token");
  assert.doesNotMatch(JSON.stringify(observed[0]), /never-forward/u);
});

test("公共计数器格式异常时失败关闭而不是归零", async () => {
  const { fetchImpl: baseFetch } = fixtureFetch();
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    if (url.pathname === "/repos/ruiwang20010702/foursday") {
      return jsonResponse({
        full_name: "ruiwang20010702/foursday",
        private: false,
        default_branch: "main",
        stargazers_count: "7",
        forks_count: 3,
      });
    }
    return baseFetch(input, options);
  };
  await assert.rejects(
    () => buildPublicGrowthReport({ candidateSha: sha, fetchImpl }),
    /stargazers_count is invalid/u,
  );
});
