import { describe, expect, it, vi } from "vitest";
import { checkAudit, fetchAdvisory } from "../tools/dependency-audit";

const ID = "GHSA-fc5q-39xc-vjpf";
const now = Date.parse("2026-11-18T17:00:00Z");
const direct = { name: "picomatch", dependency: "picomatch", severity: "high", url: `https://github.com/advisories/${ID}` };
const report = () => ({ auditReportVersion: 2, vulnerabilities: {
  vite: { name: "vite", severity: "high", via: ["vitest", "picomatch"] },
  vitest: { name: "vitest", severity: "high", via: ["vite"] },
  picomatch: { name: "picomatch", severity: "high", via: [direct] },
}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 3, critical: 0, total: 3 } } });
const withdrawn = () => ({ ghsa_id: ID, type: "reviewed", withdrawn_at: "2026-11-18T15:38:56Z", vulnerabilities: [{ package: { ecosystem: "npm", name: "picomatch" } }] });

describe("authoritative npm advisory withdrawal reconciliation", () => {
  it("accepts a clean report without any network dependency", async () => {
    const r = report(); r.vulnerabilities = {} as typeof r.vulnerabilities;
    r.metadata.vulnerabilities.high = 0; r.metadata.vulnerabilities.total = 0;
    const lookup = vi.fn<(id: string) => Promise<unknown>>();
    expect(await checkAudit(r, lookup, now)).toEqual({ reportedPackages: 0, withdrawn: [], activeHighCritical: 0 });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("resolves cyclic transitive paths and checks the actual root advisory once", async () => {
    const lookup = vi.fn<() => Promise<ReturnType<typeof withdrawn>>>(async () => withdrawn());
    expect(await checkAudit(report(), lookup, now)).toEqual({ reportedPackages: 3, withdrawn: [{ id: ID, withdrawnAt: "2026-11-18T15:38:56Z", packages: ["picomatch"] }], activeHighCritical: 0 });
    expect(lookup).toHaveBeenCalledExactlyOnceWith(ID);
  });
  it("blocks an active finding rather than accepting a former withdrawal", async () => {
    await expect(checkAudit(report(), async () => ({ ...withdrawn(), withdrawn_at: null }), now)).rejects.toThrow(/active or unverified/);
  });
  it("fails closed when the authoritative service cannot be reached", async () => {
    await expect(checkAudit(report(), async () => { throw new Error("offline"); }, now)).rejects.toThrow("offline");
  });
  it.each(["other", "future", "invalid", "wrong-package", "unreviewed"])("rejects %s withdrawal evidence", async (test) => {
    const a = withdrawn();
    if (test === "other") a.ghsa_id = "GHSA-aaaa-bbbb-cccc";
    if (test === "future") a.withdrawn_at = "2027-01-01T00:00:00Z";
    if (test === "invalid") a.withdrawn_at = "invalid";
    if (test === "wrong-package") a.vulnerabilities[0]!.package.name = "another-package";
    if (test === "unreviewed") a.type = "unreviewed";
    await expect(checkAudit(report(), async () => a, now)).rejects.toThrow();
  });
  it.each(["count", "name", "missing", "cycle-only", "empty", "url", "dependency", "npm-error"])("blocks malformed %s audit data", async (test) => {
    const r = report();
    if (test === "count") r.metadata.vulnerabilities.high = 0;
    if (test === "name") r.vulnerabilities.vite.name = "something-else";
    if (test === "missing") r.vulnerabilities.vite.via = ["missing"];
    if (test === "cycle-only") r.vulnerabilities.vite.via = ["vitest"];
    if (test === "empty") r.vulnerabilities.vite.via = [];
    if (test === "url") r.vulnerabilities.picomatch.via = [{ ...direct, url: "https://example.com/advisories/" + ID }];
    if (test === "dependency") r.vulnerabilities.picomatch.via = [{ ...direct, dependency: "vite" }];
    if (test === "npm-error") Object.assign(r, { error: { code: "EHTTP" } });
    await expect(checkAudit(r, async () => withdrawn(), now)).rejects.toThrow();
  });
  it("does not let one withdrawn cause mask an additional active advisory", async () => {
    const other = "GHSA-aaaa-bbbb-cccc", r = report();
    r.vulnerabilities.picomatch.via.push({ ...direct, url: `https://github.com/advisories/${other}` });
    await expect(checkAudit(r, async (id) => id === ID ? withdrawn() : { ...withdrawn(), ghsa_id: other, withdrawn_at: null }, now)).rejects.toThrow(/active or unverified/);
  });
  it("uses a fixed HTTPS origin and refuses redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(withdrawn()), { status: 200 }));
    expect(await fetchAdvisory(ID, fetcher)).toEqual(withdrawn());
    expect(fetcher).toHaveBeenCalledWith(`https://api.github.com/advisories/${ID}`, expect.objectContaining({ redirect: "error" }));
    await expect(fetchAdvisory("../secrets", fetcher)).rejects.toThrow(/identifier/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects HTTP failures and malformed JSON from the advisory lookup", async () => {
    await expect(fetchAdvisory(ID, async () => new Response("rate limited", { status: 429 }))).rejects.toThrow(/HTTP 429/);
    await expect(fetchAdvisory(ID, async () => new Response('{"ghsa_id":"a","ghsa_id":"b"}'))).rejects.toThrow(/duplicate/);
  });
});
