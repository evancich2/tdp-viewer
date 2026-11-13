import { useState } from "react";
import { PRINTERS, exportForPrint, type ManifestFile, type PackageSession, type PrintExport } from "../core";
import { workerMesher } from "../mesh/client";

type State = { kind: "idle" } | { kind: "working" } | { kind: "done"; out: PrintExport } | { kind: "error"; message: string };

const mm = (v: number) => `${Math.round(v * 10) / 10}`;

function download(name: string, bytes: Uint8Array) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "model/3mf" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Converts a verified STEP model into a 3MF that Bambu Studio (or any 3MF slicer) opens directly. */
export function PrintPanel({ session, file, onAccess }: { session: PackageSession; file: ManifestFile; onAccess: () => void }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [printerId, setPrinterId] = useState(PRINTERS[0]!.id);
  const printer = PRINTERS.find((p) => p.id === printerId)!;

  async function run() {
    setState({ kind: "working" });
    try {
      const out = await exportForPrint(session, file.path, workerMesher, { printer });
      download(out.fileName, out.bytes);
      setState({ kind: "done", out });
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    } finally {
      onAccess();
    }
  }

  return (
    <div className="print">
      <h3>3D print</h3>
      <p className="muted">
        Exports a 3MF with this package's part number, revision and digests embedded. Open it in Bambu Studio to slice and
        send it to your printer.
      </p>
      <p className="muted small">
        Exporting a build file does not authorize manufacture. Authorization comes only from a verified, in-date CIP in the part's
        workflow ledger; the build itself is recorded there as manual queue and build records.
      </p>
      <div className="row">
        <label className="row">
          Printer
          <select value={printerId} onChange={(e) => { setPrinterId(e.target.value); setState({ kind: "idle" }); }}>
            {PRINTERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <button disabled={state.kind === "working" || !session.policy.print.allowExport} onClick={run}>
          {state.kind === "working" ? "Meshing…" : "Export 3MF for Bambu Studio"}
        </button>
      </div>
      {printer.buildVolume.every(Number.isFinite) && (
        <p className="muted">
          Build volume checked: {printer.buildVolume.join(" × ")} mm. {printer.note}
        </p>
      )}
      {state.kind === "error" && <div className="banner fail">{state.message}</div>}
      {state.kind === "done" && (
        <div className={`banner ${state.out.fits ? "pass" : "fail"}`}>
          {!state.out.fits && <p><strong>Too large for the {state.out.printer.name}</strong> in any orientation. Split or scale it in the slicer.</p>}
          Saved <strong>{state.out.fileName}</strong> (SHA-256 <code>{state.out.sha256.slice(0, 16)}…</code>)
          <ul>
            {state.out.meshes.map((m, i) => (
              <li key={i}>
                {m.name}: {m.stats.triangles} triangles, {mm(m.stats.max[0] - m.stats.min[0])} ×{" "}
                {mm(m.stats.max[1] - m.stats.min[1])} × {mm(m.stats.max[2] - m.stats.min[2])} mm
                {m.stats.watertight ? ", watertight" : ", NOT watertight"}
                {m.fit.fits ? "" : ", does not fit"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
