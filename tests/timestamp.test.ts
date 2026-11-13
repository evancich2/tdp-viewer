// RFC 3161 verification against fixtures made by OpenSSL's `ts` with a throwaway local CA
// (tools/make-tsa-fixtures.sh). No network.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { criticalRanges, loadTsaCertificates, requestTimestamp, timestampRequest, verifyTimestamp } from "../tools/timestamp";

const F = "tests/fixtures/tsa";
const resp = readFileSync(`${F}/response.der`);
const digest = readFileSync(`${F}/digest.txt`, "utf8").trim();
const root = loadTsaCertificates(readFileSync(`${F}/ca.pem`));
const tsa = loadTsaCertificates(readFileSync(`${F}/tsa.pem`));
const other = loadTsaCertificates(readFileSync(`${F}/other-root.pem`));
const NONCE = "102030405060708";

describe("RFC 3161 timestamps", () => {
  it("verify against a pinned root or the pinned TSA certificate itself", () => {
    const r = verifyTimestamp(resp, digest, root, NONCE);
    expect(r.tsa).toMatch(/TDP Test TSA \(fixture\)/);
    expect(Date.parse(r.genTime)).toBeGreaterThan(Date.parse("2026-01-01"));
    expect(verifyTimestamp(resp, digest, tsa).policy).toBe("1.2.3.4.1");
  });

  it("refuse an unpinned TSA, another digest, a wrong nonce, or any altered byte", () => {
    expect(() => verifyTimestamp(resp, digest, other)).toThrow(/not a pinned TSA/);
    expect(() => verifyTimestamp(resp, "0".repeat(64), root)).toThrow(/different digest/);
    expect(() => verifyTimestamp(resp, digest, root, "99")).toThrow(/nonce/);
    // Every byte of what the verifier relies on (TSTInfo, signed attributes, signature, signer certificate)
    // must be refused when flipped. Bytes outside them (the status value, the unused chain certificate,
    // NULL algorithm parameters) don't affect what is proven.
    let checked = 0;
    for (const [from, to] of criticalRanges(resp, tsa[0]!.raw)) {
      expect(from).toBeGreaterThan(0);
      for (let i = from; i < to; i++) {
        const bad = Buffer.from(resp);
        bad[i] = bad[i]! ^ 0x01;
        expect(() => verifyTimestamp(bad, digest, root, NONCE), `byte ${i}`).toThrow();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it("builds a DER request that OpenSSL accepted (the fixture was made from it)", () => {
    const { der } = timestampRequest(digest, Buffer.from("0102030405060708", "hex"));
    expect(der.toString("hex")).toContain(digest);
    expect(der[0]).toBe(0x30);
  });

  it("requests over HTTP and verifies before returning (fake fetch)", async () => {
    let body: Uint8Array | undefined;
    const fake = (async (_url: string, init: { body: Uint8Array }) => { body = init.body; return new Response(resp); }) as unknown as typeof fetch;
    // The fake replays the fixture, whose nonce won't match a fresh request: it must be refused.
    await expect(requestTimestamp("https://tsa.example/", digest, root, fake)).rejects.toThrow(/nonce/);
    expect(body?.[0]).toBe(0x30);
  });
});

describe("RFC 3161 end to end with a local OpenSSL TSA", () => {
  const openssl = (() => { for (const bin of ["/opt/local/bin/openssl", "openssl"]) { try { execFileSync(bin, ["ts", "-help"], { stdio: "ignore" }); return bin; } catch { /* next */ } } return null; })();
  it("requests a timestamp for a tree-head digest with a fresh nonce and verifies the TSA's answer", async () => {
    if (!openssl) return console.warn("openssl ts unavailable; skipped");
    const T = mkdtempSync(join(tmpdir(), "tdp-tsa-"));
    try {
      const run = (...a: string[]) => execFileSync(openssl, a, { cwd: T, stdio: ["pipe", "pipe", "ignore"] });
      writeFileSync(join(T, "ext.cnf"), "[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n[tsa]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n");
      writeFileSync(join(T, "ts.cnf"), `[ tsa ]\ndefault_tsa = t\n[ t ]\nserial = ${join(T, "serial")}\nsigner_digest = sha256\ndefault_policy = 1.2.3.4.1\ndigests = sha256\ness_cert_id_alg = sha256\n`);
      writeFileSync(join(T, "serial"), "01\n");
      run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-subj", "/CN=Local Test CA", "-days", "2", "-out", "ca.pem", "-addext", "basicConstraints=critical,CA:TRUE");
      run("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "tsa.key", "-subj", "/CN=Local Test TSA", "-out", "tsa.csr");
      run("x509", "-req", "-in", "tsa.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "ext.cnf", "-extensions", "tsa", "-out", "tsa.pem");
      const ca = loadTsaCertificates(readFileSync(join(T, "ca.pem")));
      const fetcher = (async (_u: string, init: { body: Uint8Array }) => {
        writeFileSync(join(T, "req.der"), init.body);
        run("ts", "-reply", "-config", "ts.cnf", "-queryfile", "req.der", "-inkey", "tsa.key", "-signer", "tsa.pem", "-out", "resp.der");
        return new Response(readFileSync(join(T, "resp.der")));
      }) as unknown as typeof fetch;
      const { file, result } = await requestTimestamp("https://tsa.local/", digest, ca, fetcher);
      expect(result.tsa).toMatch(/Local Test TSA/);
      expect(file.nonce).toMatch(/^[0-9a-f]+$/);
      expect(Math.abs(Date.parse(result.genTime) - Date.now())).toBeLessThan(120_000);
    } finally {
      rmSync(T, { recursive: true, force: true });
    }
  }, 60_000);
});
