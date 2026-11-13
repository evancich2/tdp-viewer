import { Suspense, lazy, useEffect, useState } from "react";
import { utf8 } from "../core/bytes";
import type { ManifestFile } from "../core/schema";
import type { PackageSession } from "../core/session";
import { PrintPanel } from "./PrintPanel";

// pdf.js and three.js are loaded only when a drawing or model is opened.
const DrawingViewer = lazy(() => import("./DrawingViewer").then((m) => ({ default: m.DrawingViewer })));
const ModelViewer = lazy(() => import("./ModelViewer").then((m) => ({ default: m.ModelViewer })));

type State =
  | { kind: "loading" }
  | { kind: "denied"; message: string }
  | { kind: "ready"; file: ManifestFile; bytes: Uint8Array };

/** Every preview goes through PackageSession.openFile, which re-checks the digest and logs the access. */
export function FilePreview({ session, path, onAccess }: { session: PackageSession; path: string; onAccess: () => void }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    session
      .openFile(path, "preview")
      .then((r) => !cancelled && setState({ kind: "ready", ...r }))
      .catch((e: Error) => !cancelled && setState({ kind: "denied", message: e.message }))
      .finally(onAccess);
    return () => { cancelled = true; };
  }, [session, path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === "loading") return <p className="muted">Verifying {path}…</p>;
  if (state.kind === "denied") return <div className="banner fail">Access denied: {state.message}</div>;

  const { file, bytes } = state;
  return (
    <div className="preview">
      <h3>{file.path}</h3>
      <p className="muted">
        {file.mediaType} · {bytes.length.toLocaleString()} bytes · SHA-256 <code>{file.sha256.slice(0, 16)}…</code>
      </p>
      {file.mediaType === "application/pdf" ? (
        <Suspense fallback={<p className="muted">Loading drawing viewer…</p>}>
          <DrawingViewer file={file} bytes={bytes} />
        </Suspense>
      ) : file.mediaType === "model/step" ? (
        <>
          <Suspense fallback={<p className="muted">Loading 3D viewer…</p>}>
            <ModelViewer file={file} bytes={bytes} />
          </Suspense>
          <PrintPanel session={session} file={file} onAccess={onAccess} />
          <details>
            <summary>STEP source</summary>
            <pre>{utf8.decode(bytes)}</pre>
          </details>
        </>
      ) : (
        <pre>{utf8.decode(bytes)}</pre>
      )}
    </div>
  );
}
