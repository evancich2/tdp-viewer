// Command-line verifier: npm run tdp -- verify <package.tdp> --trust <trust-store.json>
import { readFileSync } from "node:fs";
import { defaultPolicy } from "../src/core/policy";
import { loadTrustStore, verifyPackage } from "../src/core/verify";

const [command, file, flag, trustPath] = process.argv.slice(2);
if (command !== "verify" || !file || flag !== "--trust" || !trustPath) {
  console.error("usage: tdp verify <package.tdp> --trust <trust-store.json>");
  process.exit(2);
}

const store = await loadTrustStore(readFileSync(trustPath, "utf8"));
const result = await verifyPackage(new Uint8Array(readFileSync(file)), store, defaultPolicy);
for (const c of result.checks) console.log(`${c.status === "pass" ? "PASS" : "FAIL"}  ${c.id}  ${c.message}`);
for (const f of result.files.filter((f) => !f.ok)) console.log(`      ${f.path}: ${f.problems.join("; ")}`);
console.log(result.verdict.toUpperCase());
process.exit(result.verdict === "trusted" ? 0 : 1);
