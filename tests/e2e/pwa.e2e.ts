// End-to-end PWA checks against the production build in real Chrome:
// installability, offline use, integrity-pinned caching, the update prompt, and the remembered
// trust store. Run with: npm run e2e
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type BrowserContext } from "playwright-core";

const PORT = 4181;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
  stdio: ["ignore", "inherit", "inherit"],
});
const restore: (() => void)[] = [];
const finish = (code: number): never => {
  restore.forEach((r) => r());
  server.kill();
  process.exit(code);
};
const fail = (msg: string): never => {
  console.error(`FAIL ${msg}`);
  // In GitHub Actions, also surface the failure as an annotation on the run.
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=${process.argv[1]!.split("/").pop()}::${msg.replace(/\n/g, "%0A")}`);
  return finish(1);
};
setTimeout(() => fail("timed out after 3 minutes"), 180_000).unref();
process.on("unhandledRejection", (e) => fail(String((e as Error)?.stack ?? e)));

for (let i = 0; ; i++) {
  if (i > 100) fail("vite preview did not start");
  if (await fetch(ORIGIN).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}

/** Temporarily changes a built file; undone at exit. */
function tamper(path: string, change: (s: Buffer) => Buffer) {
  const original = readFileSync(path);
  writeFileSync(path, change(original));
  restore.push(() => writeFileSync(path, original));
  return () => writeFileSync(path, original);
}

async function waitForActiveWorker(context: BrowserContext) {
  const page = context.pages()[0]!;
  return page.evaluate(async () => {
    const worker = (await navigator.serviceWorker.ready).active!;
    if (worker.state !== "activated")
      await new Promise((resolve) => worker.addEventListener("statechange", () => worker.state === "activated" && resolve(null)));
    return worker.state;
  });
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  // 1. Manifest
  const manifest = await (await fetch(`${ORIGIN}/manifest.webmanifest`)).json();
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  if (!sizes.includes("192x192") || !sizes.includes("512x512") || manifest.display !== "standalone") fail("manifest not installable");
  if (!manifest.file_handlers?.[0]?.accept?.["application/x-tdp"]?.includes(".tdp")) fail("manifest has no .tdp file handler");
  console.log("ok  manifest is installable and registers .tdp files");

  // 2. Service worker installs and caches the verified app shell.
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (m) => /Content.Security.Policy|Refused to/i.test(m.text()) && problems.push(m.text()));
  await page.goto(`${ORIGIN}/`);
  if ((await waitForActiveWorker(context)) !== "activated") fail("service worker did not activate");
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names.find((n) => n.startsWith("tdp-viewer-"))!);
    return (await cache.keys()).map((r) => new URL(r.url).pathname);
  });
  const expected = JSON.parse(readFileSync("dist/sw.js", "utf8").match(/const PRECACHE = (\{[\s\S]*?\n\});/)![1]!).assets.length;
  if (cached.length !== expected || !cached.includes("/index.html")) fail(`cached ${cached.length} of ${expected} files`);
  console.log(`ok  service worker active; ${cached.length} verified files cached`);

  // 3. Remember the trust store, then go offline and use the app.
  await page.getByRole("button", { name: "Use demo keys" }).click();
  await page.getByRole("checkbox", { name: /Remember this trust store/ }).check();
  await context.setOffline(true);
  await page.reload();
  await page.getByText(/Using demo keys.*fingerprint/).waitFor();
  if (!(await page.getByRole("checkbox", { name: /Remember this trust store/ }).isChecked())) fail("remembered trust store not restored");
  console.log("ok  trust store remembered across reloads, with fingerprint shown");

  await page.locator(".step input[accept='.tdp,.zip']").setInputFiles("samples/sample.tdp");
  await page.getByText("TRUSTED", { exact: true }).waitFor();
  await page.getByRole("button", { name: "drawings/SMP-1001_A.pdf" }).click();
  await page.getByText("Page 1 of 1").waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "models/SMP-1001_A.stp" }).click();
  await page.locator('.model-canvas[data-solids="1"]').waitFor({ timeout: 60_000 });
  console.log("ok  offline: app loads, verifies, renders a drawing and meshes a model");
  await context.setOffline(false);

  // 4. Update prompt: any change to sw.js is a new version; it waits for the user.
  const undoUpdate = tamper("dist/sw.js", (b) => Buffer.concat([b, Buffer.from("\n// next version\n")]));
  await page.evaluate(async () => (await navigator.serviceWorker.ready).update());
  await page.getByText("A new, verified version of TDP Viewer is ready.").waitFor({ timeout: 30_000 });
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Reload to update" }).click()]);
  undoUpdate();
  console.log("ok  update waits for the user, then activates on reload");

  if (problems.length) fail(`CSP problems:\n${problems.join("\n")}`);
  await context.close();

  // 5. Integrity: a built file that doesn't match its pinned digest blocks the install.
  tamper("dist/icons/icon-192.png", (b) => Buffer.concat([b, Buffer.from([0])]));
  const fresh = await browser.newContext();
  const p2 = await fresh.newPage();
  await p2.goto(`${ORIGIN}/`);
  const outcome = await p2.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const worker = reg?.installing ?? reg?.waiting ?? reg?.active;
    if (!worker) return "none";
    if (worker.state === "redundant" || worker.state === "activated") return worker.state;
    return new Promise<string>((resolve) =>
      worker.addEventListener("statechange", () => ["redundant", "activated"].includes(worker.state) && resolve(worker.state)),
    );
  });
  if (outcome !== "redundant") fail(`tampered build installed anyway (${outcome})`);
  const leftovers = await p2.evaluate(async () => (await caches.keys()).length);
  if (leftovers !== 0) fail("tampered build left a cache behind");
  console.log("ok  a file that doesn't match its pinned SHA-256 blocks the install");
  await fresh.close();
} catch (e) {
  fail(String((e as Error).stack ?? e));
} finally {
  await browser.close();
}
finish(0);
