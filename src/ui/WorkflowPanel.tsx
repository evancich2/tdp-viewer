import { useEffect, useState } from "react";
import {
  baselineFrom,
  characteristicsNeedingGeometryReview,
  evidenceStoreFrom,
  geometryStatus,
  importAcknowledgements,
  loadAuthority,
  loadProcess,
  nextActions,
  verifyLedger,
  workflowStatus,
  successorsOf,
  trackOf,
  unitLabel,
  verifyPackage,
  AckSet,
  ProposalSet,
  type Anchors,
  type AuditLog,
  type EvidenceStore,
  type LedgerResult,
  type LoadedAuthority,
  type LoadedProcess,
  type PackageSession,
  type ReconciliationRow,
  type StatusLevel,
  type Successor,
  type TrustStore,
  type WorkflowContext,
} from "../core";
import labAuthority from "../../samples/lab/authority.signed.json?raw";
import labProcessA from "../../samples/lab/processes/printed-part-v1.json?raw";
import labProcessB from "../../samples/lab/processes/printed-part-fai-v1.json?raw";
import { RecordStepForm } from "./RecordStepForm";

interface Props {
  session: PackageSession;
  trustStore: TrustStore;
  anchors?: Anchors;
  audit: AuditLog;
  onAudit: () => void;
}

const read = (f: File) => f.arrayBuffer().then((b) => new Uint8Array(b));
const short = (h?: string | null) => (h ? `${h.slice(0, 12)}…` : "—");
const when = (t: string) => `${t.replace("T", " ").slice(0, 16)} UTC`;

/** One labeled status. Each is established separately; none implies another. */
function Badge({ label, level, text }: { label: string; level: StatusLevel; text: string }) {
  const mark = level === "ok" ? "✓" : level === "fail" ? "✗" : level === "warn" ? "!" : "–";
  return (
    <div className={`badge ${level}`} data-status={label}>
      <span className="mark" aria-hidden="true">{mark}</span>
      <div><strong>{label}</strong><div className="small">{text}</div></div>
    </div>
  );
}

/**
 * Engineering workflow: baseline identity, requirements traceability, the signed record ledger and
 * its gates, build/inspection/disposition, and synchronization proposals. Every decision here is
 * made by the core verifiers; this component only displays them.
 */
export function WorkflowPanel({ session, trustStore, anchors, audit, onAudit }: Props) {
  const [authority, setAuthority] = useState<LoadedAuthority | null>(null);
  const [processes, setProcesses] = useState<LoadedProcess[]>([]);
  const [evidence, setEvidence] = useState<{ store: EvidenceStore; count: number } | null>(null);
  const [ledger, setLedger] = useState<{ name: string; raw: unknown; result: LedgerResult; ctx: WorkflowContext } | null>(null);
  const [sync, setSync] = useState<{ rows: ReconciliationRow[]; problems: string[]; changeRequests: number; signedBy?: string } | null>(null);
  const [successors, setSuccessors] = useState<Successor[]>([]);
  const [selUnit, setSelUnit] = useState("");
  const [proposals, setProposals] = useState<ProposalSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const eng = session.engineering;
  const m = eng?.model;

  async function useLabConfig() {
    try {
      const a = await loadAuthority(labAuthority, { anchors });
      const ps = await Promise.all([labProcessA, labProcessB].map((t) => loadProcess(t)));
      setAuthority(a);
      setProcesses(ps);
      setError(null);
      await audit.append("trust", "lab authority fixture", `authority ${a.config.id} serial ${a.config.serial} (${short(a.sha256)}), processes ${ps.map((p) => `${p.definition.id} v${p.definition.version}`).join(", ")}`);
      onAudit();
    } catch (e) {
      setError(`Authority rejected: ${(e as Error).message}`);
    }
  }

  async function loadAuthorityFile(f: File) {
    try {
      const a = await loadAuthority(await f.text(), { anchors });
      setAuthority(a);
      setError(null);
      await audit.append("trust", f.name, `authority ${a.config.id} serial ${a.config.serial}${a.signedBy ? `, signed by ${a.signedBy.name}` : ", unsigned"}`);
      onAudit();
    } catch (e) {
      setError(`Authority rejected: ${(e as Error).message}`);
    }
  }

  async function loadProcessFiles(files: FileList) {
    try {
      const ps = await Promise.all([...files].map(async (f) => loadProcess(await f.text())));
      setProcesses((cur) => [...cur.filter((c) => !ps.some((p) => p.definition.id === c.definition.id)), ...ps]);
      setError(null);
    } catch (e) {
      setError(`Process definition rejected: ${(e as Error).message}`);
    }
  }

  async function loadEvidence(fileList: FileList) {
    // Copy first: the input is cleared right after this is called.
    const files = [...fileList];
    const store = await evidenceStoreFrom(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await read(f) }))));
    setEvidence({ store, count: files.length });
    await audit.append("load", "evidence files", `${files.length} files hashed`);
    onAudit();
  }

  async function verify(name: string, raw: unknown) {
    if (!authority) return setError("Load the workflow authority configuration first.");
    const processId = (raw as { instance?: { processId?: string } })?.instance?.processId;
    const process = processes.find((p) => p.definition.id === processId);
    if (!process) return setError(`No loaded process definition for ${processId ?? "this ledger"}.`);
    try {
      const ctx: WorkflowContext = { baseline: baselineFrom(session.result), authority, process, trustStore, now: new Date(), skewMs: session.policy.clockSkewMs, evidence: evidence?.store, successors };
      const result = await verifyLedger(raw, ctx);
      setLedger({ name, raw, result, ctx });
      setError(null);
      await audit.append(result.verdict === "rejected" ? "deny" : "verify", name, `ledger ${result.verdict}, ${result.records.length} records, state ${result.state}`);
      onAudit();
    } catch (e) {
      setError(`Ledger can't be checked: ${(e as Error).message}`);
    }
  }

  // Re-verify when evidence or configuration changes: verification is never cached.
  useEffect(() => {
    if (ledger) void verify(ledger.name, ledger.raw);
  }, [evidence, authority, processes, successors]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadNewer(fileList: FileList) {
    const files = [...fileList];
    const results = await Promise.all(files.map(async (f) => verifyPackage(await read(f), trustStore, session.policy)));
    const found = successorsOf(baselineFrom(session.result), results);
    setSuccessors(found);
    await audit.append("load", "newer baselines", `${files.length} package(s) checked; ${found.length ? `superseded by ${found.map((x) => x.baselineId).join(", ")}` : "none supersedes this baseline"}`);
    onAudit();
    if (!found.length) setError(`None of ${files.map((f) => f.name).join(", ")} is a trusted baseline that supersedes ${m?.baseline.id}.`);
  }

  async function loadAcks(f: File) {
    if (!proposals) return setError("Load the proposals file first.");
    try {
      // With an authority loaded, acknowledgements must carry a signature by the source system's configured key.
      const trust = authority ? { trustStore, authority: authority.config } : undefined;
      const r = await importAcknowledgements(proposals, AckSet.parse(JSON.parse(await f.text())), trust);
      if (!trust) r.problems.push("no authority loaded: acknowledgement signatures were not checked");
      setSync({ rows: r.rows, problems: r.problems, changeRequests: r.changeRequests.length, signedBy: r.signedBy });
      await audit.append("load", f.name, `${r.rows.length} acknowledgements imported; baseline unchanged`);
      onAudit();
    } catch (e) {
      setError(`Acknowledgements rejected: ${(e as Error).message}`);
    }
  }

  if (!session.trusted) return null;
  if (!m) {
    return (
      <section className="workflow">
        <h2>Engineering workflow</h2>
        <p className="muted">This is a {session.manifest?.schema} package with no engineering model, so workflow records can't bind to it. Its contents are still viewable.</p>
      </section>
    );
  }

  const r = ledger?.result;
  const unit = r?.units.find((u) => u.key === selUnit)?.unit ?? (r?.units.length === 1 ? r.units[0]!.unit : undefined);
  const track = r ? trackOf(r.records, unit) : [];
  const unitState = unit ? r?.units.find((u) => unitLabel(u.unit) === unitLabel(unit))?.state : r?.units.length ? r.instanceState : r?.state;
  const st = r && ledger ? workflowStatus(r, ledger.ctx, unit) : null;
  const next = r && ledger ? nextActions(r, ledger.ctx, unit) : [];
  const stale = characteristicsNeedingGeometryReview(m);
  const inspection = track.filter((v) => v.record.data.kind === "inspection").at(-1);
  const plan = r?.records.filter((v) => v.record.data.kind === "plan").at(-1);
  const process = ledger?.ctx.process.definition;

  return (
    <section className="workflow">
      <h2>Engineering workflow</h2>
      {m.synthetic && <div className="banner info synthetic"><strong>SYNTHETIC</strong> {m.label}</div>}

      <div className="status-strip" role="status" aria-live="polite" aria-label="Workflow status">
        <Badge label="Package integrity" level="ok" text={`Verified: signatures, digests and engineering model (${session.manifest?.schema})`} />
        <Badge label="Baseline" level={successors.length ? "warn" : "ok"} text={successors.length ? `Superseded by ${successors[0]!.baselineId}: no new work; units in progress may finish` : "No newer baseline loaded (only loaded baselines are known)"} />
        <Badge label="Source release" level={st?.sourceRelease.level ?? "none"} text={st?.sourceRelease.text ?? "Not established: load a ledger with source release evidence"} />
        <Badge label="Operation authorized" level={st?.operation.level ?? "none"} text={st?.operation.text ?? "Not authorized: possessing a package grants nothing"} />
        <Badge label="Inspection" level={st?.inspection.level ?? "none"} text={st?.inspection.text ?? "Not inspected"} />
        <Badge label="Disposition" level={st?.disposition.level ?? "none"} text={st?.disposition.text ?? "No disposition"} />
      </div>

      <h3>Baseline and source authority</h3>
      <table className="kv">
        <tbody>
          <tr><th>Baseline</th><td><code>{m.baseline.id}</code> · item {m.baseline.item.itemId} rev {m.baseline.item.revision} · manifest <code>{short(session.result.manifestSha256)}</code></td></tr>
          <tr><th>Effectivity</th><td>{m.baseline.effectivity.kind === "serial" ? `serials ${m.baseline.effectivity.from} to ${m.baseline.effectivity.to}` : m.baseline.effectivity.kind === "lot" ? `lots ${m.baseline.effectivity.lots.join(", ")}` : "none"}</td></tr>
          {m.baseline.supersedes && <tr><th>Supersedes</th><td><code>{m.baseline.supersedes.baselineId}</code> (manifest <code>{short(m.baseline.supersedes.manifestSha256)}</code>); the prior baseline is unchanged</td></tr>}
          {m.sources.map((s) => (
            <tr key={s.id}><th>Source {s.id}</th><td>{s.system} · declares rev {s.declaredRevision} <em>{s.declaredReleaseState}</em> · captured by {s.capture} · {Object.entries(s.reference).map(([k, v]) => `${k}=${v}`).join(", ")}<div className="muted small">Declared by the package, not verified. Release is established only by a source-release record under the loaded authority.</div></td></tr>
          ))}
        </tbody>
      </table>

      <div className="row">
        <button onClick={() => void useLabConfig()}>Use lab authority and processes</button>
        <label className="button">Load newer baselines…<input type="file" accept=".tdp,.zip" multiple className="file-input" onChange={(e) => { if (e.target.files?.length) void loadNewer(e.target.files); e.target.value = ""; }} /></label>
        <label className="button">Load authority…<input type="file" accept=".json" className="file-input" onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadAuthorityFile(f); e.target.value = ""; }} /></label>
        <label className="button">Load process definitions…<input type="file" accept=".json" multiple className="file-input" onChange={(e) => { if (e.target.files?.length) void loadProcessFiles(e.target.files); e.target.value = ""; }} /></label>
      </div>
      {authority && (
        <p className={authority.config.fixture ? "muted" : ""}>
          Authority <strong>{authority.config.id}</strong> serial {authority.config.serial}{authority.signedBy ? `, signed by ${authority.signedBy.name}` : ", unsigned"} · issued {when(authority.config.issued)} · offline validity {authority.config.offlineValidityHours} h
          {authority.config.fixture && <span className="tag">LAB FIXTURE</span>}
          {" "}· processes: {processes.map((p) => `${p.definition.id} v${p.definition.version}`).join(", ") || "none"}
        </p>
      )}

      <h3>Requirements and characteristic traceability</h3>
      {stale.length > 0 && <div className="banner fail">Geometry review needed: {stale.map((s) => `${s.id} (${s.links.map((l) => `${l.id} ${l.status}`).join(", ")})`).join("; ")}. Planning is held until the plan records the review.</div>}
      <table className="trace">
        <thead><tr><th>Requirement</th><th>Characteristic</th><th>Limits</th><th>Geometry</th><th>Planned</th><th>Result</th></tr></thead>
        <tbody>
          {m.requirements.flatMap((req) => {
            const chars = req.characteristics.length ? req.characteristics : [null];
            return chars.map((cid, i) => {
              const c = cid ? m.characteristics.find((x) => x.id === cid)! : null;
              const res = cid ? inspection?.inspection?.results.find((x) => x.characteristic === cid) : undefined;
              return (
                <tr key={`${req.id}-${cid ?? "none"}`}>
                  {i === 0 && <td rowSpan={chars.length}><strong>{req.id}</strong> v{req.version}<div className="small">{req.title}</div><div className="muted small">{req.verification}</div></td>}
                  <td>{c ? <><code>{c.id}</code> {c.name}</> : <span className="muted">no measured characteristic</span>}</td>
                  <td>{c && `${c.lower} – ${c.upper} ${c.unit} (nom ${c.nominal}, ${c.decisionRule})`}</td>
                  <td>{c?.geometry?.map((g) => { const link = m.geometryLinks.find((x) => x.id === g)!; const s = geometryStatus(m, link); return <span key={g} className={`tag ${s}`} title={`${link.method}: ${link.selector} (${link.stability})`}>{g} {s}</span>; })}</td>
                  <td>{c && plan?.record.data.kind === "plan" ? (plan.record.data.inspectionPlan.some((p) => p.characteristic === c.id) ? "yes" : "no") : "—"}</td>
                  <td className={res?.result}>{res ? <>{res.result}{res.value !== undefined && ` (${res.value} ${c!.unit})`}<div className="muted small">{res.reasons.join("; ")}</div></> : "—"}</td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>

      <h3>Signed workflow records</h3>
      <p className="muted">Signed records travel in a ledger file beside the package, never inside it. They are separate from this viewer's local audit log below, which records only what this browser did.</p>
      <div className="row">
        <label className={`button ${authority ? "" : "disabled"}`}>Open ledger…<input type="file" accept=".json" className="file-input" disabled={!authority} onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { try { await verify(f.name, JSON.parse(await f.text())); } catch (err) { setError(`Ledger unreadable: ${(err as Error).message}`); } } }} /></label>
        <label className="button">Add evidence files…<input type="file" multiple className="file-input" onChange={(e) => { if (e.target.files?.length) void loadEvidence(e.target.files); e.target.value = ""; }} /></label>
        {evidence && <span className="muted">{evidence.count} evidence files hashed</span>}
      </div>
      {error && <div className="banner fail" role="alert">{error}</div>}
      {r && ledger && (
        <>
          <div className={`banner ${r.verdict === "verified" ? "pass" : r.verdict === "held" ? "info" : "fail"}`} data-ledger-verdict={r.verdict} role="status" aria-live="polite">
            <strong>LEDGER {r.verdict.toUpperCase()}</strong> {ledger.name}: {r.records.length} records{r.verdict === "held" ? " (some evidence not hash-checked: add the evidence files)" : ""}
          </div>
          <ul className="checks">
            {r.checks.filter((c) => c.status !== "pass").map((c) => <li key={c.id} className={c.status === "fail" ? "fail" : ""}><span>{c.status === "fail" ? "✗" : "!"}</span> {c.message}</li>)}
          </ul>
          {process && (
            <>
              <h3>Workflow state: {process.title} v{process.version}</h3>
              {r.units.length > 1 && (
                <label className="row">Unit
                  <select value={unit ? r.units.find((u) => unitLabel(u.unit) === unitLabel(unit))!.key : ""} onChange={(e) => setSelUnit(e.target.value)} aria-label="Unit">
                    <option value="">Instance level (shared steps)</option>
                    {r.units.map((u) => <option key={u.key} value={u.key}>{unitLabel(u.unit)}: {u.state}</option>)}
                  </select>
                </label>
              )}
              <ol className="states" aria-label="Workflow states">
                {process.states.map((s) => <li key={s} className={s === unitState ? "current" : track.some((v) => process.transitions.find((t) => t.id === v.record.action)?.outcomes[v.record.outcome] === s) ? "done" : ""} aria-current={s === unitState ? "step" : undefined}>{s.replace(/-/g, " ")}</li>)}
              </ol>
              {r.verdict !== "rejected" && (
                <table className="next">
                  <thead><tr><th>Next step</th><th>Who</th><th>Needs evidence</th><th>Prerequisites</th></tr></thead>
                  <tbody>
                    {next.map((n) => (
                      <tr key={n.transition} className={n.blockedBy.length ? "fail" : ""}>
                        <td><strong>{n.transition}</strong><div className="muted small">{n.description}</div></td>
                        <td>{n.roles.join(", ")}</td>
                        <td>{n.requiresEvidence.join(", ") || "—"}</td>
                        <td>{n.blockedBy.length ? <>BLOCKED: {n.blockedBy.join("; ")}</> : "met (an authorized actor may take it)"}</td>
                      </tr>
                    ))}
                    {!next.length && <tr><td colSpan={4} className="muted">No further steps from {unitState}.</td></tr>}
                  </tbody>
                </table>
              )}
              {r.verdict !== "rejected" && next.length > 0 && (
                <RecordStepForm ledgerName={ledger.name} raw={ledger.raw} result={r} ctx={ledger.ctx} unit={unit} audit={audit} onRecorded={(name, raw) => { void verify(name, raw); onAudit(); }} />
              )}
            </>
          )}
          <table className="records">
            <thead><tr><th>#</th><th>Step</th><th>Signed by</th><th>Time (signer's claim)</th><th>Unit</th><th>Evidence</th></tr></thead>
            <tbody>
              {r.records.map((v) => (
                <tr key={v.record.recordId} className={v.held.length ? "held" : ""}>
                  <td>{v.record.seq}</td>
                  <td><strong>{v.record.action}</strong> → {v.record.outcome}<div className="muted small">{v.record.reason}</div></td>
                  <td>{v.key.name}<div className="muted small">{v.record.actor.role} · {v.record.actor.organization}<br />via {v.via}</div></td>
                  <td><code>{when(v.record.at)}</code></td>
                  <td>{v.record.unit?.serial ?? v.record.unit?.lot ?? "—"}</td>
                  <td>{v.record.evidence.map((e) => <div key={e.id} className="small">{ledger.ctx.evidence?.has(e.sha256) ? "✓" : "?"} {e.tag} <code>{short(e.sha256)}</code>{e.synthetic && " (synthetic)"}</div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Build, inspection, nonconformance and disposition</h3>
          <ul className="events">
            {r.records.map((v) => {
              const d = v.record.data;
              if (d.kind === "queue-entry") return <li key={v.record.recordId}>Queued job <strong>{d.jobId}</strong>, file {d.submittedFile.name} <code>{short(d.submittedFile.sha256)}</code> (manual queue)</li>;
              if (d.kind === "build-start") return <li key={v.record.recordId}>Dispatched <strong>{d.jobId}</strong> to {d.resource} by hand at {when(d.startedAt)}</li>;
              if (d.kind === "build-complete") return <li key={v.record.recordId} className={v.record.outcome === "failed" ? "fail" : ""}>Build <strong>{d.jobId}</strong> {v.record.outcome} at {when(d.completedAt)}{d.errors.length ? `: ${d.errors.join("; ")}` : ""}</li>;
              if (d.kind === "inspection") return <li key={v.record.recordId}>Inspection by {v.key.name}: <strong>{v.record.outcome}</strong> under {d.decisionRules} ({d.measurements.length} measurements; instruments {[...new Set(d.measurements.map((x) => x.instrument?.id ?? "none"))].join(", ")})</li>;
              if (d.kind === "nonconformance") return <li key={v.record.recordId} className="fail">Nonconformance <strong>{d.ncrId}</strong>: {d.description}</li>;
              if (d.kind === "disposition") return <li key={v.record.recordId}>Disposition by {v.key.name}: <strong>{v.record.outcome}</strong>{d.ncrId ? ` under ${d.ncrId}` : ""}: {d.rationale}</li>;
              if (d.kind === "closure") return <li key={v.record.recordId}>Evidence closed{d.incorporation ? `; incorporated at occurrence ${d.incorporation.occurrence}${d.incorporation.parentUnit ? ` in ${d.incorporation.parentUnit}` : ""}` : ""}</li>;
              return null;
            })}
          </ul>
        </>
      )}

      <h3>Synchronization proposals</h3>
      <p className="muted">Proposed transactions for a source system, and its acknowledgements, exchanged as files. Importing them never changes this package or its ledger; nothing is sent from this browser.</p>
      <div className="row">
        <label className="button">Open proposals…<input type="file" accept=".json" className="file-input" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { try { setProposals(ProposalSet.parse(JSON.parse(await f.text()))); setSync(null); } catch (err) { setError(`Proposals rejected: ${(err as Error).message}`); } } }} /></label>
        <label className={`button ${proposals ? "" : "disabled"}`}>Import acknowledgements…<input type="file" accept=".json" className="file-input" disabled={!proposals} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void loadAcks(f); }} /></label>
      </div>
      {proposals && (
        <table className="sync">
          <thead><tr><th>Transaction</th><th>Target</th><th>Expected version</th><th>State</th><th>Note</th></tr></thead>
          <tbody>
            {(sync?.rows ?? proposals.transactions.map((tx) => ({ tx, state: tx.status === "proposed" ? "pending" : tx.status }) as ReconciliationRow)).map((row) => (
              <tr key={row.tx.txId} className={["conflict", "rejected", "unsupported", "held-lossy"].includes(row.state) ? "fail" : ""}>
                <td><code>{row.tx.txId.slice(0, 15)}…</code> {row.tx.operation}</td>
                <td>{row.tx.target.objectType}/{row.tx.target.objectId.slice(0, 24)}</td>
                <td>{row.tx.expectedVersion ?? "new"}</td>
                <td data-sync-state={row.state}><strong>{row.state}</strong>{row.ack?.originalStatus ? ` (was ${row.ack.originalStatus})` : ""}</td>
                <td className="small">{row.ack?.reason ?? (row.tx.lossy.length ? `lossy: ${row.tx.lossy.map((l) => l.field).join(", ")}` : "")}{row.ack?.requiresNewBaseline ? " Needs a newly published baseline." : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sync?.signedBy && <p className="signed">✓ Acknowledgements signed by {sync.signedBy}, a key the authority names for this source system</p>}
      {sync?.problems.map((p) => <div key={p} className="banner fail">{p}</div>)}
      {sync && sync.changeRequests > 0 && <p className="muted">{sync.changeRequests} change request(s) accepted for review at the source. The released baseline is unchanged; an approved change takes a newly published baseline.</p>}
    </section>
  );
}
