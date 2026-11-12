import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

/**
 * Opens verified PDF bytes in a dedicated pdf.js worker with everything that could reach out
 * turned off: no fetching, no WASM decoders, no XFA. Call `close` to destroy the worker.
 */
export function openPdf(bytes: Uint8Array): { promise: Promise<pdfjs.PDFDocumentProxy>; close: () => void } {
  const worker = new pdfjs.PDFWorker();
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    worker,
    useWasm: false,
    useWorkerFetch: false,
    useSystemFonts: true,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    maxImageSize: 64 * 1024 * 1024,
    verbosity: 0,
  });
  return {
    promise: task.promise,
    close: () => {
      void task.destroy();
      worker.destroy();
    },
  };
}

/** Renders one page, page content only (no annotations), at the given CSS-pixel width. */
export async function renderPage(doc: pdfjs.PDFDocumentProxy, pageNumber: number, width: number): Promise<ImageData> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
