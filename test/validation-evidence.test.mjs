import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyPilotEvidence } from "../scripts/验证体验证据.mjs";
import {
  createPublicPilotProof,
  publicPilotProofMarkdown,
  sealValidationEvidence,
  validatePublicPilotProof,
  validateValidationEvidence,
  validationEvidenceCapabilities,
} from "../src/validation-evidence.mjs";

function evidence(index = 1, { confirmed = true } = {}) {
  const hex = index.toString(16);
  const commit = hex.padStart(40, "0");
  const planHash = hex.padStart(64, "0");
  return sealValidationEvidence({
    schema: "foursday-validation-evidence/v1",
    validationStatus: confirmed ? "verified_closed_loop" : "awaiting_outcome_confirmation",
    generatedAt: "2026-08-12T00:00:00.000Z",
    project: {
      id: "foursday",
      repository: "example/foursday",
      sourceRepository: "example/foursday",
      startingCommit: commit,
    },
    issue: { url: `https://github.com/example/foursday/issues/${index}`, number: index },
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
        ? `https://github.com/example/foursday/pull/${index}`
        : null,
      head: capability === "github_pr_draft" ? `foursday/self-${index}` : null,
      headRepository: capability === "github_pr_draft" ? "example/foursday" : null,
      base: capability === "github_pr_draft" ? "main" : null,
      state: capability === "github_pr_draft" ? "OPEN" : null,
      isDraft: capability === "github_pr_draft" ? true : null,
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
  for (let index = 1; index <= 20; index += 1) {
    const file = `evidence/run-${String(index).padStart(2, "0")}.json`;
    await writeFile(join(directory, file), `${JSON.stringify(evidence(index), null, 2)}\n`, { mode: 0o600 });
    const external = index > 10;
    entries.push({
      cohort: external ? "external" : "self",
      participantAlias: external ? `tester-${index - 10}` : "maintainer",
      evidencePath: file,
      reproducedFromQuickStart: true,
      ...(external ? { feedback: `Synthetic feedback ${index}` } : {}),
    });
  }
  const manifestPath = join(directory, "pilot.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "foursday-pilot-evidence/v1",
    entries,
  }, null, 2)}\n`, { mode: 0o600 });
  const result = await verifyPilotEvidence(manifestPath);
  assert.equal(result.valid, true);
  assert.equal(result.selfLoops, 10);
  assert.equal(result.externalTesters, 10);
  assert.equal(result.confirmedReturnedMinutes, 600);
  assert.equal(result.targetReadbackReverificationRequired, true);
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "foursday-pilot-evidence/v1",
    entries: entries.slice(0, 19),
  })}\n`);
  await assert.rejects(() => verifyPilotEvidence(manifestPath), /10 verified external testers/u);
});
