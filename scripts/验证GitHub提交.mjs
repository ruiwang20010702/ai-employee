import {
  verifyGitHubCommit,
  verifyGitHubReleaseCommit,
} from "../src/github-ci-verifier.mjs";

try {
  const refIndex = process.argv.indexOf("--ref");
  const releaseShaIndex = process.argv.indexOf("--release-sha");
  if (refIndex >= 0 && releaseShaIndex >= 0) {
    throw new Error("--ref 和 --release-sha 不能同时使用");
  }
  const ref = refIndex >= 0 ? process.argv[refIndex + 1] : undefined;
  const result = releaseShaIndex >= 0
    ? verifyGitHubReleaseCommit({ sha: process.argv[releaseShaIndex + 1] })
    : verifyGitHubCommit({ ref });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ valid: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
