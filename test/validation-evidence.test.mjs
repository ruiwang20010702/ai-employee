import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runPilotEvidenceVerification,
  verifyGrowthEvidence,
  verifyMaintainerEvidence,
  verifyMaintainerTargetReadback,
  verifyPilotEvidence,
  verifyPilotTargetReadback,
} from "../scripts/验证体验证据.mjs";
import { runMaintainerEvidenceVerification } from "../scripts/验证维护者体验证据.mjs";
import { buildPilotTaskDraft } from "../src/pilot-task-draft.mjs";
import {
  createPublicPilotProof,
  publicPilotProofMarkdown,
  sealValidationEvidence,
  validatePublicPilotProof,
  validateValidationEvidence,
  validationEvidenceCapabilities,
} from "../src/validation-evidence.mjs";

function evidence(index = 1, {
  confirmed = true,
  repository = "example/foursday",
  sourceRepository = repository,
  startingCommit = index.toString(16).padStart(40, "0"),
  prTitle = `Pilot title ${index}`,
  prBody = `Pilot body ${index}`,
} = {}) {
  const hex = index.toString(16);
  const commit = hex.padStart(40, "0");
  const planHash = hex.padStart(64, "0");
  return sealValidationEvidence({
    schema: "foursday-validation-evidence/v1",
    validationStatus: confirmed ? "verified_closed_loop" : "awaiting_outcome_confirmation",
    generatedAt: "2026-08-12T00:00:00.000Z",
    project: {
      id: "foursday",
      repository,
      sourceRepository,
      startingCommit,
    },
    issue: { url: `https://github.com/${repository}/issues/${index}`, number: index },
    runtime: index % 2 ? "codex" : "claude-code",
    plan: { planHash, status: "completed" },
    evidence: validationEvidenceCapabilities.map((capability, step) => ({
      stepId: `step-${step + 1}`,
      capability,
      status: "completed",
      kind: capability === "github_pr_draft" ? "verified_github_pr_draft" : `verified_${capability}`,
      verification: "target_read_back",
      commit: capability === "github_pr_draft" ? commit : null,
      number: capability === "github_pr_draft" ? index : null,
      url: capability === "github_pr_draft"
        ? `https://github.com/${repository}/pull/${index}`
        : null,
      head: capability === "github_pr_draft" ? `foursday/self-${index}` : null,
      headRepository: capability === "github_pr_draft" ? sourceRepository : null,
      base: capability === "github_pr_draft" ? "main" : null,
      state: capability === "github_pr_draft" ? "OPEN" : null,
      isDraft: capability === "github_pr_draft" ? true : null,
      titleSha256: capability === "github_pr_draft"
        ? createHash("sha256").update(prTitle).digest("hex")
        : null,
      bodySha256: capability === "github_pr_draft"
        ? createHash("sha256").update(prBody).digest("hex")
        : null,
    })),
    outcomes: {
      memory: { id: `memory-${index}`, status: confirmed ? "confirmed" : "proposed" },
      timeReturn: {
        id: `time-${index}`,
        status: confirmed ? "confirmed" : "proposed",
        returnedMinutes: 30,
      },
    },
    safeguards: {
      exactPlanApproval: true,
      targetReadBack: true,
      mergePerformed: false,
      deploymentPerformed: false,
      productionSendingEnabled: false,
      proactiveWorkEnabled: false,
    },
    ...(confirmed ? {
      timing: {
        schema: "foursday-local-journey-timing/v1",
        scope: "server_start_to_confirmed_loop",
        installToPreviewMeasured: false,
        serverStartToPlanMs: 60_000,
        planReviewMs: 60_000,
        approvedExecutionMs: 180_000,
        outcomeReviewMs: 120_000,
        serverStartToConfirmedMs: 420_000,
      },
    } : {}),
  });
}

test("validation evidence requires an intact confirmed five-step closed loop", () => {
  const valid = evidence();
  const summary = validateValidationEvidence(valid);
  assert.equal(summary.confirmed, true);
  assert.equal(summary.draftPrUrl, "https://github.com/example/foursday/pull/1");
  assert.equal(summary.draftPrNumber, 1);
  assert.equal(summary.draftPrHead, "foursday/self-1");
  assert.equal(summary.draftPrHeadRepository, "example/foursday");
  assert.equal(summary.draftPrBase, "main");
  assert.equal(summary.draftPrState, "OPEN");
  assert.equal(summary.draftPrIsDraft, true);
  assert.equal(summary.draftPrTitleSha256, createHash("sha256").update("Pilot title 1").digest("hex"));
  assert.equal(summary.draftPrBodySha256, createHash("sha256").update("Pilot body 1").digest("hex"));
  assert.equal(summary.localJourney.serverStartToConfirmedMs, 420_000);
  assert.throws(
    () => validateValidationEvidence(evidence(2, { confirmed: false })),
    /not a confirmed closed loop/u,
  );
  const invalidTiming = evidence();
  const { integrity: ignoredTiming, ...timingCore } = invalidTiming;
  timingCore.timing.serverStartToConfirmedMs += 1;
  assert.throws(
    () => validateValidationEvidence(sealValidationEvidence(timingCore)),
    /stages do not equal/u,
  );
  const tampered = structuredClone(valid);
  tampered.evidence[0].status = "failed";
  assert.throws(() => validateValidationEvidence(tampered), /digest does not match/u);
  const privateBundle = sealValidationEvidence({
    ...structuredClone(valid),
    integrity: undefined,
    rootDirectory: "/private/project",
  });
  assert.throws(() => validateValidationEvidence(privateBundle), /forbidden private field/u);
});

test("validation evidence binds canonical time and GitHub target identity", () => {
  const invalidTime = evidence();
  const { integrity: ignoredTime, ...timeCore } = invalidTime;
  timeCore.generatedAt = "2026-08-12T08:00:00.000+08:00";
  assert.throws(
    () => validateValidationEvidence(sealValidationEvidence(timeCore)),
    /canonical ISO 8601 UTC/u,
  );

  const cases = [
    ["issue number", (core) => { core.issue.number = 2; }, /issue\.number/u],
    ["PR number", (core) => { core.evidence[4].number = 2; }, /draftPr\.number/u],
    ["PR state", (core) => { core.evidence[4].state = "CLOSED"; }, /open and remain a draft/u],
    ["PR draft flag", (core) => { core.evidence[4].isDraft = false; }, /open and remain a draft/u],
    ["PR head", (core) => { core.evidence[4].head = "feature/unapproved"; }, /governed branch name/u],
    ["PR repository", (core) => {
      core.evidence[4].url = "https://github.com/other/foursday/pull/1";
    }, /project repository/u],
    ["PR head repository", (core) => {
      core.evidence[4].headRepository = "other/foursday";
    }, /approved source repository/u],
    ["PR URL query", (core) => {
      core.evidence[4].url = "https://github.com/example/foursday/pull/1?token=unsafe";
    }, /credential-free GitHub HTTPS/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    const value = evidence();
    const { integrity: ignored, ...core } = value;
    mutate(core);
    assert.throws(
      () => validateValidationEvidence(sealValidationEvidence(core)),
      pattern,
      name,
    );
  }
});

test("validation evidence supports a bound fork head without changing the Issue or PR target", () => {
  const value = evidence();
  const { integrity: ignored, ...core } = value;
  core.project.sourceRepository = "tester/foursday";
  core.evidence[4].headRepository = "tester/foursday";
  const summary = validateValidationEvidence(sealValidationEvidence(core));
  assert.equal(summary.repository, "example/foursday");
  assert.equal(summary.sourceRepository, "tester/foursday");
  assert.equal(summary.draftPrHeadRepository, "tester/foursday");
});

test("public pilot proof is derived from confirmed evidence and excludes private outcome data", () => {
  const value = evidence();
  const proof = createPublicPilotProof(value);
  const markdown = publicPilotProofMarkdown(proof);
  assert.equal(proof.schema, "foursday-public-pilot-proof/v1");
  assert.equal(proof.validationStatus, "verified_closed_loop");
  assert.equal(proof.issueUrl, "https://github.com/example/foursday/issues/1");
  assert.equal(proof.draftPrUrl, "https://github.com/example/foursday/pull/1");
  assert.equal(proof.evidenceDigest, value.integrity.digest);
  assert.equal(proof.unsignedSelfReport, true);
  assert.equal(proof.maintainerReadbackRequired, true);
  assert.deepEqual(proof.localJourney, {
    scope: "server_start_to_confirmed_loop",
    serverStartToConfirmedSeconds: 420,
    serverJourneyWithinTenMinutes: true,
    installToPreviewMeasured: false,
  });
  assert.deepEqual(validatePublicPilotProof(proof), proof);
  assert.match(markdown, /Alias: tester-XX/u);
  assert.match(markdown, /maintainer target readback required: yes/iu);
  assert.match(markdown, /Measured server-start-to-confirmed seconds: 420/u);
  assert.match(markdown, /Server journey within 10 minutes: yes/u);
  assert.match(markdown, /Package download included in measured journey: no/u);
  const serialized = JSON.stringify({ proof, markdown });
  for (const forbidden of [
    "memory-1",
    "time-1",
    "rootDirectory",
    "actionToken",
    "modelOutput",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.throws(
    () => createPublicPilotProof(evidence(2, { confirmed: false })),
    /not a confirmed closed loop/u,
  );
  assert.throws(
    () => validatePublicPilotProof({ ...proof, runtime: "codex\nSecret: value" }),
    /runtime is invalid/u,
  );
  assert.throws(
    () => validatePublicPilotProof({ ...proof, unexpected: true }),
    /fields are invalid/u,
  );
  assert.throws(
    () => validatePublicPilotProof({
      ...proof,
      localJourney: { ...proof.localJourney, serverJourneyWithinTenMinutes: false },
    }),
    /timing scope or value is invalid/u,
  );

  const legacyValue = evidence(3);
  const { integrity: ignoredLegacy, ...legacyCore } = legacyValue;
  delete legacyCore.timing;
  const legacyProof = createPublicPilotProof(sealValidationEvidence(legacyCore));
  assert.equal(legacyProof.localJourney, undefined);
  assert.match(
    publicPilotProofMarkdown(legacyProof),
    /Measured server-start-to-confirmed seconds: unavailable/u,
  );
});

test("committed validation evidence example stays sanitized and valid", async () => {
  const contents = await readFile(
    new URL("../docs/examples/validation-evidence.example.json", import.meta.url),
    "utf8",
  );
  const example = JSON.parse(contents);
  const summary = validateValidationEvidence(example);

  assert.equal(summary.confirmed, true);
  assert.equal(summary.repository, "example/foursday");
  assert.equal(summary.draftPrHead, "foursday/example-8");
  const urls = [...contents.matchAll(/https:\/\/[^"\s]+/gu)].map(([url]) => url);
  assert.deepEqual(urls, [
    "https://github.com/example/foursday/issues/8",
    "https://github.com/example/foursday/pull/8",
  ]);
});
test("pilot verification requires ten self loops and ten distinct external testers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-pilot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidenceDirectory = join(directory, "evidence");
  await mkdir(evidenceDirectory);
  const entries = [];
  const candidateSha = "a".repeat(40);
  for (let index = 1; index <= 20; index += 1) {
    const file = `evidence/run-${String(index).padStart(2, "0")}.json`;
    await writeFile(join(directory, file), `${JSON.stringify(evidence(index, { startingCommit: candidateSha }), null, 2)}\n`, { mode: 0o600 });
    const external = index > 10;
    entries.push({
      cohort: external ? "external" : "self",
      participantAlias: external
        ? `tester-ext-${String(index - 10).padStart(2, "0")}`
        : "tester-maintainer",
      evidencePath: file,
      reproducedFromQuickStart: true,
      ...(external ? { feedback: `Synthetic feedback ${index}` } : {}),
    });
  }
  const manifestPath = join(directory, "pilot.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "foursday-pilot-evidence/v1",
    candidateSha,
    entries,
  }, null, 2)}\n`, { mode: 0o600 });
  const result = await verifyPilotEvidence(manifestPath, { candidateSha });
  assert.equal(result.valid, true);
  assert.equal(result.selfLoops, 10);
  assert.equal(result.externalTesters, 10);
  assert.equal(result.confirmedReturnedMinutes, 600);
  assert.equal(result.targetReadbackReverificationRequired, true);
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "foursday-pilot-evidence/v1",
    candidateSha,
    entries: entries.slice(0, 19),
  })}\n`);
  await assert.rejects(
    () => verifyPilotEvidence(manifestPath, { candidateSha }),
    /10 verified external testers/u,
  );
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "foursday-pilot-evidence/v1",
    candidateSha,
    entries,
  })}\n`);
  await writeFile(join(directory, entries[0].evidencePath), JSON.stringify(evidence(1, {
    startingCommit: "b".repeat(40),
  })));
  await assert.rejects(
    () => verifyPilotEvidence(manifestPath, { candidateSha }),
    /starting commit does not match/u,
  );
  await assert.rejects(
    () => verifyPilotEvidence(manifestPath, { candidateSha: "b".repeat(40) }),
    /candidate SHA does not match/u,
  );
});

test("pilot online readback verifies every Issue and Draft PR without emitting identities or contents", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-pilot-readback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "evidence"));
  const candidateSha = "a".repeat(40);
  const entries = [];
  const records = new Map();
  for (let index = 1; index <= 20; index += 1) {
    const external = index > 10;
    const participantAlias = external
      ? `tester-ext-${String(index - 10).padStart(2, "0")}`
      : "tester-maintainer";
    const task = buildPilotTaskDraft({ participantAlias, candidateSha });
    const sourceRepository = external ? `${participantAlias}/foursday` : "ruiwang20010702/foursday";
    const prBody = `Approved synthetic PR body ${index}`;
    const bundle = evidence(index, {
      repository: "ruiwang20010702/foursday",
      sourceRepository,
      startingCommit: candidateSha,
      prTitle: task.prTitle,
      prBody,
    });
    const evidencePath = `evidence/run-${String(index).padStart(2, "0")}.json`;
    await writeFile(join(directory, evidencePath), JSON.stringify(bundle), { mode: 0o600 });
    entries.push({
      cohort: external ? "external" : "self",
      participantAlias,
      evidencePath,
      reproducedFromQuickStart: true,
      ...(external ? { feedback: `Synthetic feedback ${index}` } : {}),
    });
    records.set(index, { task, sourceRepository, prBody, bundle });
  }
  const manifestPath = join(directory, "pilot.json");
  await writeFile(manifestPath, JSON.stringify({
    schema: "foursday-pilot-evidence/v1",
    candidateSha,
    entries,
  }), { mode: 0o600 });
  const calls = [];
  const validFetch = async (input, options) => {
    const url = new URL(input);
    calls.push({ url: url.toString(), options });
    const issue = url.pathname.match(/\/issues\/([1-9][0-9]*)$/u);
    const pull = url.pathname.match(/\/pulls\/([1-9][0-9]*)$/u);
    const index = Number((issue ?? pull)?.[1]);
    const record = records.get(index);
    if (issue && record) return new Response(JSON.stringify({
      number: index,
      html_url: `https://github.com/ruiwang20010702/foursday/issues/${index}`,
      state: "open",
      title: record.task.issueTitle,
      body: record.task.issueBody,
    }), { status: 200 });
    if (pull && record) return new Response(JSON.stringify({
      number: index,
      html_url: `https://github.com/ruiwang20010702/foursday/pull/${index}`,
      state: "open",
      draft: true,
      title: record.task.prTitle,
      body: `${record.prBody}\n`,
      head: {
        ref: `foursday/self-${index}`,
        sha: index.toString(16).padStart(40, "0"),
        repo: { full_name: record.sourceRepository },
      },
      base: { ref: "main", repo: { full_name: "ruiwang20010702/foursday" } },
    }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const result = await verifyPilotTargetReadback(manifestPath, {
    candidateSha,
    fetchImpl: validFetch,
    githubToken: "rate-limit-token",
  });
  assert.deepEqual(result, {
    valid: true,
    schema: "foursday-pilot-target-readback/v1",
    candidateSha,
    verifiedTargets: 20,
    verifiedIssues: 20,
    verifiedDraftPullRequests: 20,
    targetReadbackReverificationRequired: false,
    identitiesEmitted: false,
    targetContentsEmitted: false,
    externalSystemsModified: false,
  });
  assert.equal(calls.length, 40);
  assert.ok(calls.every(({ url }) => url.startsWith("https://api.github.com/repos/ruiwang20010702/foursday/")));
  assert.ok(calls.every(({ options }) => options.redirect === "error"));
  assert.ok(calls.every(({ options }) => options.headers.Authorization === "Bearer rate-limit-token"));
  assert.doesNotMatch(JSON.stringify(result), /tester-|Approved synthetic|github\.com\/ruiwang/u);

  const maintainerManifestPath = join(directory, "maintainer.json");
  await writeFile(maintainerManifestPath, JSON.stringify({
    schema: "foursday-pilot-evidence/v1",
    candidateSha,
    entries: entries.slice(0, 10),
  }), { mode: 0o600 });
  const maintainerLocal = await verifyMaintainerEvidence(maintainerManifestPath, {
    candidateSha,
  });
  const maintainerTargets = await verifyMaintainerTargetReadback(maintainerManifestPath, {
    candidateSha,
    fetchImpl: validFetch,
  });
  assert.equal(maintainerLocal.selfLoops, 10);
  assert.equal(maintainerLocal.externalTesters, 0);
  assert.equal(maintainerTargets.verifiedTargets, 10);

  await assert.rejects(() => verifyPilotTargetReadback(manifestPath, {
    candidateSha,
    fetchImpl: async (input, options) => {
      const response = await validFetch(input, options);
      const url = new URL(input);
      if (!url.pathname.endsWith("/issues/1")) return response;
      const value = await response.json();
      return new Response(JSON.stringify({ ...value, body: `${value.body}\ntampered` }), { status: 200 });
    },
  }), /Issue online readback does not match/u);

  await assert.rejects(() => verifyPilotTargetReadback(manifestPath, {
    candidateSha,
    fetchImpl: async (input, options) => {
      const response = await validFetch(input, options);
      const url = new URL(input);
      if (!url.pathname.endsWith("/pulls/1")) return response;
      const value = await response.json();
      return new Response(JSON.stringify({ ...value, draft: false }), { status: 200 });
    },
  }), /Draft PR online readback does not match/u);
});

test("增长证据从第一位真实用户起计数但不会降低首发十加十门禁", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-growth-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "evidence"));
  const entries = [];
  for (const [index, cohort, participantAlias] of [
    [1, "self", "maintainer"],
    [2, "external", "tester-1"],
  ]) {
    const evidencePath = `evidence/run-${index}.json`;
    await writeFile(join(directory, evidencePath), JSON.stringify(evidence(index)));
    entries.push({
      cohort,
      participantAlias,
      evidencePath,
      reproducedFromQuickStart: true,
      ...(cohort === "external" ? { feedback: "The approval step was clear." } : {}),
    });
  }
  const manifestPath = join(directory, "growth.json");
  await writeFile(manifestPath, JSON.stringify({
    schema: "foursday-pilot-evidence/v1",
    candidateSha: "a".repeat(40),
    entries,
  }));
  const result = await verifyGrowthEvidence(manifestPath);
  assert.equal(result.valid, true);
  assert.equal(result.selfLoops, 1);
  assert.equal(result.externalTesters, 1);
  assert.equal(result.distinctVerifiedClosedLoopUsers, 2);
  await assert.rejects(
    () => verifyPilotEvidence(manifestPath, { candidateSha: "a".repeat(40) }),
    /10 verified self-use loops/u,
  );

  await writeFile(manifestPath, JSON.stringify({
    schema: "foursday-pilot-evidence/v1",
    entries: [{
      ...entries[0],
      participantAlias: "maintainer-one",
    }, {
      ...entries[0],
      participantAlias: "maintainer-two",
      evidencePath: entries[1].evidencePath,
    }],
  }));
  await assert.rejects(
    () => verifyGrowthEvidence(manifestPath),
    /one stable maintainer alias/u,
  );

  await writeFile(manifestPath, JSON.stringify({
    schema: "foursday-pilot-evidence/v1",
    entries: [entries[0], { ...entries[1], participantAlias: entries[0].participantAlias }],
  }));
  await assert.rejects(
    () => verifyGrowthEvidence(manifestPath),
    /aliases must be disjoint/u,
  );
});

test("严格首发验证命令必须同时提供清单和不可变候选", async () => {
  await assert.rejects(
    () => runPilotEvidenceVerification({ args: ["--manifest", "pilot.json"] }),
    /Usage/u,
  );
  await assert.rejects(
    () => runPilotEvidenceVerification({
      args: ["--manifest", "pilot.json", "--sha", "main"],
    }),
    /40 lowercase hexadecimal/u,
  );
});

test("维护者阶段命令在邀请外部用户前同时验证十次本地证据和在线目标", async () => {
  const candidateSha = "a".repeat(40);
  const observed = [];
  const writes = [];
  const result = await runMaintainerEvidenceVerification({
    args: ["--manifest", "./private/maintainer.json", "--sha", candidateSha],
    output: { write: (value) => writes.push(value) },
    environment: { GH_TOKEN: "rate-limit-token", UNRELATED_SECRET: "do-not-forward" },
    verifyLocal: async (path, options) => {
      observed.push({ kind: "local", path, options });
      return {
        valid: true,
        schema: "foursday-pilot-evidence/v1",
        candidateSha,
        selfLoops: 10,
        externalTesters: 0,
        verifiedLoops: 10,
        localIntegrityVerified: true,
        targetReadbackReverificationRequired: true,
      };
    },
    verifyTargets: async (path, options) => {
      observed.push({ kind: "targets", path, options });
      return {
        valid: true,
        schema: "foursday-pilot-target-readback/v1",
        candidateSha,
        verifiedTargets: 10,
        targetReadbackReverificationRequired: false,
        identitiesEmitted: false,
        targetContentsEmitted: false,
        externalSystemsModified: false,
      };
    },
  });
  assert.equal(result.verifiedMaintainerLoops, 10);
  assert.equal(result.verifiedTargets, 10);
  assert.equal(result.identitiesEmitted, false);
  assert.equal(result.productionWrite, false);
  assert.equal(observed[0].options.candidateSha, candidateSha);
  assert.deepEqual(observed[1].options, {
    candidateSha,
    githubToken: "rate-limit-token",
  });
  assert.doesNotMatch(JSON.stringify({ result, observed: observed.map(({ kind }) => kind) }), /rate-limit-token|do-not-forward/u);
  assert.deepEqual(JSON.parse(writes.join("")), result);
  await assert.rejects(
    () => runMaintainerEvidenceVerification({ args: ["--manifest", "pilot.json"] }),
    /Usage/u,
  );
});
