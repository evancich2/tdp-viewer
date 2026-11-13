import { describe, expect, it } from "vitest";
import { consistencyProof, inclusionProof, treeHash, verifyConsistency, verifyInclusion } from "../src/core/custody";
import { sha256Hex, utf8 } from "../src/core/bytes";

const leaves = (n: number) => Promise.all(Array.from({ length: n }, (_, i) => sha256Hex(utf8.encode(`record ${i}`))));

describe("Merkle tree (RFC 9162)", () => {
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
