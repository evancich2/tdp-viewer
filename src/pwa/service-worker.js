// TDP Viewer service worker: makes the app work offline. Plain JS on purpose: it's small and
// auditable, and the build only fills in the asset list below.
//
// Zero-trust rules:
//  - Only the app's own build files are cached. TDP packages and trust stores are opened from
//    local files and never pass through here.
//  - Every file of a new version is checked against the SHA-256 recorded at build time before
//    anything is cached. One mismatch fails the install and the previous version stays in use, so
//    the app is never a mix of two versions or a file altered in transit or at rest on a server.
//  - A new version waits until the user chooses to reload.

/** @type {{ version: string, assets: { url: string, sha256: string }[] }} */
const PRECACHE = __PRECACHE__;
const CACHE = `tdp-viewer-${PRECACHE.version}`;
const byPath = new Map(PRECACHE.assets.map((a) => [a.url, a]));

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const verified = [];
      for (const asset of PRECACHE.assets) {
        const res = await fetch(asset.url, { cache: "no-store", credentials: "omit", redirect: "error" });
        if (!res.ok) throw new Error(`${asset.url}: HTTP ${res.status}`);
        const body = await res.arrayBuffer();
        const digest = hex(await crypto.subtle.digest("SHA-256", body));
        if (digest !== asset.sha256) throw new Error(`${asset.url}: SHA-256 mismatch, refusing to install this version`);
        // Keep the server's headers: workers take their Content-Security-Policy from them.
        verified.push([asset.url, new Response(body, { status: 200, headers: res.headers })]);
      }
      const cache = await caches.open(CACHE);
      await Promise.all(verified.map(([url, res]) => cache.put(url, res)));
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith("tdp-viewer-") && name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  // Every page navigation gets the cached app shell.
  const path = req.mode === "navigate" ? "/index.html" : url.pathname;
  if (!byPath.has(path)) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => (await cache.match(path)) ?? fetch(req)),
  );
});
