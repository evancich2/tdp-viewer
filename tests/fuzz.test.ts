// Fuzz tests for the verifier. The properties:
//   1. verifyPackage never throws, whatever the input.
//   2. If it says "trusted", every file it hands out is byte-for-byte what was signed.
// Seeded, so failures reproduce.
import { unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { Manifest, buildPackage, defaultPolicy, generateKeyPair, verifyPackage, type TrustStore } from "../src/core";
import { sha256Hex, utf8 } from "../src/core/bytes";
import { sampleContents } from "../tools/sample-data";

const now = new Date("2026-06-01T00:00:00Z");
const iso = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString();
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 400);

/** mulberry32: small, fast, seedable PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)]! };
}

type Rng = ReturnType<typeof rng>;

const MUTATIONS: Record<string, (b: Uint8Array, r: Rng) => Uint8Array> = {
  flipBits(b, r) {
    const out = b.slice();
    for (let i = 0, n = 1 + r.int(8); i < n; i++) out[r.int(out.length)]! ^= 1 << r.int(8);
    return out;
  },
  truncate: (b, r) => b.slice(0, r.int(b.length)),
  insert(b, r) {
    const at = r.int(b.length);
    const junk = Uint8Array.from({ length: 1 + r.int(64) }, () => r.int(256));
    return Uint8Array.from([...b.subarray(0, at), ...junk, ...b.subarray(at)]);
  },
  overwrite(b, r) {
    const out = b.slice();
    const at = r.int(out.length);
    for (let i = at; i < Math.min(out.length, at + 1 + r.int(32)); i++) out[i] = r.int(256);
    return out;
  },
  duplicateChunk(b, r) {
    const start = r.int(b.length);
    const chunk = b.subarray(start, start + 1 + r.int(256));
    const at = r.int(b.length);
    return Uint8Array.from([...b.subarray(0, at), ...chunk, ...b.subarray(at)]);
  },
};

let tdp: Uint8Array;
let store: TrustStore;
let originals: Map<string, string>;

beforeAll(async () => {
  const [author, approver] = await Promise.all([generateKeyPair(), generateKeyPair()]);
  const key = (k: typeof author, role: "author" | "approver") => ({
    keyId: k.keyId, name: role, publicKey: k.publicKey, roles: [role], notBefore: iso(-10), notAfter: iso(365), revoked: false,
  });
  store = { schema: "tdp-truststore/0.1", keys: [key(author, "author"), key(approver, "approver")] };
  const { inputs, bom } = sampleContents();
  tdp = await buildPackage(
    { id: "8f2d1c3a-6b4e-4f0a-9c1d-2e3f4a5b6c7d", title: "Fuzz", partNumber: "SMP-1000", revision: "B", created: iso(-1) },
    inputs, bom, [{ ...author, role: "author" }, { ...approver, role: "approver" }], now,
  );
  originals = new Map();
  for (const [path, bytes] of Object.entries(unzipSync(tdp))) originals.set(path, await sha256Hex(bytes));
}, 30_000);

/** Property 2: trusted means every entry is exactly what was signed. */
async function assertTrustedMeansUnaltered(result: Awaited<ReturnType<typeof verifyPackage>>, label: string) {
  if (result.verdict !== "trusted") return;
  for (const e of result.entries) expect(await sha256Hex(e.bytes), `${label}: ${e.path}`).toBe(originals.get(e.path));
  expect(result.entries.length, label).toBe(originals.size);
}

describe("fuzzing the verifier", () => {
  it(`never throws and never trusts altered content (${ITERATIONS} mutated packages)`, async () => {
    const r = rng(0x7d9e);
    const names = Object.keys(MUTATIONS);
    let trusted = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const name = r.pick(names);
      const mutated = MUTATIONS[name]!(tdp, r);
      const label = `iteration ${i} (${name})`;
      const result = await verifyPackage(mutated, store, defaultPolicy, now);
      await assertTrustedMeansUnaltered(result, label);
      if (result.verdict === "trusted") trusted++;
    }
    // Some mutations only touch zip metadata (timestamps, padding) and leave every file intact;
    // those may still verify. Nearly all mutations must not.
    expect(trusted).toBeLessThan(ITERATIONS / 4);
  }, 120_000);

  it("rejects every mutation of any single file's bytes", async () => {
    const r = rng(42);
    const files = unzipSync(tdp);
    for (const path of Object.keys(files)) {
      for (let i = 0; i < 10; i++) {
        const changed: Record<string, Uint8Array> = { ...files, [path]: MUTATIONS.flipBits!(files[path]!, r) };
        const result = await verifyPackage(zipSync(changed), store, defaultPolicy, now);
        expect(result.verdict, `${path} #${i}`).toBe("rejected");
      }
    }
  }, 120_000);

  it("never throws on mangled manifest JSON", () => {
    const r = rng(7);
    const base = JSON.parse(utf8.decode(unzipSync(tdp)["tdp-manifest.json"]!));
    const weird = [null, 0, -1, 1e308, "", "x".repeat(10_000), [], {}, true, "../../etc/passwd", "\u0000"];
    const mutate = (v: unknown, depth: number): unknown => {
      if (depth > 6 || r.next() < 0.1) return r.pick(weird);
      if (Array.isArray(v)) return v.map((x) => mutate(x, depth + 1)).filter(() => r.next() > 0.1);
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) if (r.next() > 0.05) out[k] = mutate(x, depth + 1);
        if (r.next() < 0.05) out[`extra${r.int(9)}`] = r.pick(weird);
        return out;
      }
      return r.next() < 0.2 ? r.pick(weird) : v;
    };
    for (let i = 0; i < ITERATIONS; i++) expect(() => Manifest.safeParse(mutate(base, 0))).not.toThrow();
  });
});

describe("hostile archives", () => {
  const verdict = async (files: Record<string, Uint8Array>, policy = defaultPolicy) => verifyPackage(zipSync(files), store, policy, now);
  const archiveCheck = (r: Awaited<ReturnType<typeof verifyPackage>>) => r.checks.find((c) => c.id === "archive")!;

  it("rejects a zip bomb before inflating it", async () => {
    const r = await verdict({ "bomb.txt": new Uint8Array(64 * 1024 * 1024) });
    expect(archiveCheck(r)).toMatchObject({ status: "fail" });
    expect(archiveCheck(r).message).toMatch(/compression ratio/);
  });

  it("rejects path traversal, absolute paths and backslashes", async () => {
    for (const name of ["../escape.txt", "/etc/passwd", "a\\..\\b.txt", "a/../../b.txt"]) {
      const r = await verdict({ [name]: utf8.encode("x") });
      expect(archiveCheck(r).status, name).toBe("fail");
    }
  });

  it("rejects names that collide on case-insensitive filesystems", async () => {
    const r = await verdict({ "Drawing.pdf": utf8.encode("%PDF-a"), "drawing.pdf": utf8.encode("%PDF-b") });
    expect(archiveCheck(r).message).toMatch(/duplicate/);
  });

  it("rejects archives with too many entries", async () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}.txt`, utf8.encode("x")]));
    const r = await verdict(many, { ...defaultPolicy, limits: { ...defaultPolicy.limits, maxEntries: 20 } });
    expect(archiveCheck(r).message).toMatch(/more than 20 entries/);
  });
});
