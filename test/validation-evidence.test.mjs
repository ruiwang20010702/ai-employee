import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  pilotEvidenceHelp,
  runPilotEvidenceVerification,
  verifyPilotEvidence,
} from "../scripts/验证体验证据.mjs";
import {
  sealValidationEvidence,
  validateValidationEvidence,
  validationEvidenceCapabilities,
} from "../src/validation-evidence.mjs";

test("pilot verification help is English and exits before reading local files", async () => {
  const chunks = [];
  const result = await runPilotEvidenceVerification({
    args: ["--manifest", "/manifest-and-evidence-must-not-be-read.json", "--help"],
    output: { write: (chunk) => chunks.push(chunk) },
  });
  const output = chunks.join("");

  assert.equal(result, null);
  assert.equal(output, pilotEvidenceHelp);
  assert.match(output, /Usage:\n  npm run pilot:verify -- --manifest/u);
  assert.match(output, /Help exits before reading a manifest or evidence file\./u);
  assert.match(output, /Verification is local only/u);
  assert.match(output, /online GitHub target re-read remains a separate required step\./u);
  assert.doesNotMatch(output, /[^\x00-\x7F]/u);
});

function evidence(index = 1, { confirmed = true } = {}) {
  const hex = index.toString(16);
  const commit = hex.padStart(40, "0");
  const planHash = hex.padStart(64, "0");
  return sealValidationEvidence({
    schema: "foursday-validation-evidence/v1",
    validationStatus: confirmed ? "verified_closed_loop" : "awaiting_outcome_confirmation",
    generatedAt: "2026-08-12T00:00:00.000Z",
    project: { id: "foursday", repository: "example/foursday", startingCommit: commit },
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
  });
}

test("validation evidence requires an intact confirmed five-step closed loop", () => {
  const valid = evidence();
  const summary = validateValidationEvidence(valid);
  assert.equal(summary.confirmed, true);
  assert.equal(summary.draftPrUrl, "https://github.com/example/foursday/pull/1");
  assert.equal(summary.draftPrNumber, 1);
  assert.equal(summary.draftPrHead, "foursday/self-1");
  assert.equal(summary.draftPrBase, "main");
  assert.equal(summary.draftPrState, "OPEN");
  assert.equal(summary.draftPrIsDraft, true);
  assert.throws(
    () => validateValidationEvidence(evidence(2, { confirmed: false })),
    /not a confirmed closed loop/u,
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
