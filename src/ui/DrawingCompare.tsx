import { useEffect, useRef, useState } from "react";
import { overlay, type OverlayResult } from "../core/imagediff";
import type { PackageSession } from "../core/session";
import { openPdf, renderPage } from "./pdf";

export interface DrawingSide {
  session: PackageSession;
  path: string;
}

type Mode = "overlay" | "older" | "newer";

const RENDER_WIDTH = 1100;

/**
 * Overlays two revisions of a drawing: red is only in the older revision, green only in the
 * newer one, gray in both. Both files are read through PackageSession.openFile, so each is
 * re-verified and the access is logged.
 */
export function DrawingCompare({ older, newer, onAccess }: { older: DrawingSide; newer: DrawingSide; onAccess: () => void }) {
  const [images, setImages] = useState<{ older: ImageData; newer: ImageData; diff: OverlayResult; pages: [number, number] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("overlay");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    const closers: (() => void)[] = [];
    (async () => {
      const [a, b] = await Promise.all([
        older.session.openFile(older.path, "drawing compare"),
        newer.session.openFile(newer.path, "drawing compare"),
      ]);
      onAccess();
      if (cancelled) return; // closed while the files were being read: don't start workers nobody will close
      const pa = openPdf(a.bytes);
      const pb = openPdf(b.bytes);
      closers.push(pa.close, pb.close);
      const [da, db] = await Promise.all([pa.promise, pb.promise]);
      // Compare first pages; multi-page compare is on the roadmap.
      const [ia, ib] = await Promise.all([renderPage(da, 1, RENDER_WIDTH), renderPage(db, 1, RENDER_WIDTH)]);
      if (!cancelled) setImages({ older: ia, newer: ib, diff: overlay(ia, ib), pages: [da.numPages, db.numPages] });
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      closers.forEach((c) => c());
    };
  }, [older.session, older.path, newer.session, newer.path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!images || !canvasRef.current) return;
    const img = mode === "overlay" ? new ImageData(images.diff.data, images.diff.width, images.diff.height) : images[mode];
    const canvas = canvasRef.current;
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(img, 0, 0);
    // Box every changed region, in every mode, so the eye goes straight to it.
    ctx.strokeStyle = "rgb(230, 120, 0)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    for (const r of images.diff.regions) ctx.strokeRect(r.x - 4, r.y - 4, r.width + 8, r.height + 8);
  }, [images, mode]);

  if (error) return <div className="banner fail">Could not compare drawings: {error}</div>;
  const d = images?.diff;
  const changed = d ? d.added + d.removed : 0;
  const ink = d ? d.added + d.removed + d.common : 0;

  return (
    <div className="drawing drawing-compare" data-changed-pixels={changed} data-regions={d?.regions.length ?? 0}>
      <div className="toolbar row">
        {(["overlay", "older", "newer"] as Mode[]).map((m) => (
          <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
            {m === "overlay" ? "Overlay" : m === "older" ? older.path : newer.path}
          </button>
        ))}
      </div>
      {d ? (
        <p className="muted legend">
          <span className="key removed" /> only in {older.path} ({d.removed.toLocaleString()} px) ·{" "}
          <span className="key added" /> only in {newer.path} ({d.added.toLocaleString()} px) ·{" "}
          {ink ? `${((changed / ink) * 100).toFixed(1)}% of the ink changed` : "no ink"}
          {d.regions.length > 0 && ` · ${d.regions.length} changed ${d.regions.length === 1 ? "area" : "areas"} boxed`}
          {images!.pages[0] + images!.pages[1] > 2 && " · first pages only"}
        </p>
      ) : (
        <p className="muted legend">Rendering both revisions…</p>
      )}
      <div className="drawing-scroll">
        <canvas ref={canvasRef} aria-label={`Overlay of ${older.path} and ${newer.path}`} />
      </div>
    </div>
  );
}
