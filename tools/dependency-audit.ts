// npm can retain a withdrawn GHSA in its audit metadata. Reconcile against the live,
// authoritative withdrawal record; never keep a static ignore list or skip active findings.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { parseJson } from "../src/core/json";

const Severity = z.enum(["info", "low", "moderate", "high", "critical"]);
const Direct = z.object({ name: z.string().min(1), dependency: z.string().min(1), url: z.string(), severity: Severity }).passthrough();
const Entry = z.object({ name: z.string().min(1), severity: Severity, via: z.array(z.union([z.string().min(1), Direct])).min(1) }).passthrough();
const Counts = z.object({ info: z.number().int().nonnegative(), low: z.number().int().nonnegative(), moderate: z.number().int().nonnegative(), high: z.number().int().nonnegative(), critical: z.number().int().nonnegative(), total: z.number().int().nonnegative() });
const Report = z.object({ auditReportVersion: z.literal(2), vulnerabilities: z.record(z.string(), Entry), metadata: z.object({ vulnerabilities: Counts }).passthrough() }).passthrough();
const Advisory = z.object({ ghsa_id: z.string(), type: z.literal("reviewed"), withdrawn_at: z.string().nullable(), vulnerabilities: z.array(z.object({ package: z.object({ ecosystem: z.string(), name: z.string() }) }).passthrough()).min(1) }).passthrough();
const GHSA_URL = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/;
const GHSA_ID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;

export async function checkAudit(input: unknown, lookup: (id: string) => Promise<unknown>, now = Date.now()) {
  const report = Report.parse(input);
  if ("error" in report) throw new Error("npm audit returned an error, not a usable report");
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    if (entry.name !== name) throw new Error(`audit package name mismatch: ${name}`);
    counts[entry.severity]++; counts.total++;
  }
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
    if (counts[key] !== report.metadata.vulnerabilities[key]) throw new Error(`audit count mismatch: ${key}`);
  }
  const severe = Object.entries(report.vulnerabilities).filter(([, v]) => v.severity === "high" || v.severity === "critical");
  const findings = new Map<string, Set<string>>();
  for (const [root] of severe) {
    const pending = [root], seen = new Set<string>();
    let causes = 0;
    while (pending.length) {
      const name = pending.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const entry = report.vulnerabilities[name];
      if (!entry) throw new Error(`unresolved audit dependency: ${name}`);
      for (const via of entry.via) {
        if (typeof via === "string") { pending.push(via); continue; }
        const id = GHSA_URL.exec(via.url)?.[1];
        if (!id || via.dependency !== name || via.name !== name) throw new Error(`unverifiable advisory for ${name}`);
        causes++;
        const packages = findings.get(id) ?? new Set<string>();
        packages.add(name); findings.set(id, packages);
      }
    }
    if (!causes) throw new Error(`audit finding has no verifiable cause: ${root}`);
  }
  const withdrawn: { id: string; withdrawnAt: string; packages: string[] }[] = [];
  // Each high/critical path must lead only to independently verified withdrawn advisories.
  for (const [id, packages] of findings) {
    const advisory = Advisory.parse(await lookup(id));
    const when = advisory.withdrawn_at === null ? NaN : Date.parse(advisory.withdrawn_at);
    if (advisory.ghsa_id !== id || !Number.isFinite(when) || when > now) throw new Error(`active or unverified security advisory: ${id}`);
    for (const name of packages) {
      if (!advisory.vulnerabilities.some((v) => v.package.ecosystem === "npm" && v.package.name === name)) throw new Error(`advisory package mismatch: ${id} / ${name}`);
    }
    withdrawn.push({ id, withdrawnAt: advisory.withdrawn_at!, packages: [...packages] });
  }
  return { reportedPackages: severe.length, withdrawn, activeHighCritical: 0 };
}

export async function fetchAdvisory(id: string, fetcher: typeof fetch = fetch) {
  if (!GHSA_ID.test(id)) throw new Error("invalid GHSA identifier");
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetcher(`https://api.github.com/advisories/${id}`, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`advisory lookup failed: ${id} (HTTP ${r.status})`);
  const text = await r.text();
  if (text.length > 2_000_000) throw new Error("advisory response too large");
  return parseJson(text);
}

async function main() {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("run with npm run audit:ci");
  const result = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    execFile(process.execPath, [npm, "audit", "--json"], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error && (!('code' in error) || error.code !== 1)) return reject(new Error("npm audit execution failed"));
      resolve({ code: error ? 1 : 0, stdout });
    });
  });
  const dir = "audit-results";
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "npm-audit.json"), result.stdout);
  console.log(result.stdout); // Retain the unmodified npm result in CI logs as well.
  const report = parseJson(result.stdout);
  const summary = await checkAudit(report, async (id) => {
    const advisory = await fetchAdvisory(id);
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(advisory, null, 2));
    return advisory;
  });
  writeFileSync(join(dir, "assessment.json"), JSON.stringify({ npmExitCode: result.code, ...summary }, null, 2));
  console.log(JSON.stringify({ npmExitCode: result.code, ...summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(`Dependency audit blocked: ${error instanceof Error ? error.message : "unknown error"}`); process.exitCode = 1; });
}
