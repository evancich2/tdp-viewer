import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Strict Content-Security-Policy. The app makes no network requests: packages and trust stores are
// read from local files only. 'wasm-unsafe-eval' lets WebAssembly compile; it does not allow JS eval.
const directives = (scriptSrc: string) =>
  [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "worker-src 'self' blob:",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

export const pageCsp = directives("'self' 'wasm-unsafe-eval'");
// OpenCascade's Emscripten glue builds functions at runtime, so the STEP worker alone may eval.
// It's a throwaway worker with no network and no DOM, and it only sees verified bytes.
export const stepWorkerCsp = directives("'self' 'unsafe-eval' 'wasm-unsafe-eval'");

// Workers obey only a CSP sent as an HTTP header, not the page's <meta> tag. So: a <meta> tag for
// the page, per-path headers in `vite preview`, and a _headers file for static hosts that read one.
// Dev mode skips all of this so HMR works.
const isStepWorker = (path: string) => /\/assets\/step\.worker-[^/]*\.js$/.test(path);
const securityHeaders = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

const contentSecurityPolicy = (): Plugin => ({
  name: "content-security-policy",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${pageCsp}" />`),
  generateBundle() {
    const common = Object.entries(securityHeaders).map(([k, v]) => `  ${k}: ${v}`);
    const source = [
      "/*",
      `  Content-Security-Policy: ${pageCsp}`,
      ...common,
      "",
      "/assets/step.worker-*",
      "  ! Content-Security-Policy",
      `  Content-Security-Policy: ${stepWorkerCsp}`,
      "",
    ].join("\n");
    this.emitFile({ type: "asset", fileName: "_headers", source });
  },
});

const previewHeaders = (): Plugin => ({
  name: "preview-security-headers",
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = (req.url ?? "/").split("?")[0]!;
      res.setHeader("Content-Security-Policy", isStepWorker(path) ? stepWorkerCsp : pageCsp);
      for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
      next();
    });
  },
});

// Embeds OpenCascade's WASM in the STEP worker as base64, so loading it needs no fetch.
const inlineOcctWasm = (): Plugin => ({
  name: "inline-occt-wasm",
  resolveId: (id) => (id === "virtual:occt-wasm" ? "\0virtual:occt-wasm" : undefined),
  load(id) {
    if (id !== "\0virtual:occt-wasm") return;
    const path = createRequire(import.meta.url).resolve("occt-import-js/dist/occt-import-js.wasm");
    return `export default ${JSON.stringify(readFileSync(path).toString("base64"))};`;
  },
});

export default defineConfig({
  plugins: [react(), contentSecurityPolicy(), previewHeaders()],
  build: { sourcemap: true },
  worker: { format: "es", plugins: () => [inlineOcctWasm()] },
});
