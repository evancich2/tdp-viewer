import { useEffect, useRef, useState } from "react";
import {
  AuditLog,
  PackageSession,
  defaultPolicy,
  loadAnchors,
  loadTrustStoreFile,
  type Anchors,
  type AuditEntry,
  type RootKey,
  type TrustStore,
} from "../core";
import demoAnchors from "../../samples/anchors.json?raw";
import demoTrustStore from "../../samples/trust-store.signed.json?raw";
import { BomTree } from "./BomTree";
import { ComparePanel } from "./ComparePanel";
import { FilePreview } from "./FilePreview";
import { onInstallAvailable, onLaunchFiles, registerServiceWorker } from "../pwa/client";
import { fingerprint, forget, recall, recordSerial, remember, seenSerials } from "./trustMemory";

interface PinnedRoots {
  anchors: Anchors;
  json: string;
  label: string;
}

const readFile = (f: File) => f.arrayBuffer().then((b) => new Uint8Array(b));

export function App() {
  const [trust, setTrust] = useState<{
    store: TrustStore;
    label: string;
    json: string;
    fingerprint: string;
    signedBy?: RootKey;
  } | null>(null);
  const [roots, setRoots] = useState<PinnedRoots | null>(null);
  const [remembered, setRemembered] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);
  const [install, setInstall] = useState<(() => Promise<void>) | null>(null);
  const [session, setSession] = useState<PackageSession | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [auditEntries, setAuditEntries] = useState<readonly AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [audit] = useState(() => new AuditLog());

  const refreshAudit = async () => setAuditEntries(await audit.list());

  /** Pins the organization roots that must sign trust stores. Any trust store already loaded is re-checked. */
  async function pinRoots(json: string, label: string): Promise<PinnedRoots | null> {
    try {
      const pinned = { anchors: await loadAnchors(json), json, label };
      setRoots(pinned);
      setTrust(null);
      setSession(null);
      forget();
      setRemembered(false);
      setError(null);
      await audit.append("trust", label, `pinned roots: ${pinned.anchors.roots.map((r) => `${r.name} (${r.keyId})`).join(", ")}`);
      await refreshAudit();
      return pinned;
    } catch (e) {
      setError(`Root keys rejected: ${(e as Error).message}`);
      return null;
    }
  }

  async function applyTrustStore(json: string, label: string, fromMemory = false, pinned = roots) {
    try {
      const loaded = await loadTrustStoreFile(json, { anchors: pinned?.anchors, seenSerials: seenSerials() });
      const { store, signedBy } = loaded;
      if (signedBy) recordSerial(signedBy.keyId, store.serial!);
      const fp = await fingerprint(json);
      setTrust({ store, label, json, fingerprint: fp, signedBy });
      setRemembered(fromMemory);
      if (!fromMemory) forget();
      setSession(null);
      setError(null);
      const how = signedBy ? `signed by ${signedBy.name}, serial ${store.serial}, expires ${store.expires}` : "unsigned";
      await audit.append("trust", label, `${store.keys.length} keys, ${how}, fingerprint ${fp}${fromMemory ? ", remembered on this device" : ""}`);
      await refreshAudit();
    } catch (e) {
      if (fromMemory) forget();
      setError(`Trust store rejected: ${(e as Error).message}`);
    }
  }

  async function useDemoKeys() {
    const pinned = await pinRoots(demoAnchors, "demo root (samples/anchors.json)");
    if (pinned) await applyTrustStore(demoTrustStore, "demo keys (samples/trust-store.signed.json)", false, pinned);
  }

  function toggleRemember(on: boolean) {
    if (!trust) return;
    if (on && !remember({ json: trust.json, label: trust.label, anchorsJson: roots?.json })) {
      setError("This browser won't store data for this site, so the trust store can't be remembered.");
      return;
    }
    if (!on) forget();
    setRemembered(on);
  }

  async function openPackage(file: File) {
    if (!trust) return;
    setSelected(null);
    setPendingFile(null);
    setSession(await PackageSession.open(file.name, await readFile(file), trust.store, defaultPolicy, audit));
    await refreshAudit();
  }

  // One-time setup: restore a remembered trust store, then the PWA hooks.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const saved = recall();
    if (saved)
      void (async () => {
        let pinned: PinnedRoots | null = null;
        if (saved.anchorsJson) {
          try {
            pinned = { anchors: await loadAnchors(saved.anchorsJson), json: saved.anchorsJson, label: "remembered roots" };
            setRoots(pinned);
          } catch {
            forget();
            return;
          }
        }
        await applyTrustStore(saved.json, saved.label, true, pinned);
      })();
    registerServiceWorker((apply) => setApplyUpdate(() => apply));
    onInstallAvailable((fn) => setInstall(() => fn));
    onLaunchFiles((file) => setPendingFile(file));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A file opened from the OS waits until a trust store is chosen.
  useEffect(() => {
    if (pendingFile && trust) void openPackage(pendingFile);
  }, [pendingFile, trust]); // eslint-disable-line react-hooks/exhaustive-deps

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
      {applyUpdate && (
        <div className="banner info row">
          <span>A new, verified version of TDP Viewer is ready.</span>
          <button onClick={applyUpdate}>Reload to update</button>
        </div>
      )}

      <header className="row spread">
        <div>
          <h1>TDP Viewer</h1>
          <p className="muted">Runs entirely in your browser and works offline. Files are never uploaded.</p>
        </div>
        {install && <button onClick={() => void install()}>Install app</button>}
      </header>

      {pendingFile && !trust && (
        <div className="banner info">Choose a trust store to open <strong>{pendingFile.name}</strong>.</div>
      )}

      <section className="step">
        <h2>1. Trust store</h2>
        <p className="muted">
          The signing keys you trust. A package can't supply its own. Pin your organization's root key first and only trust
          stores it signed will be accepted.
        </p>
        <div className="row">
          <label className="button">
            Pin root keys…
            <input type="file" accept=".json" hidden
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) await pinRoots(await f.text(), f.name); e.target.value = ""; }} />
          </label>
          {roots ? (
            <span>
              Pinned: {roots.anchors.roots.map((r) => <strong key={r.keyId}>{r.name} </strong>)}
              <button className="link small" onClick={() => { setRoots(null); setTrust(null); setSession(null); forget(); setRemembered(false); }}>
                Unpin
              </button>
            </span>
          ) : (
            <span className="muted">No root pinned: any trust store you load is trusted as-is.</span>
          )}
        </div>
        <div className="row">
          <label className="button">
            Load trust store…
            <input type="file" accept=".json" hidden
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) await applyTrustStore(await f.text(), f.name); e.target.value = ""; }} />
          </label>
          <button onClick={() => void useDemoKeys()}>Use demo keys</button>
          {trust && <span>Using <strong>{trust.label}</strong>: {trust.store.keys.length} keys · fingerprint <code>{trust.fingerprint}</code></span>}
        </div>
        {trust && (
          <p className={trust.signedBy ? "signed" : "muted"}>
            {trust.signedBy
              ? `✓ Signed by ${trust.signedBy.name} · serial ${trust.store.serial} · expires ${trust.store.expires!.slice(0, 10)}`
              : "Unsigned trust store: you are vouching for every key in it yourself."}
          </p>
        )}
        {trust && (
          <label className="row muted">
            <input type="checkbox" checked={remembered} onChange={(e) => toggleRemember(e.target.checked)} />
            Remember this trust store on this device (so .tdp files open directly)
          </label>
        )}
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
