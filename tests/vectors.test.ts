import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/core/canonical";
import { parseJson } from "../src/core/json";
import { WorkflowRecord } from "../src/core/records";
import { buildVectors, NUMBER_SAMPLES, vectorsText } from "../tools/vector-fixtures";

describe("shared interoperability vectors", () => {
  it("reproduces the published file byte for byte", async () => {
    expect(await vectorsText()).toBe(readFileSync("samples/vectors/canonical-json.json", "utf8"));
  });
  it("matches the independently specified RFC Appendix B number strings", () => {
    for (const [bits, expected] of NUMBER_SAMPLES) {
      expect(canonicalJson(Buffer.from(bits, "hex").readDoubleBE())).toBe(expected);
    }
    for (const bits of ["7fffffffffffffff", "7ff0000000000000", "fff0000000000000"]) {
      expect(() => canonicalJson(Buffer.from(bits, "hex").readDoubleBE())).toThrow(/non-finite/);
    }
  });
  it("publishes UTF-8 hashes and a schema-valid synthetic workflow record", async () => {
    const { accepted } = await buildVectors();
    for (const v of accepted) expect(createHash("sha256").update(v.canonical, "utf8").digest("hex")).toBe(v.sha256);
    const record = accepted.find((v) => v.id === "synthetic-workflow-record")!;
    expect(WorkflowRecord.safeParse(parseJson(record.input)).success).toBe(true);
    expect(accepted.find((v) => v.id === "nested-key-order")!.sha256).toBe(accepted.find((v) => v.id === "nested-key-order-equivalent")!.sha256);
  });
  it("refuses every published negative input at the stated boundary", async () => {
    for (const v of (await buildVectors()).rejected) {
      if (v.phase === "parse") expect(() => parseJson(v.input)).toThrow(v.reason);
      else expect(() => canonicalJson(parseJson(v.input))).toThrow(v.reason);
    }
  });
});
