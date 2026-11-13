import { Suspense, lazy, useState } from "react";
import type { AuditLog } from "../core/audit";
import { diffManifests, type PackageDiff } from "../core/diff";
import type { TrustStore } from "../core/schema";
import { PackageSession } from "../core/session";
import { defaultPolicy } from "../core/policy";

const DrawingCompare = lazy(() => import("./DrawingCompare").then((m) => ({ default: m.DrawingCompare })));

type State =
  | { kind: "idle" }
  | { kind: "rejected"; name: string; reasons: string[] }
  | { kind: "diff"; older: PackageSession; newer: PackageSession; diff: PackageDiff };

/** Compares the open package with another revision. The other package must verify first. */
export function ComparePanel({
  session,
  trustStore,
  audit,
  onAccess,
}: {
  session: PackageSession;
  trustStore: TrustStore;
  audit: AuditLog;
  onAccess: () => void;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [drawings, setDrawings] = useState<{ before: string; after: string } | null>(null);

  async function compare(file: File) {
    const other = await PackageSession.open(file.name, new Uint8Array(await file.arrayBuffer()), trustStore, defaultPolicy, audit);
    onAccess();
    if (!other.trusted) {
      setState({ kind: "rejected", name: file.name, reasons: other.result.checks.filter((c) => c.status === "fail").map((c) => c.message) });
      return;
    }
    // Show older → newer regardless of which was opened first.
    const [a, b] = [session.manifest!, other.manifest!];
    const otherIsOlder = b.package.created < a.package.created;
    const [older, newer] = otherIsOlder ? [other, session] : [session, other];
    setDrawings(null);
    setState({ kind: "diff", older, newer, diff: diffManifests(older.manifest!, newer.manifest!) });
  }

  return (
    <section className="compare">
      <h2>Compare revisions</h2>
      <label className="button">
        Compare with another package…
        <input type="file" accept=".tdp,.zip" className="file-input"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void compare(f); e.target.value = ""; }} />
      </label>

      {state.kind === "rejected" && (
        <div className="banner fail">
          <strong>REJECTED</strong> {state.name}: can't compare against a package that doesn't verify.
          <ul>{state.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      {state.kind === "diff" && (
        <>
          <DiffView diff={state.diff} onCompareDrawings={(before, after) => setDrawings({ before, after })} />
          {drawings && (
            <Suspense fallback={<p className="muted">Loading drawing compare…</p>}>
              <DrawingCompare
                key={drawings.before + drawings.after}
                older={{ session: state.older, path: drawings.before }}
                newer={{ session: state.newer, path: drawings.after }}
                onAccess={onAccess}
              />
            </Suspense>
          )}
        </>
      )}
    </section>
  );
}

function DiffView({ diff, onCompareDrawings }: { diff: PackageDiff; onCompareDrawings: (before: string, after: string) => void }) {
  const nothing = !diff.package.length && !diff.files.length && !diff.bom.length;
  return (
    <div className="diff">
      {nothing && <p>No differences.</p>}
      {diff.package.length > 0 && (
        <ul>
          {diff.package.map((c) => (
            <li key={c.field}>Package {c.field}: <del>{c.before ?? "—"}</del> → <ins>{c.after ?? "—"}</ins></li>
          ))}
        </ul>
      )}
      {diff.bom.length > 0 && (
        <>
          <h3>Parts</h3>
          <table>
            <thead><tr><th>Change</th><th>Part</th><th>Details</th></tr></thead>
            <tbody>
              {diff.bom.map((c) =>
                c.kind === "changed" ? (
                  <tr key={c.after.partNumber} className="changed">
                    <td>changed</td><td>{c.after.partNumber}</td>
                    <td>{c.fields.map((f) => f === "files"
                      ? "files"
                      : `${f}: ${String(c.before[f as "revision"] ?? "—")} → ${String(c.after[f as "revision"] ?? "—")}`).join(", ")}</td>
                  </tr>
                ) : (
                  <tr key={c.item.partNumber} className={c.kind}>
                    <td>{c.kind}</td><td>{c.item.partNumber}</td><td>rev {c.item.revision} · {c.item.name} × {c.item.quantity}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </>
      )}
      {diff.files.length > 0 && (
        <>
          <h3>Files</h3>
          <table>
            <thead><tr><th>Change</th><th>File</th></tr></thead>
            <tbody>
              {diff.files.map((c) =>
                "file" in c ? (
                  <tr key={c.kind + c.file.path} className={c.kind}><td>{c.kind}</td><td>{c.file.path}</td></tr>
                ) : (
                  <tr key={c.kind + c.after.path} className={c.kind}>
                    <td>{c.kind}</td>
                    <td>
                      {c.before.path === c.after.path ? c.after.path : <>{c.before.path} → {c.after.path}</>}
                      {c.kind !== "moved" && c.before.mediaType === "application/pdf" && c.after.mediaType === "application/pdf" && (
                        <button className="link small" onClick={() => onCompareDrawings(c.before.path, c.after.path)}>
                          Compare drawings
                        </button>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </>
      )}
      <p className="muted">{diff.unchangedFiles} files unchanged.</p>
    </div>
  );
}
