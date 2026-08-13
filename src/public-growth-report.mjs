import { createHash } from "node:crypto";

const REPOSITORY = "ruiwang20010702/foursday";
const OWNER = "ruiwang20010702";
const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`;
const MAX_RESPONSE_BYTES = 2_000_000;

function exactSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error("Public growth report requires a complete 40-character candidate SHA");
  }
  return normalized;
}

function boundedText(value, maximum = 100_000) {
  const normalized = String(value ?? "");
  return normalized.length <= maximum ? normalized : "";
}

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "foursday-public-growth-report",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return Object.freeze(headers);
}

async function publicJson(fetchImpl, url, token) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com") {
    throw new Error("Public growth report only reads the GitHub public API");
  }
  const response = await fetchImpl(parsed, {
    headers: githubHeaders(token),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response?.ok) {
    throw new Error(`GitHub public API returned HTTP ${Number(response?.status) || 0}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("GitHub public API response exceeded the bounded report size");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GitHub public API returned invalid JSON");
  }
}

async function publicPages(fetchImpl, path, { maximumPages = 10, token = null } = {}) {
  const values = [];
  for (let page = 1; page <= maximumPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const result = await publicJson(
      fetchImpl,
      `${API_ROOT}${path}${separator}per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(result)) throw new Error("GitHub public API pagination shape is invalid");
    values.push(...result);
    if (result.length < 100) return values;
  }
  throw new Error("GitHub public API pagination exceeded the bounded page limit");
}

function exactLine(body, label, expected) {
  return body.split(/\r?\n/u).some((line) => line.trim() === `- ${label}: ${expected}`);
}

function privacySafeFriction(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "__" || text.length > 500) return false;
  const userDirectory = "User" + "s";
  return !new RegExp([
    "(?:https?|ssh|git)://",
    `(?:^|\\s)(?:/${userDirectory}/|/home/|~/|[A-Za-z]:\\\\${userDirectory}\\\\)`,
    "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}",
    "(?:gh[pousr]_|github_pat_|sk-[A-Za-z0-9_-]{12,}|Bearer\\s+[A-Za-z0-9._~+/-]{8,})",
    "(?:password|passwd|api[_ -]?key|access[_ -]?token|secret)\\s*[:=]\\s*\\S+",
    "(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis)://",
    "-----BEGIN [A-Z ]+PRIVATE KEY-----",
  ].join("|"), "iu").test(text);
}

export function validSetupCheckin(comment, { candidateSha, owner = OWNER } = {}) {
  const sha = exactSha(candidateSha);
  if (!comment || typeof comment !== "object" || Array.isArray(comment)) return false;
  const login = String(comment.user?.login ?? "").trim().toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u.test(login) ||
    login === owner.toLowerCase() ||
    comment.user?.type !== "User"
  ) return false;
  const body = boundedText(comment.body, 20_000);
  const nonEmptyLines = body.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (
    nonEmptyLines.length !== 11 ||
    nonEmptyLines[0] !== "### Foursday v0.5 setup check-in"
  ) return false;
  if (!exactLine(body, "immutable candidate", sha)) return false;
  if (!/^\s*- Node\.js: (?:22|24)\s*$/mu.test(body)) return false;
  if (!/^\s*- platform: (?:macOS|Linux)\s*$/mu.test(body)) return false;
  for (const label of [
    "loopback Web page opened",
    "read-only readiness check completed",
  ]) if (!exactLine(body, label, "yes")) return false;
  for (const label of [
    "fork, branch, push, or PR created by this readiness check",
    "production deployment performed by this launch or readiness check",
    "automatic sending, execution, or proactive work enabled by this launch or readiness check",
  ]) if (!exactLine(body, label, "no")) return false;
  const setupMinutes = body.match(/^\s*- approximate setup time: ([0-9]{1,3}) minutes\s*$/mu);
  if (!setupMinutes || Number(setupMinutes[1]) > 600) return false;
  const friction = body.match(/^\s*- one friction point or none: (.+)\s*$/mu)?.[1]?.trim();
  return privacySafeFriction(friction);
}

export function countValidSetupCheckins(comments, options) {
  const identities = new Set();
  for (const comment of Array.isArray(comments) ? comments : []) {
    if (!validSetupCheckin(comment, options)) continue;
    identities.add(String(comment.user.login).trim().toLowerCase());
  }
  return identities.size;
}

export function countVerifiedExternalLoops(issueBody) {
  const body = boundedText(issueBody);
  const checked = new Set();
  for (const match of body.matchAll(/^\s*- \[[xX]\] external loop (0[1-9]|10)\s*$/gmu)) {
    checked.add(match[1]);
  }
  return checked.size;
}

export function countExternalPilotStarts(comments, { owner = OWNER } = {}) {
  const identities = new Set();
  for (const comment of Array.isArray(comments) ? comments : []) {
    const login = String(comment?.user?.login ?? "").trim().toLowerCase();
    if (
      comment?.user?.type !== "User" ||
      !login ||
      login === owner.toLowerCase() ||
      String(comment.body ?? "").trim() !== "I started the pilot"
    ) continue;
    identities.add(login);
  }
  return identities.size;
}

function candidateMatchesIssue(body, candidateSha) {
  const value = boundedText(body);
  const observed = new Set(
    [...value.matchAll(/(?<![a-f0-9])[a-f0-9]{40}(?![a-f0-9])/gu)].map((match) => match[0]),
  );
  return observed.size === 1 && observed.has(candidateSha);
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const normalized = parsed.toISOString();
  return normalized === value || normalized.replace(/\.000Z$/u, "Z") === value;
}

function mergedExternalPull(pull, {
  defaultBranch,
  owner = OWNER,
} = {}) {
  const login = String(pull?.user?.login ?? "").trim().toLowerCase();
  return (
    pull?.user?.type === "User" &&
    Boolean(login) &&
    login !== owner.toLowerCase() &&
    pull?.base?.ref === defaultBranch &&
    canonicalTimestamp(pull.merged_at)
  );
}

export function summarizeMergedExternalPulls(pulls, {
  defaultBranch,
  owner = OWNER,
} = {}) {
  const branch = String(defaultBranch ?? "").trim();
  if (!/^[A-Za-z0-9._/-]{1,200}$/u.test(branch)) {
    throw new Error("Merged pull request summary default branch is invalid");
  }
  const contributors = new Set();
  let communityRecipesOrAdapters = 0;
  for (const pull of Array.isArray(pulls) ? pulls : []) {
    const login = String(pull?.user?.login ?? "").trim().toLowerCase();
    if (!mergedExternalPull(pull, { defaultBranch: branch, owner })) continue;
    contributors.add(login);
    const labels = new Set(
      (Array.isArray(pull.labels) ? pull.labels : [])
        .map((entry) => String(entry?.name ?? "").trim().toLowerCase())
        .filter(Boolean),
    );
    if (
      labels.has("community-extension") ||
      labels.has("recipe") ||
      labels.has("adapter")
    ) communityRecipesOrAdapters += 1;
  }
  return Object.freeze({
    mergedExternalContributors: contributors.size,
    maintainerAttestedCommunityRecipesOrAdapters: communityRecipesOrAdapters,
  });
}

function verifiedCommunityEvidence(value, candidateSha) {
  if (value === null || value === undefined) return null;
  if (
    value?.valid !== true ||
    value.schema !== "foursday-community-extension-evidence/v1" ||
    value.candidateSha !== candidateSha ||
    value.localIntegrityVerified !== true ||
    value.targetReadbackReverificationRequired !== true ||
    value.contributorIdentitiesEmitted !== false ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    value.entries.length > 20 ||
    value.verifiedCommunityRecipesOrAdapters !== value.entries.length
  ) throw new Error("Local community extension evidence verification is invalid");
  const entries = value.entries.map((entry, index) => {
    const kind = entry?.kind;
    const directory = kind === "recipe" ? "recipes" : kind === "adapter" ? "adapters" : null;
    const extensionId = String(entry?.extensionId ?? "");
    const extensionPath = String(entry?.extensionPath ?? "");
    const contentSha256 = String(entry?.contentSha256 ?? "");
    if (
      !directory ||
      !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(extensionId) ||
      !new RegExp(`^examples/${directory}/[a-z0-9][a-z0-9._-]{0,199}\\.json$`, "u").test(extensionPath) ||
      !/^[a-f0-9]{64}$/u.test(contentSha256) ||
      !Number.isSafeInteger(entry?.pullNumber) ||
      entry.pullNumber < 1 ||
      entry.pullNumber > 1_000_000_000
    ) throw new Error(`Local community extension evidence entry ${index} is invalid`);
    return Object.freeze({
      kind,
      extensionId,
      extensionPath,
      contentSha256,
      pullNumber: entry.pullNumber,
    });
  });
  for (const values of [
    entries.map((entry) => entry.extensionId),
    entries.map((entry) => entry.extensionPath),
    entries.map((entry) => entry.pullNumber),
  ]) {
    if (new Set(values).size !== values.length) {
      throw new Error("Local community extension evidence entries must be unique");
    }
  }
  return entries;
}

function candidateContentSha256(value, expectedPath) {
  if (
    value?.type !== "file" ||
    value?.path !== expectedPath ||
    !/^[a-f0-9]{40}$/u.test(String(value?.sha ?? "")) ||
    value?.encoding !== "base64" ||
    typeof value.content !== "string" ||
    !/^[A-Za-z0-9+/=\r\n]+$/u.test(value.content) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > 128 * 1024
  ) throw new Error("GitHub candidate extension content is invalid");
  const compact = value.content.replace(/\s+/gu, "");
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length !== value.size || bytes.toString("base64") !== compact) {
    throw new Error("GitHub candidate extension content encoding is invalid");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export function countVerifiedCommunityExtensions(
  entries,
  pulls,
  filesByPull,
  candidateContentsByPath,
  {
    defaultBranch,
    owner = OWNER,
  } = {},
) {
  if (entries === null) return null;
  const pullsByNumber = new Map(
    (Array.isArray(pulls) ? pulls : []).map((pull) => [pull?.number, pull]),
  );
  for (const entry of entries) {
    const pull = pullsByNumber.get(entry.pullNumber);
    if (!mergedExternalPull(pull, { defaultBranch, owner })) {
      throw new Error("Community extension evidence PR is not an external merge to the default branch");
    }
    const labels = new Set(
      (Array.isArray(pull.labels) ? pull.labels : [])
        .map((label) => String(label?.name ?? "").trim().toLowerCase()),
    );
    if (!labels.has("community-extension") && !labels.has(entry.kind)) {
      throw new Error("Community extension evidence PR is missing its reviewed extension label");
    }
    const files = filesByPull.get(entry.pullNumber);
    const changedFile = Array.isArray(files)
      ? files.find((file) => file?.filename === entry.extensionPath && file?.status !== "removed")
      : null;
    if (!changedFile) {
      throw new Error("Community extension evidence PR does not contain the validated extension file");
    }
    const candidateContent = candidateContentsByPath.get(entry.extensionPath);
    if (changedFile.sha !== candidateContent?.sha) {
      throw new Error("Community extension evidence PR file differs from the candidate file");
    }
    if (candidateContentSha256(candidateContent, entry.extensionPath) !== entry.contentSha256) {
      throw new Error("Community extension evidence does not match the candidate file content");
    }
  }
  return entries.length;
}

function nonNegativeCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`GitHub public API ${name} is invalid`);
  }
  return value;
}

function verifiedExternalLoops(value, candidateSha) {
  if (value === null || value === undefined) return null;
  if (
    value?.valid !== true ||
    value.candidateSha !== candidateSha ||
    !Number.isSafeInteger(value.selfLoops) ||
    value.selfLoops < 10 ||
    !Number.isSafeInteger(value.externalTesters) ||
    value.externalTesters < 10
  ) {
    throw new Error("Local pilot evidence verification is invalid or incomplete");
  }
  return value.externalTesters;
}

function verifiedPilotTargets(value, pilotVerification, candidateSha) {
  if (value === null || value === undefined) return null;
  const expectedTargets = pilotVerification?.verifiedLoops;
  if (
    value?.valid !== true ||
    value.schema !== "foursday-pilot-target-readback/v1" ||
    value.candidateSha !== candidateSha ||
    !Number.isSafeInteger(expectedTargets) ||
    expectedTargets < 20 ||
    value.verifiedTargets !== expectedTargets ||
    value.verifiedIssues !== expectedTargets ||
    value.verifiedDraftPullRequests !== expectedTargets ||
    value.targetReadbackReverificationRequired !== false ||
    value.identitiesEmitted !== false ||
    value.targetContentsEmitted !== false ||
    value.externalSystemsModified !== false
  ) throw new Error("Online pilot target readback verification is invalid or incomplete");
  return value.verifiedTargets;
}

function verifiedClosedLoopUsers(value) {
  if (value === null || value === undefined) return null;
  if (
    value?.valid !== true ||
    value.schema !== "foursday-pilot-evidence/v1" ||
    !Number.isSafeInteger(value.verifiedLoops) ||
    !Number.isSafeInteger(value.selfLoops) ||
    !Number.isSafeInteger(value.externalTesters) ||
    !Number.isSafeInteger(value.distinctVerifiedClosedLoopUsers) ||
    value.verifiedLoops !== value.selfLoops + value.externalTesters ||
    value.distinctVerifiedClosedLoopUsers !== value.externalTesters + (value.selfLoops > 0 ? 1 : 0) ||
    value.distinctVerifiedClosedLoopUsers < 1 ||
    value.localIntegrityVerified !== true ||
    value.targetReadbackReverificationRequired !== true
  ) throw new Error("Local closed-loop growth evidence verification is invalid");
  return value.distinctVerifiedClosedLoopUsers;
}

function optionalGitHubToken(value) {
  if (value === null || value === undefined || value === "") return null;
  const token = String(value);
  if (token.length > 1_024 || /[\s\0]/u.test(token)) {
    throw new Error("Optional GitHub API token is invalid");
  }
  return token;
}

export async function buildPublicGrowthReport({
  candidateSha,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  pilotVerification = null,
  pilotTargetVerification = null,
  growthVerification = null,
  extensionVerification = null,
  githubToken = null,
} = {}) {
  const sha = exactSha(candidateSha);
  const token = optionalGitHubToken(githubToken);
  const verifiedExtensionEntries = verifiedCommunityEvidence(extensionVerification, sha);
  if (typeof fetchImpl !== "function") throw new Error("Public growth report requires fetch");
  const repository = await publicJson(fetchImpl, API_ROOT, token);
  if (repository.full_name?.toLowerCase() !== REPOSITORY || repository.private !== false) {
    throw new Error("Public growth report repository identity is invalid");
  }
  const defaultBranch = String(repository.default_branch ?? "").trim();
  if (!/^[A-Za-z0-9._/-]{1,200}$/u.test(defaultBranch)) {
    throw new Error("Public growth report default branch is invalid");
  }
  const [issue49, issue50, pilotComments, setupComments, closedPulls, comparison] = await Promise.all([
    publicJson(fetchImpl, `${API_ROOT}/issues/49`, token),
    publicJson(fetchImpl, `${API_ROOT}/issues/50`, token),
    publicPages(fetchImpl, "/issues/49/comments", { token }),
    publicPages(fetchImpl, "/issues/50/comments", { token }),
    publicPages(
      fetchImpl,
      `/pulls?state=closed&base=${encodeURIComponent(defaultBranch)}`,
      { token },
    ),
    publicJson(
      fetchImpl,
      `${API_ROOT}/compare/${sha}...${encodeURIComponent(defaultBranch)}`,
      token,
    ),
  ]);
  const issue49Open = issue49.number === 49 && issue49.state === "open";
  const issue50Open = issue50.number === 50 && issue50.state === "open";
  const issue49CandidateMatches = candidateMatchesIssue(issue49.body, sha);
  const issue50CandidateMatches = candidateMatchesIssue(issue50.body, sha);
  const candidateVisibleFromDefault = comparison.merge_base_commit?.sha === sha;
  const maintainerAttestedExternalLoops = countVerifiedExternalLoops(issue49.body);
  const locallyVerifiedExternalLoops = verifiedExternalLoops(pilotVerification, sha);
  const onlineVerifiedPilotTargets = verifiedPilotTargets(
    pilotTargetVerification,
    pilotVerification,
    sha,
  );
  const locallyVerifiedClosedLoopUsers = verifiedClosedLoopUsers(
    growthVerification ?? pilotVerification,
  );
  const externalPilotStarts = countExternalPilotStarts(pilotComments);
  const successfulExternalSetups = countValidSetupCheckins(setupComments, { candidateSha: sha });
  const contributionSummary = summarizeMergedExternalPulls(closedPulls, { defaultBranch });
  const filesByPull = new Map();
  const candidateContentsByPath = new Map();
  if (verifiedExtensionEntries !== null) {
    await Promise.all(verifiedExtensionEntries.map(async (entry) => {
      const encodedPath = entry.extensionPath.split("/").map(encodeURIComponent).join("/");
      const [pullFiles, candidateContent] = await Promise.all([
        publicPages(fetchImpl, `/pulls/${entry.pullNumber}/files`, {
          maximumPages: 10,
          token,
        }),
        publicJson(fetchImpl, `${API_ROOT}/contents/${encodedPath}?ref=${sha}`, token),
      ]);
      filesByPull.set(entry.pullNumber, pullFiles);
      candidateContentsByPath.set(entry.extensionPath, candidateContent);
    }));
  }
  const locallyVerifiedCommunityExtensions = countVerifiedCommunityExtensions(
    verifiedExtensionEntries,
    closedPulls,
    filesByPull,
    candidateContentsByPath,
    { defaultBranch },
  );
  const broadLaunchReady =
    candidateVisibleFromDefault &&
    locallyVerifiedExternalLoops >= 10 &&
    onlineVerifiedPilotTargets >= 20 &&
    maintainerAttestedExternalLoops >= 10 &&
    issue49Open &&
    issue50Open &&
    issue49CandidateMatches &&
    issue50CandidateMatches;
  const nextGate = maintainerAttestedExternalLoops < 10
    ? locallyVerifiedExternalLoops >= 10
      ? "synchronize_public_cohort_attestation"
      : "complete_10_distinct_external_pilot_loops"
    : locallyVerifiedExternalLoops === null
      ? "verify_external_pilot_manifest"
      : !issue49Open || !issue50Open || !issue49CandidateMatches || !issue50CandidateMatches
        ? "align_public_candidate_entrypoints"
        : onlineVerifiedPilotTargets === null
          ? "verify_pilot_target_readback"
        : !candidateVisibleFromDefault
          ? "publish_candidate_to_default_branch_or_immutable_release"
          : "review_default_branch_or_immutable_release_launch";
  return Object.freeze({
    schema: "foursday-public-growth-report/v1",
    generatedAt: now().toISOString(),
    repository: REPOSITORY,
    defaultBranch,
    immutableCandidateSha: sha,
    current: Object.freeze({
      githubStars: nonNegativeCount(repository.stargazers_count, "stargazers_count"),
      githubForks: nonNegativeCount(repository.forks_count, "forks_count"),
      externalPilotStarts,
      successfulExternalSetups,
      maintainerAttestedExternalPilotLoops: maintainerAttestedExternalLoops,
      locallyVerifiedExternalPilotLoops: locallyVerifiedExternalLoops,
      onlineVerifiedPilotTargets,
      locallyVerifiedClosedLoopUsers,
      ...contributionSummary,
      locallyVerifiedCommunityRecipesOrAdapters: locallyVerifiedCommunityExtensions,
    }),
    entrypoints: Object.freeze({
      issue49Open,
      issue50Open,
      issue49CandidateMatches,
      issue50CandidateMatches,
      candidateVisibleFromDefault,
    }),
    goals: Object.freeze({
      successfulInstallations: 200,
      verifiedClosedLoopUsers: 50,
      externalContributors: 10,
      communityRecipesOrAdapters: 5,
      githubStars: 1_000,
    }),
    broadLaunchReady,
    nextGate,
    safety: Object.freeze({
      readOnly: true,
      credentialsRequired: false,
      apiAuthenticationUsed: Boolean(token),
      identitiesEmitted: false,
      commentBodiesEmitted: false,
      localEvidenceIdentitiesEmitted: false,
      externalSystemsModified: false,
      automaticPublishing: false,
      productionWrite: false,
    }),
  });
}
