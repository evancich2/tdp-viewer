import { describe, expect, it } from "vitest";
import { consistencyProof, inclusionProof, treeHash, verifyConsistency, verifyInclusion } from "../src/core/custody";
import { sha256Hex, utf8 } from "../src/core/bytes";

const leaves = (n: number) => Promise.all(Array.from({ length: n }, (_, i) => sha256Hex(utf8.encode(`record ${i}`))));

describe("Merkle tree (RFC 9162)", () => {
  it("verifies nothing for impossible positions or malformed digests, without throwing", async () => {
    const leaf = "a".repeat(64), root = await treeHash([leaf]);
    expect(await verifyInclusion(leaf, 0, 1, root, [])).toBe(true);
    for (const [index, size] of [[-1, 1], [0.5, 1], [0, 1.5], [Number.NaN, 1], [0, Infinity], [2 ** 53, 2 ** 53 + 2]] as const)
      expect(await verifyInclusion(leaf, index, size, root, []), `index ${index} size ${size}`).toBe(false);
    for (const bad of ["", "abc", "A".repeat(64), "g".repeat(64)]) {
      expect(await verifyInclusion(leaf, 0, 2, root, [bad]), `proof ${bad}`).toBe(false);
      expect(await verifyInclusion(bad, 0, 1, root, []), `leaf ${bad}`).toBe(false);
      expect(await verifyConsistency(1, root, 2, root, [bad]), `consistency ${bad}`).toBe(false);
    }
    expect(await verifyInclusion(leaf, 0, 1, root.toUpperCase(), [])).toBe(false);
    for (const [a, b] of [[-1, 1], [0.5, 2], [1, Number.NaN]] as const) expect(await verifyConsistency(a, root, b, root, [])).toBe(false);
  });
  it("proves and verifies inclusion for every leaf of trees of size 1–20", async () => {
    for (let n = 1; n <= 20; n++) {
      const d = await leaves(n);
      const root = await treeHash(d);
      for (let m = 0; m < n; m++) {
        const p = await inclusionProof(m, d);
        expect(await verifyInclusion(d[m]!, m, n, root, p), `n=${n} m=${m}`).toBe(true);
        expect(await verifyInclusion(d[(m + 1) % n]!, m, n, root, p) && n > 1, `wrong leaf n=${n} m=${m}`).toBe(false);
      }
    }
  });

  it("proves and verifies consistency between every pair of sizes up to 20, and rejects false claims", async () => {
    const d = await leaves(20);
    for (let n = 1; n <= 20; n++)
      for (let m = 1; m <= n; m++) {
        const p = await consistencyProof(m, d.slice(0, n));
        const [r1, r2] = [await treeHash(d.slice(0, m)), await treeHash(d.slice(0, n))];
        expect(await verifyConsistency(m, r1, n, r2, p), `m=${m} n=${n}`).toBe(true);
        if (m < n) {
          const forked = [...d.slice(0, m - 1), await sha256Hex(utf8.encode("forged")), ...d.slice(m, n)];
          expect(await verifyConsistency(m, r1, n, await treeHash(forked), p), `forked m=${m} n=${n}`).toBe(false);
        }
      }
  });

  it("matches known structure: one leaf, two leaves, empty", async () => {
    const [a, b] = await leaves(2);
    expect(await treeHash([])).toBe(await sha256Hex(new Uint8Array()));
    const la = await sha256Hex(new Uint8Array([0, ...Buffer.from(a!, "hex")]));
    const lb = await sha256Hex(new Uint8Array([0, ...Buffer.from(b!, "hex")]));
    expect(await treeHash([a!])).toBe(la);
    expect(await treeHash([a!, b!])).toBe(await sha256Hex(new Uint8Array([1, ...Buffer.from(la, "hex"), ...Buffer.from(lb, "hex")])));
  });
});
