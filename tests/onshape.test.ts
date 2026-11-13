// The Onshape adapter against a FAKE transport (canned responses shaped like the public docs'
// examples). This tests our request signing, request shape and decision logic; it does not show
// that the live service answers this way.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EngineeringModel } from "../src/core/engineering";
import { OnshapeClient, OnshapeReadAdapter, credentialsFromEnv, readRevisions, signRequest, type Transport } from "../tools/onshape";

const creds = { accessKey: "ACCESSKEYTEST", secretKey: "SECRETKEYTEST-never-printed", baseUrl: "https://cad.onshape.com", apiVersion: "v10" };
const DID = "e60c4803eaf2ac8be492c18e";
const VID = "a1b2c3d4e5f6a1b2c3d4e5f6";
const EID = "0123456789abcdef01234567";

function fake(routes: Record<string, unknown>, calls: { url: string; headers: Record<string, string> }[] = [], status = 200): Transport {
  return async (url, init) => {
    calls.push({ url, headers: init.headers });
    const path = new URL(url).pathname;
    const body = routes[path];
    return { status: body === undefined ? 404 : status, json: async () => body, headers: { get: () => null } };
  };
}

const model = (rev: string, ref: Record<string, string>): EngineeringModel => ({
  schema: "tdp-engineering/0.1", synthetic: true, label: "test",
  baseline: { id: "BL", packageId: "8f2d1c3a-6b4e-4f0a-9c1d-2e3f4a5b6c7d", item: { itemId: "P", revision: rev }, effectivity: { kind: "none" } },
  sources: [{ id: "SRC", system: "onshape", reference: ref, declaredRevision: rev, declaredReleaseState: "Released", capture: "api-read", capturedAt: "2026-11-01T00:00:00Z" }],
  items: [{ itemId: "P", revision: rev, partNumber: "P", name: "p", source: "SRC" }],
  occurrences: [], requirements: [], characteristics: [], artifacts: [], geometryLinks: [], relationships: [],
  provenance: { generatedBy: "test", generatedAt: "2026-11-01T00:00:00Z" },
});

const routes = (revisions: unknown) => ({
  [`/api/v10/documents/${DID}`]: { id: DID, name: "Latch" },
  [`/api/v10/documents/d/${DID}/versions`]: [{ id: VID, name: "V3 release" }],
  [`/api/v10/revisions/d/${DID}`]: revisions,
});

describe("Onshape request signing", () => {
  it("follows the documented HMAC-SHA256 scheme", () => {
    const date = "Thu, 12 Nov 2026 13:00:00 GMT";
    const nonce = "abcdefghijklmnopqrstuvwxy";
    const expected = createHmac("sha256", creds.secretKey).update(`get\n${nonce}\n${date}\napplication/json\n/api/v10/documents/${DID}\n\n`.toLowerCase()).digest("base64");
    expect(signRequest(creds, "GET", `/api/v10/documents/${DID}`, "", date, nonce)).toBe(`On ACCESSKEYTEST:HmacSHA256:${expected}`);
  });

  it("sends signed GETs with date and nonce, and never the secret", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    await new OnshapeClient(creds, fake(routes([]), calls)).document(DID);
    const h = calls[0]!.headers;
    expect(calls[0]!.url).toBe(`https://cad.onshape.com/api/v10/documents/${DID}`);
    expect(h.Authorization).toMatch(/^On ACCESSKEYTEST:HmacSHA256:/);
    expect(h["On-Nonce"]!.length).toBeGreaterThanOrEqual(16);
    expect(h.Date).toMatch(/GMT$/);
    expect(JSON.stringify(calls)).not.toContain(creds.secretKey);
  });

  it("refuses unsafe identifiers, missing credentials and non-https endpoints", async () => {
    await expect(new OnshapeClient(creds, fake({})).document("../../etc")).rejects.toThrow(/alphanumeric/);
    expect(() => credentialsFromEnv({})).toThrow(/ONSHAPE_ACCESS_KEY/);
    expect(() => credentialsFromEnv({ ONSHAPE_ACCESS_KEY: "a", ONSHAPE_SECRET_KEY: "b", ONSHAPE_BASE_URL: "http://x" })).toThrow(/https/);
  });

  it("reports rate limits and auth failures without echoing credentials", async () => {
    await expect(new OnshapeClient(creds, fake(routes([]), [], 429)).document(DID)).rejects.toThrow(/rate limit/);
    const err = await new OnshapeClient(creds, fake(routes([]), [], 401)).document(DID).catch((e: Error) => e.message);
    expect(err).toMatch(/refused/);
    expect(err).not.toContain(creds.secretKey);
  });
});

describe("Onshape publication check", () => {
  const ref = { documentId: DID, versionId: VID, elementId: EID, partNumber: "P-100" };
  const check = async (revisions: unknown, rev = "B", r: Record<string, string> = ref) =>
    (await new OnshapeReadAdapter(new OnshapeClient(creds, fake(routes(revisions)))).checkPublication(model(rev, r)))[0]!;

  it("is current only when the declared revision is the latest, from the declared version", async () => {
    const revs = { items: [
      { revision: "A", partNumber: "P-100", versionId: "000000000000000000000000", createdAt: "2026-10-01T00:00:00Z" },
      { revision: "B", partNumber: "P-100", versionId: VID, createdAt: "2026-11-01T00:00:00Z", releaseName: "R-7" },
    ] };
    expect((await check(revs)).status).toBe("current");
    expect((await check(revs, "A")).status).toBe("mismatch"); // A was released from another version
    const later = { items: [...revs.items, { revision: "C", partNumber: "P-100", versionId: "ffffffffffffffffffffffff", createdAt: "2026-11-10T00:00:00Z" }] };
    expect((await check(later)).status).toBe("superseded");
  });

  it("fails closed: missing fields give unknown, never current", async () => {
    expect((await check([{ partNumber: "P-100", versionId: VID }])).status).toBe("unknown"); // no revision field
    expect((await check([{ revision: "B", partNumber: "P-100", versionId: VID }])).status).toBe("unknown"); // no dates
    expect((await check({ unexpected: true })).status).toBe("not-released");
    expect((await check([], "B", { documentId: DID })).status).toBe("unknown");
    expect((await check([], "B", { ...ref, versionId: "999999999999999999999999" })).status).toBe("mismatch");
  });

  it("is read-only: every proposed transaction is answered unsupported", async () => {
    const a = new OnshapeReadAdapter(new OnshapeClient(creds, fake({})));
    const acks = await a.reconcile({ schema: "tdp-sync-proposals/0.1", recipe: { id: "r", version: 1 }, baseline: { packageId: "8f2d1c3a-6b4e-4f0a-9c1d-2e3f4a5b6c7d", manifestSha256: "0".repeat(64), baselineId: "BL" }, ledger: { instance: "8f2d1c3a-6b4e-4f0a-9c1d-2e3f4a5b6c7d", count: 0, head: "0".repeat(64) }, generatedAt: "2026-11-01T00:00:00Z", transactions: [{ txId: `tx-${"a".repeat(32)}`, contentSha256: "0".repeat(64), operation: "create", target: { system: "onshape", objectType: "AsBuiltUnit", objectId: "x" }, expectedVersion: null, attributes: {}, source: { recordId: "8f2d1c3a-6b4e-4f0a-9c1d-2e3f4a5b6c7d", recordSha256: "0".repeat(64), kind: "build-complete" }, lossy: [], status: "proposed", changesDefinition: false }], excluded: [] });
    expect(acks.acks.map((x) => x.status)).toEqual(["unsupported"]);
  });

  it("captures a source reference, declaring (not verifying) its release state", async () => {
    const a = new OnshapeReadAdapter(new OnshapeClient(creds, fake(routes([{ revision: "B", partNumber: "P-100", releaseName: "R-7" }]))));
    const r = await a.captureReference({ id: "SRC-P", documentId: DID, versionId: VID, elementId: EID, partNumber: "P-100", revision: "B" }, new Date("2026-11-12T00:00:00Z"));
    expect(r).toMatchObject({ system: "onshape", capture: "api-read", declaredRevision: "B", declaredReleaseState: "Released (R-7)", reference: { documentName: "Latch", versionName: "V3 release" } });
    expect(readRevisions({ items: [1, null, { revision: 3 }] })).toEqual([{}].map(() => ({ revision: undefined, partNumber: undefined, elementId: undefined, versionId: undefined, releaseName: undefined, createdAt: undefined })));
  });
});
