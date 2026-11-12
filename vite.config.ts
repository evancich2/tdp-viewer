import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Strict Content-Security-Policy. The app makes no network requests: packages and trust stores are
// read from local files only. 'wasm-unsafe-eval' lets WebAssembly compile; it does not allow JS eval.
const directives = ({ script = "'self' 'wasm-unsafe-eval'", connect = "'none'" } = {}) =>
  [
    "default-src 'none'",
    `script-src ${script}`,
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

export const pageCsp = directives();
// OpenCascade's Emscripten glue builds functions at runtime, so the STEP worker alone may eval.
// It's a throwaway worker with no network and no DOM, and it only sees verified bytes.
export const stepWorkerCsp = directives({ script: "'self' 'unsafe-eval' 'wasm-unsafe-eval'" });
// The service worker is the only code that touches the network: it fetches the app's own files.
export const serviceWorkerCsp = directives({ script: "'self'", connect: "'self'" });

// Workers obey only a CSP sent as an HTTP header, not the page's <meta> tag. So: a <meta> tag for
// the page, per-path headers in `vite preview`, and a _headers file for static hosts that read one.
// Dev mode skips all of this so HMR works.
const isStepWorker = (path: string) => /\/assets\/step\.worker-[^/]*\.js$/.test(path);
const cspFor = (path: string) => (isStepWorker(path) ? stepWorkerCsp : path === "/sw.js" ? serviceWorkerCsp : pageCsp);
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
      "/sw.js",
      "  ! Content-Security-Policy",
      `  Content-Security-Policy: ${serviceWorkerCsp}`,
      "  Cache-Control: no-cache",
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
      res.setHeader("Content-Security-Policy", cspFor(path));
      if (path === "/sw.js") res.setHeader("Cache-Control", "no-cache");
      for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
      next();
    });
  },
});

/**
 * Writes dist/sw.js from src/pwa/service-worker.js, filled in with every built file and its
 * SHA-256. Runs after everything else is written so the digests match what will be served.
 */
const serviceWorker = (): Plugin => {
  let outDir = "dist";
  return {
    name: "service-worker",
    apply: "build",
    configResolved: (config) => void (outDir = resolve(config.root, config.build.outDir)),
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else files.push(full);
        }
      };
      walk(outDir);
      const assets = files
        .map((f) => "/" + relative(outDir, f).split(sep).join("/"))
        .filter((u) => !u.endsWith(".map") && u !== "/_headers" && u !== "/sw.js")
        .sort()
        .map((url) => ({ url, sha256: createHash("sha256").update(readFileSync(join(outDir, url))).digest("hex") }));
      const version = createHash("sha256").update(JSON.stringify(assets)).digest("hex").slice(0, 16);
      const template = readFileSync("src/pwa/service-worker.js", "utf8");
      writeFileSync(join(outDir, "sw.js"), template.replace("__PRECACHE__", JSON.stringify({ version, assets }, null, 2)));
    },
  };
};

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
  plugins: [react(), contentSecurityPolicy(), previewHeaders(), serviceWorker()],
  build: { sourcemap: true },
  worker: { format: "es", plugins: () => [inlineOcctWasm()] },
});
