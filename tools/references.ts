// Read-only, local exact-identity review. Never retrieves URLs or contacts a printer/PLM.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultPolicy } from "../src/core/policy";
import { reviewReferences } from "../src/core/references";
import { loadAnchors, loadTrustStoreFile } from "../src/core/truststore";
import { verifyPackage } from "../src/core/verify";
async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      target: { type: "string", multiple: true },
      trust: { type: "string" },
      anchors: { type: "string" },
      at: { type: "string" },
    },
  });
  if (!values.source || !values.trust)
    throw new Error(
      "usage: npm run references -- --source source.tdp --trust trust.json [--anchors roots.json] [--target target.tdp ...] [--at ISO-time]",
    );
  if ((values.target?.length ?? 0) > 128)
    throw new Error("at most 128 target packages");
  const at = values.at ? new Date(values.at) : new Date();
  if (!Number.isFinite(at.getTime()))
    throw new Error("--at must be an ISO time");
  const { store } = await loadTrustStoreFile(
    readFileSync(values.trust, "utf8"),
    {
      anchors: values.anchors
        ? await loadAnchors(readFileSync(values.anchors, "utf8"))
        : undefined,
      now: at,
    },
  );
  const load = (path: string) =>
    verifyPackage(new Uint8Array(readFileSync(path)), store, defaultPolicy, at);
  const source = await load(values.source),
    targets = await Promise.all((values.target ?? []).map(load));
  const references = reviewReferences(source, targets);
  console.log(
    JSON.stringify(
      { mode: "READ-ONLY IDENTITY REVIEW", authorized: false, references },
      null,
      2,
    ),
  );
  if (references.some((r) => r.status === "held")) process.exitCode = 2;
}
main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
