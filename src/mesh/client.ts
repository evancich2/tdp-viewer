import type { Mesh } from "../core/mesh";
import type { StepMesher } from "../core/print";

/** Meshes STEP bytes in a new worker that's thrown away afterwards, so one parse can't affect the next. */
export const workerMesher: StepMesher = (step) =>
  new Promise<Mesh[]>((resolve, reject) => {
    const worker = new Worker(new URL("./step.worker.ts", import.meta.url), { type: "module" });
    const done = () => worker.terminate();
    worker.onmessage = (e: MessageEvent<{ ok: true; meshes: Mesh[] } | { ok: false; error: string }>) => {
      done();
      if (e.data.ok) resolve(e.data.meshes);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      done();
      reject(new Error(e.message || "STEP worker failed"));
    };
    const copy = step.slice();
    worker.postMessage(copy, [copy.buffer]);
  });
