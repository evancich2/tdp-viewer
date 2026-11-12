import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Strict Content-Security-Policy for production builds. The app makes no network requests:
// packages and trust stores are read from local files only. (Dev mode skips this so HMR works.)
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const contentSecurityPolicy = (): Plugin => ({
  name: "content-security-policy",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
});

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  build: { sourcemap: true },
});
