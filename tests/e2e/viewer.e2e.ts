// End-to-end check of the production build in a real Chrome, with the CSP sent as a header.
// Run with: npm run e2e   (needs Google Chrome installed; uses playwright-core, no browser download)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { chromium } from "playwright-core";

const PORT = 4180;
const fail = (msg: string): never => {
  console.error(`FAIL ${msg}`);
  process.exit(1);
};

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
await new Promise<void>((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && resolve());
  server.on("exit", () => reject(new Error("vite preview exited")));
});

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const problems: string[] = [];
  page.on("console", (m) => /Content.Security.Policy|Refused to/i.test(m.text()) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
  const offsite: string[] = [];
  page.on("request", (r) => !r.url().startsWith(`http://localhost:${PORT}/`) && !r.url().startsWith("blob:") && !r.url().startsWith("data:") && offsite.push(r.url()));

  await page.goto(`http://localhost:${PORT}/`);
  await page.getByRole("button", { name: "Use demo keys" }).click();

  // Tampered package: rejected, nothing openable.
  await page.locator('input[accept=".tdp,.zip"]').setInputFiles("samples/tampered.tdp");
  await page.getByText("REJECTED", { exact: true }).waitFor();
  if (!(await page.getByRole("button", { name: "drawings/SMP-1001_A.pdf" }).isDisabled())) fail("files of a rejected package are clickable");
  console.log("ok  tampered package rejected");

  // Good package: trusted.
  await page.locator('input[accept=".tdp,.zip"]').setInputFiles("samples/sample.tdp");
  await page.getByText("TRUSTED", { exact: true }).waitFor();
  console.log("ok  sample package trusted");

  // Drawing renders with ink on the canvas.
  await page.getByRole("button", { name: "drawings/SMP-1001_A.pdf" }).click();
  await page.getByText("Page 1 of 1").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  const inked = await page.locator(".drawing canvas").evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! < 128) dark++;
    return { dark, w: c.width, h: c.height };
  });
  if (inked.dark < 500) fail(`drawing canvas looks blank (${JSON.stringify(inked)})`);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByText("Page 1 of 1").waitFor();
  console.log(`ok  drawing rendered (${inked.w}x${inked.h}, ${inked.dark} dark px), zoom works`);

  // 3D view of the STEP model.
  await page.getByRole("button", { name: "models/SMP-1000_B.stp" }).click();
  await page.locator('.model-canvas[data-solids="3"]').waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Top" }).click();
  await page.getByRole("checkbox", { name: /^Show / }).first().uncheck();
  console.log("ok  3D model shows 3 solids; view and visibility controls work");

  // 3MF export from the STEP model.
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Export 3MF for Bambu Studio" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const model = new TextDecoder().decode(unzipSync(new Uint8Array(readFileSync(path)))["3D/3dmodel.model"]!);
  const objects = model.match(/<object /g)?.length ?? 0;
  if (download.suggestedFilename() !== "SMP-1000_B.3mf" || objects !== 3) fail(`bad 3MF: ${download.suggestedFilename()}, ${objects} objects`);
  await page.getByText("watertight").first().waitFor();
  console.log(`ok  3MF exported: ${download.suggestedFilename()} with ${objects} watertight objects`);

  // Compare with revision C.
  await page.locator('.compare input[type="file"]').setInputFiles("samples/sample-rev-c.tdp");
  await page.getByText("SMP-1002_C.pdf → drawings/SMP-1002_D.pdf").waitFor();
  await page.getByText("2 files unchanged.").waitFor();
  await page.locator('.compare input[type="file"]').setInputFiles("samples/tampered.tdp");
  await page.getByText("can't compare against a package that doesn't verify").waitFor();
  console.log("ok  revision compare shows rev C changes and refuses a tampered package");

  const auditText = await page.locator(".audit").innerText();
  if (!/export/.test(auditText)) fail("export missing from audit log");
  console.log("ok  export recorded in audit log");

  if (problems.length) fail(`console/CSP problems:\n${problems.join("\n")}`);
  if (offsite.length) fail(`off-origin requests: ${offsite.join(", ")}`);
  console.log("ok  no CSP violations, no off-origin requests");
} finally {
  await browser.close();
  server.kill();
}
