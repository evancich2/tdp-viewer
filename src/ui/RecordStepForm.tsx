import { useEffect, useMemo, useState } from "react";
import {
  KIND_OUTCOMES,
  LedgerFile,
  RecordData,
  TransitionDenied,
  appendRecord,
  nextActions,
  unlockKeyFile,
  type AuditLog,
  type EvidenceRef,
  type LedgerResult,
  type PhysicalUnitRef,
  type RecordKind,
  type UnlockedKey,
  type WorkflowContext,
} from "../core";

/** Starting points for each record kind's data. The gate, not this form, decides what is acceptable. */
function template(kind: RecordKind, ctx: WorkflowContext, result: LedgerResult): unknown {
  const m = ctx.baseline.model;
  const item = result.instance?.item ?? m.baseline.item;
  const last = (k: string) => [...result.records].reverse().find((v) => v.record.data.kind === k)?.record.recordId ?? "<record id>";
  const now = ctx.now.toISOString();
  switch (kind) {
    case "requirements-approval": return { kind, requirements: m.requirements.filter((r) => r.appliesTo.itemId === item.itemId).map((r) => ({ id: r.id, version: r.version })) };
    case "source-release": { const it = m.items.find((i) => i.itemId === item.itemId); const src = m.sources.find((s) => s.id === it?.source); return { kind, source: src?.id ?? "", system: src?.system ?? "lab-fixture", reference: src?.reference ?? {}, revision: item.revision, releaseState: src?.declaredReleaseState ?? "", attestation: src?.system === "lab-fixture" ? "lab-fixture" : "manual-transcription" }; }
    case "suitability": return { kind, input: { resource: { id: "", model: "", firmware: null, buildVolumeMm: [300, 320, 320] }, material: { name: "" }, profile: { name: "" }, orientation: "", scope: "", capabilities: [], calibration: [], declaredGaps: [] } };
    case "suitability-review": return { kind, suitabilityRecord: last("suitability"), acceptedGaps: [], rationale: "" };
    case "plan": return { kind, buildPlanId: "", settings: {}, inspectionPlan: m.characteristics.filter((c) => c.item.itemId === item.itemId).map((c) => ({ characteristic: c.id, method: "", instrumentClass: "" })), geometryReview: [] };
    case "authorization": return { kind, cipId: "", operations: ctx.process.definition.operations, organizations: [], roles: [], units: { serials: [] }, notBefore: now, notAfter: now, policyVersion: ctx.process.definition.version };
    case "queue-entry": return { kind, jobId: "", submittedFile: { name: "", sha256: "" }, settings: {} };
    case "build-start": return { kind, jobId: "", resource: "", startedAt: now };
    case "build-complete": return { kind, jobId: "", submittedFileSha256: "", startedAt: now, completedAt: now, errors: [], settings: {} };
    case "inspection": return { kind, decisionRules: "core/decision-rules/0.1", measurements: [] };
    case "nonconformance": return { kind, ncrId: "", inspectionRecord: last("inspection"), characteristics: [], description: "" };
    case "disposition": return { kind, inspectionRecord: last("inspection"), rationale: "" };
    case "closure": return { kind, summary: "" };
  }
}

const mediaTypeFor = (name: string) => ({ json: "application/json", csv: "text/csv", txt: "text/plain", pdf: "application/pdf", stp: "model/step", step: "model/step", "3mf": "model/3mf" } as Record<string, string>)[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

interface Props {
  ledgerName: string;
  raw: unknown;
  result: LedgerResult;
  ctx: WorkflowContext;
  unit?: PhysicalUnitRef;
  audit: AuditLog;
  onRecorded: (name: string, raw: unknown) => void;
}

/**
 * Signs one workflow record in the browser. The key file is decrypted in memory with the passphrase
 * and imported non-extractable; it is never stored or sent. `appendRecord` runs the same gate as the
 * CLI, so this form can't produce anything the gate forbids: it only collects the inputs.
 */
export function RecordStepForm({ ledgerName, raw, result, ctx, unit, audit, onRecorded }: Props) {
  const [key, setKey] = useState<UnlockedKey | null>(null);
  const [keyJson, setKeyJson] = useState<string | null>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const actions = useMemo(() => nextActions(result, ctx, unit), [result, ctx, unit]);
  const [action, setAction] = useState(actions[0]?.transition ?? "");
  const t = ctx.process.definition.transitions.find((x) => x.id === action);
  const [role, setRole] = useState("");
  const [outcome, setOutcome] = useState("");
  const [serial, setSerial] = useState(unit?.serial ?? "");
  const [reason, setReason] = useState("");
  const [data, setData] = useState("");
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function pick(id: string) {
    setAction(id);
    const tr = ctx.process.definition.transitions.find((x) => x.id === id);
    if (!tr) return;
    setRole(tr.roles[0] ?? "");
    setOutcome(Object.keys(tr.outcomes)[0] ?? "");
    setData(JSON.stringify(template(tr.kind, ctx, result), null, 2));
  }
  // Keep the chosen step valid as the ledger moves on.
  const ids = actions.map((a) => a.transition).join(",");
  useEffect(() => {
    const keep = actions.find((a) => a.transition === action);
    pick(keep?.transition ?? actions[0]?.transition ?? "");
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  async function unlock() {
    if (!keyJson) return;
    setBusy("Unlocking key…");
    try {
      const k = await unlockKeyFile(keyJson, pass);
      setKey(k);
      setPass("");
      setMessage(null);
      await audit.append("trust", k.name, `signing key ${k.keyId} unlocked for this session (memory only)`);
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    if (!key || !t) return;
    setBusy("Checking and signing…");
    setMessage(null);
    try {
      const parsed = RecordData.parse(JSON.parse(data));
      const evidence: EvidenceRef[] = Object.entries(chosen).map(([sha, tag], i) => {
        const f = ctx.evidence!.get(sha)!;
        return { id: `EV-${i + 1}`, tag, sha256: sha, mediaType: mediaTypeFor(f.name), description: f.name, synthetic: false };
      });
      const u = t.requires.unit || serial ? { serial } : undefined;
      const out = await appendRecord(LedgerFile.parse(raw), { ...ctx, now: new Date() }, key, { action: t.id, role, outcome, reason, data: parsed, unit: u, evidence });
      await audit.append("verify", ledgerName, `signed record ${out.record.seq} ${out.record.action} → ${out.record.outcome} as ${role} with ${key.name}, sha256 ${out.sha256}`);
      setMessage({ ok: true, text: `Signed record ${out.record.seq}: ${out.record.action} → ${out.record.outcome}. Download the updated ledger to keep it.` });
      setReason("");
      setChosen({});
      onRecorded(ledgerName, out.ledger);
    } catch (e) {
      const denied = e instanceof TransitionDenied;
      await audit.append("deny", ledgerName, `${action} by ${key.name}: ${(e as Error).message}`);
      setMessage({ ok: false, text: `${denied ? "DENIED, nothing signed: " : ""}${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  const noEvidence = !ctx.evidence;
  return (
    <div className="record-form">
      <h3>Record a step</h3>
      <p className="muted small">
        Signs in this browser with your key file. The passphrase and key stay in memory for this session only. The same gate as
        the CLI decides; a step it forbids is refused and nothing is signed.
      </p>
      <div className="row">
        <label className="button">Signing key file…<input type="file" accept=".json" className="file-input" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { setKeyJson(await f.text()); setKey(null); } }} /></label>
        {keyJson && !key && (
          <>
            <label className="row">Passphrase <input type="password" value={pass} autoComplete="off" onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void unlock()} /></label>
            <button disabled={!pass || !!busy} onClick={() => void unlock()}>Unlock</button>
          </>
        )}
        {key && <span>Signing as <strong>{key.name}</strong> <button className="link small" onClick={() => { setKey(null); setKeyJson(null); }}>Forget key</button></span>}
      </div>
      {noEvidence && <p className="muted">Add the evidence files first: recording needs every referenced file hash-checked.</p>}
      {key && !noEvidence && (
        <div className="form-grid">
          <label>Step
            <select value={action} onChange={(e) => pick(e.target.value)}>
              {actions.map((a) => <option key={a.transition} value={a.transition}>{a.transition}{a.blockedBy.length ? " (blocked)" : ""}</option>)}
            </select>
          </label>
          {t && <>
            <label>Workflow role<select value={role} onChange={(e) => setRole(e.target.value)}>{t.roles.map((r) => <option key={r}>{r}</option>)}</select></label>
            <label>Outcome<select value={outcome} onChange={(e) => setOutcome(e.target.value)}>{Object.keys(t.outcomes).filter((o) => (KIND_OUTCOMES[t.kind] as readonly string[]).includes(o)).map((o) => <option key={o}>{o}</option>)}</select></label>
            {t.requires.unit && <label>Serial<input value={serial} onChange={(e) => setSerial(e.target.value)} /></label>}
            <label className="wide">Reason<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            <label className="wide">Data ({t.kind})<textarea rows={8} spellCheck={false} value={data} onChange={(e) => setData(e.target.value)} /></label>
            <fieldset className="wide">
              <legend>Evidence {t.requires.evidence.length > 0 && <span className="muted small">(needs: {t.requires.evidence.join(", ")})</span>}</legend>
              {[...ctx.evidence!.entries()].map(([sha, f]) => (
                <div key={sha} className="row small">
                  <label className="row"><input type="checkbox" checked={sha in chosen} onChange={(e) => setChosen((c) => { const n = { ...c }; if (e.target.checked) n[sha] = t.requires.evidence[0] ?? "evidence"; else delete n[sha]; return n; })} /> {f.name}</label>
                  {sha in chosen && <input aria-label={`tag for ${f.name}`} value={chosen[sha]} onChange={(e) => setChosen((c) => ({ ...c, [sha]: e.target.value }))} />}
                </div>
              ))}
            </fieldset>
            <div className="wide row">
              <button disabled={!!busy || !reason} onClick={() => void submit()}>Check and sign</button>
              <button onClick={() => download(ledgerName.replace(/(\.ledger)?\.json$/, "") + ".ledger.json", JSON.stringify(raw, null, 2) + "\n")}>Download ledger</button>
            </div>
          </>}
        </div>
      )}
      {busy && <p className="muted" aria-live="polite">{busy}</p>}
      {message && <div className={`banner ${message.ok ? "pass" : "fail"}`} role="status">{message.text}</div>}
    </div>
  );
}
