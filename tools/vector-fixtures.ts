// Public interoperability fixtures. No real part, measurements, credentials or approvals.
import { readFileSync } from "node:fs";
import { canonicalJson, canonicalSha256 } from "../src/core/canonical";
import { parseJson } from "../src/core/json";

// RFC 8785 Appendix B: IEEE-754 bits and independently specified expected text.
export const NUMBER_SAMPLES: readonly [string, string][] = [
  ["0000000000000000", "0"], ["8000000000000000", "0"],
  ["0000000000000001", "5e-324"], ["8000000000000001", "-5e-324"],
  ["7fefffffffffffff", "1.7976931348623157e+308"], ["ffefffffffffffff", "-1.7976931348623157e+308"],
  ["4340000000000000", "9007199254740992"], ["c340000000000000", "-9007199254740992"],
  ["4430000000000000", "295147905179352830000"],
  ["44b52d02c7e14af5", "9.999999999999997e+22"], ["44b52d02c7e14af6", "1e+23"], ["44b52d02c7e14af7", "1.0000000000000001e+23"],
  ["444b1ae4d6e2ef4e", "999999999999999700000"], ["444b1ae4d6e2ef4f", "999999999999999900000"], ["444b1ae4d6e2ef50", "1e+21"],
  ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"], ["3eb0c6f7a0b5ed8d", "0.000001"],
  ["41b3de4355555553", "333333333.3333332"], ["41b3de4355555554", "333333333.33333325"],
  ["41b3de4355555555", "333333333.3333333"], ["41b3de4355555556", "333333333.3333334"], ["41b3de4355555557", "333333333.33333343"],
  ["becbf647612f3696", "-0.0000033333333333333333"], ["43143ff3c1cb0959", "1424953923781206.2"],
];

export async function buildVectors() {
  const inputs: { id: string; input: string; ieee754Hex?: string }[] = [
    { id: "rfc-8785-primitives", input: String.raw`{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/","literals":[null,true,false]}` },
    { id: "rfc-8785-utf16-sort", input: String.raw`{"\u20ac":"Euro Sign","\r":"Carriage Return","\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\ud83d\ude00":"Emoji: Grinning Face","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis"}` },
    { id: "negative-zero-text", input: "-0" },
    { id: "nested-key-order", input: ' { "b": [1, {"y":2,"x":1}], "a":"t" } ' },
    { id: "nested-key-order-equivalent", input: '{"a":"t","b":[1,{"x":1,"y":2}]}' },
    { id: "unicode-not-normalized", input: '{"composed":"é","decomposed":"e\\u0301"}' },
    ...NUMBER_SAMPLES.map(([ieee754Hex, input]) => ({ id: `number-${ieee754Hex}`, input, ieee754Hex })),
  ];
  const ledger = parseJson(readFileSync("samples/lab/ledgers/SN-0001.ledger.json", "utf8")) as { entries: { record: unknown }[] };
  inputs.push({ id: "synthetic-workflow-record", input: JSON.stringify(ledger.entries[0]!.record) });
  const accepted = await Promise.all(inputs.map(async (v) => {
    const value = parseJson(v.input);
    return { ...v, canonical: canonicalJson(value), sha256: await canonicalSha256(value) };
  }));
  return {
    schema: "tdp-canonical-json-vectors/0.1",
    description: "Synthetic interoperability fixtures, not real engineering evidence. input is raw JSON text; hash canonical UTF-8 bytes with no BOM or trailing newline. Parsing duplicate names must fail before hashing.",
    sources: ["https://www.rfc-editor.org/rfc/rfc8785.html#section-3.2.2", "https://www.rfc-editor.org/rfc/rfc8785.html#section-3.2.3", "https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B"],
    accepted,
    rejected: [
      { id: "duplicate-member", input: '{"outcome":"accept","outcome":"reject"}', phase: "parse", reason: "duplicate member name" },
      { id: "escaped-duplicate-member", input: '{"a":1,"\\u0061":2}', phase: "parse", reason: "duplicate member name" },
      { id: "lone-high-surrogate", input: '"\\ud800"', phase: "parse", reason: "lone UTF-16 surrogate" },
      { id: "lone-low-surrogate-key", input: '{"\\udc00":1}', phase: "parse", reason: "lone UTF-16 surrogate" },
      { id: "depth-65", input: "[".repeat(65) + "0" + "]".repeat(65), phase: "parse", reason: "nests deeper than 64" },
      { id: "non-finite-overflow", input: "1e400", phase: "canonicalize", reason: "non-finite number" },
      { id: "invalid-json", input: '{"a":}', phase: "parse", reason: "not valid JSON" },
    ],
  };
}

export const vectorsText = async () => JSON.stringify(await buildVectors(), null, 2) + "\n";
