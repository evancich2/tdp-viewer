import { useState } from "react";
import { AuditLog, PackageSession, defaultPolicy, loadTrustStore, type AuditEntry, type TrustStore } from "../core";
import demoTrustStore from "../../samples/trust-store.json?raw";
import { BomTree } from "./BomTree";
import { ComparePanel } from "./ComparePanel";
import { FilePreview } from "./FilePreview";

const readFile = (f: File) => f.arrayBuffer().then((b) => new Uint8Array(b));

export function App() {
  const [trust, setTrust] = useState<{ store: TrustStore; label: string } | null>(null);
  const [session, setSession] = useState<PackageSession | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [auditEntries, setAuditEntries] = useState<readonly AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [audit] = useState(() => new AuditLog());

  const refreshAudit = async () => setAuditEntries(await audit.list());

  async function applyTrustStore(json: string, label: string) {
    try {
      setTrust({ store: await loadTrustStore(json), label });
      setSession(null);
      setError(null);
    } catch (e) {
      setError(`Trust store rejected: ${(e as Error).message}`);
    }
  }

  async function openPackage(file: File) {
    if (!trust) return;
    setSelected(null);
    setSession(await PackageSession.open(file.name, await readFile(file), trust.store, defaultPolicy, audit));
    await refreshAudit();
  }

  function exportAudit() {
    const blob = new Blob([JSON.stringify(auditEntries, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tdp-audit-log.json";
    a.click();
    URL.revokeObjectURL(a.href);
    void audit.append("export", "audit log", `${auditEntries.length} entries`).then(refreshAudit);
  }

  const m = session?.manifest;

  return (
    <div className="app">
      <header>
        <h1>TDP Viewer</h1>
        <p className="muted">Runs entirely in your browser. Files are never uploaded.</p>
      </header>

      <section className="step">
        <h2>1. Trust store</h2>
        <p className="muted">The signing keys you trust. A package can't supply its own.</p>
        <div className="row">
          <label className="button">
            Load trust store…
            <input type="file" accept=".json" hidden
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) await applyTrustStore(await f.text(), f.name); }} />
          </label>
          <button onClick={() => applyTrustStore(demoTrustStore, "demo keys (samples/trust-store.json)")}>Use demo keys</button>
          {trust && <span>Using <strong>{trust.label}</strong>: {trust.store.keys.length} keys</span>}
        </div>
      </section>

      <section className="step">
        <h2>2. Package</h2>
        <label className={`button ${trust ? "" : "disabled"}`}>
          Open .tdp package…
          <input type="file" accept=".tdp,.zip" hidden disabled={!trust}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void openPackage(f); e.target.value = ""; }} />
        </label>
      </section>

      {error && <div className="banner fail">{error}</div>}

      {session && (
        <>
          <div className={`banner ${session.trusted ? "pass" : "fail"}`}>
            <strong>{session.trusted ? "TRUSTED" : "REJECTED"}</strong> {session.name}
            {!session.trusted && " — nothing in this package can be opened."}
          </div>

          <section>
            <h2>Checks</h2>
            <ul className="checks">
              {session.result.checks.map((c) => (
                <li key={c.id} className={c.status}><span>{c.status === "pass" ? "✓" : "✗"}</span> {c.message}</li>
              ))}
            </ul>
          </section>

          {m && (
            <div className="columns">
              <section>
                <h2>{m.package.title}</h2>
                <p>P/N {m.package.partNumber} · Rev {m.package.revision}</p>
                {m.package.distribution && <p className="muted">{m.package.distribution}</p>}
                <h3>Bill of materials</h3>
                <BomTree items={m.bom} onSelectFile={setSelected} />
                <h3>Files</h3>
                <table>
                  <thead><tr><th>Path</th><th>Type</th><th>Status</th></tr></thead>
                  <tbody>
                    {session.result.files.map((f) => {
                      const meta = m.files.find((x) => x.path === f.path);
                      return (
                        <tr key={f.path} className={f.ok ? "" : "fail"}>
                          <td>
                            <button className="link" disabled={!session.trusted} onClick={() => setSelected(f.path)}>{f.path}</button>
                          </td>
                          <td>{meta?.mediaType ?? "—"}</td>
                          <td>{f.ok ? "ok" : f.problems.join("; ")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
              <section>
                {selected
                  ? <FilePreview session={session} path={selected} onAccess={refreshAudit} />
                  : <p className="muted">Select a file to view it.</p>}
              </section>
            </div>
          )}
        </>
      )}

      {session?.trusted && trust && (
        <ComparePanel key={session.name + session.result.manifestSha256} session={session} trustStore={trust.store} audit={audit} onAccess={refreshAudit} />
      )}

      <section>
        <h2>Audit log</h2>
        <p className="muted">Hash-chained record of every load, check and file access this session.</p>
        <button disabled={!auditEntries.length} onClick={exportAudit}>Export audit log</button>
        <ol className="audit">
          {auditEntries.map((e) => (
            <li key={e.seq}><code>{e.time}</code> <strong>{e.action}</strong> {e.subject} <span className="muted">{e.detail}</span></li>
          ))}
        </ol>
      </section>
    </div>
  );
}
