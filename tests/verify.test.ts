import { unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AccessDenied,
  AuditLog,
  PackageSession,
  buildPackage,
  checkPath,
  defaultPolicy,
  generateKeyPair,
  loadTrustStore,
  verifyPackage,
  type KeyPair,
  type Signer,
  type TrustStore,
} from "../src/core";
import { utf8 } from "../src/core/bytes";
import { sampleContents } from "../tools/sample-data";

const now = new Date("2026-06-01T00:00:00Z");
const iso = (offsetDays: number) => new Date(now.getTime() + offsetDays * 86_400_000).toISOString();
const pkgMeta = {
  id: "8f2d1c3a-6b4e-4f0a-9c1d-2e3f4a5b6c7d",
  title: "Test TDP",
  partNumber: "SMP-1000",
  revision: "B",
  created: iso(-1),
  expires: iso(30),
};

let author: KeyPair;
let approver: KeyPair;
let outsider: KeyPair;
let store: TrustStore;

const trusted = (k: KeyPair, role: "author" | "approver", extra: Partial<TrustStore["keys"][number]> = {}) => ({
  keyId: k.keyId,
  name: role,
  publicKey: k.publicKey,
  roles: [role],
  notBefore: iso(-10),
  notAfter: iso(365),
  revoked: false,
  ...extra,
});

beforeAll(async () => {
  [author, approver, outsider] = await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()]);
  store = { schema: "tdp-truststore/0.1", keys: [trusted(author, "author"), trusted(approver, "approver")] };
});

async function makePackage(signers?: Signer[]): Promise<Uint8Array> {
  const { inputs, bom } = sampleContents();
  return buildPackage(pkgMeta, inputs, bom, signers ?? [
    { ...author, role: "author" },
    { ...approver, role: "approver" },
  ], now);
}

function rezip(tdp: Uint8Array, edit: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(tdp);
  edit(files);
  return zipSync(files);
}

const failedIds = (r: { checks: { id: string; status: string }[] }) =>
  r.checks.filter((c) => c.status === "fail").map((c) => c.id);

describe("verifyPackage", () => {
  it("trusts a correctly signed package", async () => {
    const r = await verifyPackage(await makePackage(), store, defaultPolicy, now);
    expect(failedIds(r)).toEqual([]);
    expect(r.verdict).toBe("trusted");
  });

  it("rejects a file altered after signing", async () => {
    const tdp = rezip(await makePackage(), (f) => {
      f["bom/bom.csv"] = utf8.encode("part_number\nEVIL-1\n");
    });
    const r = await verifyPackage(tdp, store, defaultPolicy, now);
    expect(r.verdict).toBe("rejected");
    expect(r.files.find((f) => f.path === "bom/bom.csv")?.problems.join()).toMatch(/SHA-256|size/);
  });

  it("rejects an edited manifest even if its file digests are updated", async () => {
    const tdp = rezip(await makePackage(), (f) => {
      const m = JSON.parse(utf8.decode(f["tdp-manifest.json"]!));
      m.package.revision = "Z";
      f["tdp-manifest.json"] = utf8.encode(JSON.stringify(m));
    });
    const r = await verifyPackage(tdp, store, defaultPolicy, now);
    expect(failedIds(r)).toContain("signatures");
  });

  it("rejects files not listed in the manifest", async () => {
    const tdp = rezip(await makePackage(), (f) => {
      f["extra/payload.txt"] = utf8.encode("hello");
    });
    const r = await verifyPackage(tdp, store, defaultPolicy, now);
    expect(r.verdict).toBe("rejected");
    expect(r.files.find((f) => f.path === "extra/payload.txt")?.problems).toEqual(["not listed in manifest"]);
  });

  it("requires every role, each from a distinct trusted key", async () => {
    const onlyAuthor = await verifyPackage(await makePackage([{ ...author, role: "author" }]), store, defaultPolicy, now);
    expect(onlyAuthor.verdict).toBe("rejected");

    const bothRolesOneKey: TrustStore = { ...store, keys: [trusted(author, "author", { roles: ["author", "approver"] })] };
    const r = await verifyPackage(
      await makePackage([{ ...author, role: "author" }, { ...author, role: "approver" }]),
      bothRolesOneKey,
      defaultPolicy,
      now,
    );
    expect(r.verdict).toBe("rejected");
  });

  it("rejects signatures from unknown, revoked, expired or wrong-role keys", async () => {
    const cases: [string, Signer[], TrustStore][] = [
      ["unknown", [{ ...author, role: "author" }, { ...outsider, role: "approver" }], store],
      ["revoked", [{ ...author, role: "author" }, { ...approver, role: "approver" }],
        { ...store, keys: [trusted(author, "author"), trusted(approver, "approver", { revoked: true })] }],
      ["expired", [{ ...author, role: "author" }, { ...approver, role: "approver" }],
        { ...store, keys: [trusted(author, "author"), trusted(approver, "approver", { notAfter: iso(-2) })] }],
      ["wrong role", [{ ...author, role: "author" }, { ...author, role: "approver" }], store],
    ];
    for (const [label, signers, ts] of cases) {
      const r = await verifyPackage(await makePackage(signers), ts, defaultPolicy, now);
      expect(r.verdict, label).toBe("rejected");
    }
  });

  it("rejects expired packages", async () => {
    const r = await verifyPackage(await makePackage(), store, defaultPolicy, new Date(now.getTime() + 60 * 86_400_000));
    expect(r.verdict).toBe("rejected");
  });

  it("rejects content that doesn't match its declared media type", async () => {
    const { inputs, bom } = sampleContents();
    inputs[0]!.bytes = utf8.encode("MZ not really a pdf");
    const tdp = await buildPackage(pkgMeta, inputs, bom, [{ ...author, role: "author" }, { ...approver, role: "approver" }], now);
    const r = await verifyPackage(tdp, store, defaultPolicy, now);
    expect(r.files.find((f) => f.path === inputs[0]!.path)?.problems).toContain("content is not application/pdf");
  });

  it("rejects archives that exceed size limits", async () => {
    const policy = { ...defaultPolicy, limits: { ...defaultPolicy.limits, maxTotalBytes: 100 } };
    const r = await verifyPackage(await makePackage(), store, policy, now);
    expect(failedIds(r)).toEqual(["archive"]);
  });

  it("rejects non-zip input", async () => {
    const r = await verifyPackage(utf8.encode("not a zip"), store, defaultPolicy, now);
    expect(r.verdict).toBe("rejected");
  });
});

describe("checkPath", () => {
  it.each(["../etc/passwd", "/abs", "a//b", "a\\b", "C:/x", "a/./b", "x\u0000"])("rejects %j", (p) => {
    expect(checkPath(p)).not.toBeNull();
  });
  it("accepts normal relative paths", () => {
    expect(checkPath("drawings/SMP-1001_A.pdf")).toBeNull();
  });
});

describe("loadTrustStore", () => {
  it("rejects a key whose id doesn't match its public key", async () => {
    const bad = { ...store, keys: [{ ...store.keys[0]!, publicKey: approver.publicKey }] };
    await expect(loadTrustStore(JSON.stringify(bad))).rejects.toThrow(/key id mismatch/);
  });
});

describe("PackageSession", () => {
  it("hands out files only from a trusted package and audits each access", async () => {
    const audit = new AuditLog(() => now);
    const s = await PackageSession.open("t.tdp", await makePackage(), store, defaultPolicy, audit, now);
    expect(s.trusted).toBe(true);
    const { bytes } = await s.openFile("bom/bom.csv", "preview");
    expect(utf8.decode(bytes)).toContain("SMP-1000");
    const log = await audit.list();
    expect(log.map((e) => e.action)).toEqual(["load", "verify", "open"]);
    expect(await AuditLog.verifyChain(log)).toBe(true);
  });

  it("denies every file from an untrusted package", async () => {
    const s = await PackageSession.open("t.tdp", await makePackage([{ ...author, role: "author" }]), store, defaultPolicy, undefined, now);
    await expect(s.openFile("bom/bom.csv", "preview")).rejects.toBeInstanceOf(AccessDenied);
    expect((await s.audit.list()).at(-1)?.action).toBe("deny");
  });
});

describe("AuditLog", () => {
  it("detects a tampered entry", async () => {
    const log = new AuditLog();
    await log.append("load", "a");
    await log.append("open", "b");
    const entries = (await log.list()).map((e) => ({ ...e }));
    entries[0]!.subject = "changed";
    expect(await AuditLog.verifyChain(entries)).toBe(false);
  });
});
