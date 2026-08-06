import { verifyRollbackCompatibility } from "../src/rollback-compatibility.mjs";

try {
  console.log(JSON.stringify(await verifyRollbackCompatibility(), null, 2));
} catch (error) {
  console.error(JSON.stringify({ valid: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
