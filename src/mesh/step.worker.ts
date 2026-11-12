/// <reference lib="webworker" />
// Parses untrusted STEP bytes with OpenCascade (WASM), isolated from the page.
// The client starts a fresh worker for each model and terminates it afterwards.
// The WASM binary is inlined so the worker never makes a network request (CSP connect-src 'none').
import occtimportjs from "occt-import-js";
import wasmBase64 from "virtual:occt-wasm";
import { fromBase64 } from "../core/bytes";
import { meshStep, type Occt } from "./occt";

self.onmessage = async (e: MessageEvent<Uint8Array>) => {
  try {
    const wasmBinary = fromBase64(wasmBase64);
    const occt = (await occtimportjs({ wasmBinary })) as Occt;
    const meshes = meshStep(occt, e.data);
    const transfer = meshes.flatMap((m) => [(m.positions as Float32Array).buffer, (m.indices as Uint32Array).buffer]);
    self.postMessage({ ok: true, meshes }, { transfer });
  } catch (err) {
    self.postMessage({ ok: false, error: (err as Error).message });
  }
};
