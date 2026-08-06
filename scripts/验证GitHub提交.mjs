import { verifyGitHubCommit } from "../src/github-ci-verifier.mjs";

try {
  const refIndex = process.argv.indexOf("--ref");
  const ref = refIndex >= 0 ? process.argv[refIndex + 1] : undefined;
  console.log(JSON.stringify(verifyGitHubCommit({ ref }), null, 2));
} catch (error) {
  console.error(JSON.stringify({ valid: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
