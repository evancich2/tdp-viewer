import { useEffect, useRef, useState } from "react";
import type { ManifestFile } from "../core";
import { openPdf, pdfjs } from "./pdf";

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

/**
 * Renders a verified PDF drawing to a canvas. The PDF is parsed in its own pdf.js worker,
 * destroyed when the drawing closes. Only page content is drawn: no annotations, links, forms
 * or scripts, and pdf.js is told not to fetch anything.
 */
export function DrawingViewer({ file, bytes }: { file: ManifestFile; bytes: Uint8Array }) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState<number | "fit">("fit");
  const [rotation, setRotation] = useState(0);
  const [rendered, setRendered] = useState<{ scale: number; width: number; height: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pdf = openPdf(bytes);
    setDoc(null);
    setError(null);
    setPage(1);
    pdf.promise.then(setDoc, (e: Error) => setError(e.message));
    return pdf.close;
  }, [file.path, bytes]);

  useEffect(() => {
    if (!doc || !canvasRef.current || !scrollRef.current) return;
    let cancelled = false;
    let renderTask: ReturnType<pdfjs.PDFPageProxy["render"]> | undefined;
    void doc.getPage(page).then((p) => {
      if (cancelled) return;
      const unscaled = p.getViewport({ scale: 1, rotation });
      const fit = (scrollRef.current!.clientWidth - 2) / unscaled.width;
      const s = scale === "fit" ? fit : scale;
      const viewport = p.getViewport({ scale: s, rotation });
      const dpr = window.devicePixelRatio || 1;
      const canvas = canvasRef.current!;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      renderTask = p.render({
        canvas,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        annotationMode: pdfjs.AnnotationMode.DISABLE,
      });
      renderTask.promise.then(
        () => !cancelled && setRendered({ scale: s, width: viewport.width, height: viewport.height }),
        (e: Error) => e.name !== "RenderingCancelledException" && setError(e.message),
      );
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, page, scale, rotation]);

  const currentScale = rendered?.scale ?? 1;
  const zoom = (factor: number) =>
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(currentScale * factor * 100) / 100)));

  // Drag to pan.
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    const el = scrollRef.current!;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const el = scrollRef.current!;
    el.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
    el.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  };
  const onPointerUp = () => (drag.current = null);
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  };

  if (error) return <div className="banner fail">Could not render drawing: {error}</div>;

  return (
    <div className="drawing">
      <div className="toolbar row">
        <button aria-label="Previous page" disabled={!doc || page <= 1} onClick={() => setPage(page - 1)}>‹</button>
        <span>Page {doc ? `${page} of ${doc.numPages}` : "…"}</span>
        <button aria-label="Next page" disabled={!doc || page >= doc.numPages} onClick={() => setPage(page + 1)}>›</button>
        <span className="sep" />
        <button aria-label="Zoom out" onClick={() => zoom(1 / 1.25)}>−</button>
        <span>{Math.round(currentScale * 100)}%</span>
        <button aria-label="Zoom in" onClick={() => zoom(1.25)}>+</button>
        <button onClick={() => setScale("fit")}>Fit</button>
        <button aria-label="Rotate" onClick={() => setRotation((rotation + 90) % 360)}>⟳</button>
      </div>
      <div
        ref={scrollRef}
        className="drawing-scroll"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <canvas ref={canvasRef} aria-label={`Drawing ${file.path}, page ${page}`} />
      </div>
    </div>
  );
}
