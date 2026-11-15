import { describe, expect, it } from "vitest";
import { JsonError, MAX_JSON_DEPTH, canonicalJson, canonicalSha256, loadProcess, loadTrustStoreFile, parseJson } from "../src/core";
import { sha256Hex, utf8 } from "../src/core/bytes";

describe("strict JSON loading", () => {
  it("parses ordinary JSON exactly as JSON.parse does", () => {
    const text = '{"a":[1,2,{"b":null}],"c":"x\\"y","d":{"a":1},"e":[{"k":1},{"k":2}]}';
    expect(parseJson(text)).toEqual(JSON.parse(text));
  });

  it("refuses duplicate member names, at any depth", () => {
    expect(() => parseJson('{"outcome":"accept","outcome":"reject"}')).toThrow(/duplicate member name "outcome"/);
    expect(() => parseJson('{"a":{"b":1,"c":2,"b":3}}')).toThrow(/duplicate member name "b"/);
    expect(() => parseJson('[{"x":1},{"y":2,"y":2}]')).toThrow(/duplicate member name "y"/);
  });

  it("compares member names after unescaping", () => {
    expect(() => parseJson('{"a":1,"\\u0061":2}')).toThrow(/duplicate member name "a"/);
    expect(() => parseJson('{"\\/":1,"/":2}')).toThrow(JsonError);
  });

  it("isn't confused by braces, quotes, commas and escapes inside strings", () => {
    expect(parseJson('{"a":"},{\\"a\\":1","b":"\\\\","c":"[,]"}')).toEqual({ a: '},{"a":1', b: "\\", c: "[,]" });
    expect(parseJson('{"a":"x","b":{"a":"y"}}')).toEqual({ a: "x", b: { a: "y" } });
  });

  it("limits nesting depth", () => {
    const nest = (n: number) => "[".repeat(n) + "]".repeat(n);
    expect(parseJson(nest(MAX_JSON_DEPTH))).toBeDefined();
    expect(() => parseJson(nest(MAX_JSON_DEPTH + 1))).toThrow(/nests deeper than/);
    expect(() => parseJson(nest(100_000))).toThrow(JsonError);
  });

  it("refuses lone surrogates but accepts paired ones", () => {
    expect(() => parseJson('{"a":"\\ud800"}')).toThrow(/lone UTF-16 surrogate/);
    expect(() => parseJson('{"\\udc00":1}')).toThrow(/lone UTF-16 surrogate/);
    expect(parseJson('{"a":"\\ud83d\\ude00"}')).toEqual({ a: "😀" });
  });

  it("reports malformed JSON as a JsonError with the parser's error as its cause", () => {
    let err: unknown;
    try { parseJson("{"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(JsonError);
    expect((err as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it("is what the loaders use: a duplicated key in a process definition or trust store is refused", async () => {
    await expect(loadProcess('{"schema":"tdp-process/0.1","schema":"tdp-process/0.1"}')).rejects.toThrow(/duplicate member name "schema"/);
    await expect(loadTrustStoreFile('{"schema":"tdp-truststore/0.1","keys":[],"keys":[]}')).rejects.toThrow(/duplicate member name "keys"/);
  });
});

describe("canonical JSON is RFC 8785 (JCS)", () => {
  it("matches the RFC 8785 §3.2.2 example", () => {
    // RFC 8785 §3.2.2: input and its canonical form.
    const input = '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", "literals": [null, true, false]}';
    const expected = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
    expect(canonicalJson(parseJson(input))).toBe(expected);
  });

  it("sorts member names by UTF-16 code units (RFC 8785 §3.2.3), not by code points", () => {
    const input = '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}';
    // Read the names straight from the output: Object.keys would list "1" first whatever the text says.
    const out = canonicalJson(parseJson(input));
    const order = [...out.matchAll(/(?:^\{|,)("(?:[^"\\]|\\.)*"):/gu)].map((m) => [...(JSON.parse(m[1]!) as string)].map((c) => c.codePointAt(0)!.toString(16)).join("+"));
    // U+1F600 (UTF-16 D83D DE00) sorts before U+FB33: that is the UTF-16 rule.
    expect(order).toEqual(["d", "31", "80", "f6", "20ac", "1f600", "fb33"]);
    expect(out).toBe('{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}');
  });

  it("serializes numbers in ECMAScript shortest round-trip form", () => {
    const cases: [number, string][] = [[0, "0"], [-0, "0"], [1, "1"], [-1.5, "-1.5"], [1e21, "1e+21"], [1e-7, "1e-7"], [123456789012345680000, "123456789012345680000"], [5e-324, "5e-324"], [Number.MAX_SAFE_INTEGER, "9007199254740991"]];
    for (const [n, s] of cases) expect(canonicalJson(n)).toBe(s);
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(Infinity)).toThrow(/non-finite/);
  });

  it("refuses values RFC 8785 can't represent", () => {
    expect(() => canonicalJson({ a: "\ud800" })).toThrow(/lone UTF-16 surrogate/);
    expect(() => canonicalJson({ ["\udc00"]: 1 })).toThrow(/lone UTF-16 surrogate/);
    expect(() => canonicalJson(new Date(0))).toThrow(/not a plain object/);
    expect(() => canonicalJson(1n)).toThrow(/unsupported bigint/);
  });

  it("gives the same digest whatever the key order and whitespace, and a different one for any value change", async () => {
    const a = await canonicalSha256(parseJson('{"b": [1, {"y": 2, "x": 1}], "a": "t"}'));
    const b = await canonicalSha256(parseJson('{"a":"t","b":[1,{"x":1,"y":2}]}'));
    const c = await canonicalSha256(parseJson('{"a":"t","b":[1,{"x":1,"y":3}]}'));
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(a).toBe(await sha256Hex(utf8.encode('{"a":"t","b":[1,{"x":1,"y":2}]}')));
  });
});
