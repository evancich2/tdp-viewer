// Writes samples/sample.tdp (rev B), samples/sample-rev-c.tdp, samples/tampered.tdp and samples/trust-store.json.
// Signing keys are generated in memory and thrown away; only public keys are written.
import { mkdirSync, writeFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { utf8 } from "../src/core/bytes";
import { buildPackage } from "../src/core/pack";
import type { TrustStore } from "../src/core/schema";
import { generateKeyPair } from "../src/core/signing";
import { sampleContents, type SampleRevision } from "./sample-data";

const now = new Date();
const days = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

const author = await generateKeyPair();
const approver = await generateKeyPair();
const trustStore: TrustStore = {
  schema: "tdp-truststore/0.1",
  keys: [
    { keyId: author.keyId, name: "Sample Author (demo key)", publicKey: author.publicKey, roles: ["author"], notBefore: days(-1), notAfter: days(730), revoked: false },
    { keyId: approver.keyId, name: "Sample Approver (demo key)", publicKey: approver.publicKey, roles: ["approver"], notBefore: days(-1), notAfter: days(730), revoked: false },
  ],
};

const build = (revision: SampleRevision) => {
  const { inputs, bom } = sampleContents(revision);
  return buildPackage(
    {
      id: crypto.randomUUID(),
      title: "Sample Bracket Assembly TDP",
      partNumber: "SMP-1000",
      revision,
      created: now.toISOString(),
      expires: days(365),
      distribution: "Synthetic sample data. Not a real part.",
    },
    inputs,
    bom,
    [
      { ...author, role: "author" },
      { ...approver, role: "approver" },
    ],
    now,
  );
};
const tdp = await build("B");
const revC = await build("C");

// A copy with one drawing altered after signing, to show what rejection looks like.
const files = unzipSync(tdp);
files["drawings/SMP-1001_A.pdf"] = utf8.encode(utf8.decode(files["drawings/SMP-1001_A.pdf"]!).replace("REV A", "REV X"));
const tampered = zipSync(files);

mkdirSync("samples", { recursive: true });
writeFileSync("samples/sample.tdp", tdp);
writeFileSync("samples/tampered.tdp", tampered);
writeFileSync("samples/sample-rev-c.tdp", revC);
writeFileSync("samples/trust-store.json", JSON.stringify(trustStore, null, 2) + "\n");
console.log("wrote samples/sample.tdp, samples/sample-rev-c.tdp, samples/tampered.tdp, samples/trust-store.json");
