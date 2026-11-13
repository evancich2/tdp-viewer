// End-to-end check of the production build in a real Chrome, with the CSP sent as a header.
// Run with: npm run e2e   (needs Google Chrome installed; uses playwright-core, no browser download)
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { chromium } from "playwright-core";

const PORT = 4180;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Run vite directly (not through npx) so killing it really stops the server.
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
  stdio: ["ignore", "inherit", "inherit"],
});
const finish = (code: number): never => {
  server.kill();
  process.exit(code);
};
const fail = (msg: string): never => {
  console.error(`FAIL ${msg}`);
  // In GitHub Actions, also surface the failure as an annotation on the run.
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=${process.argv[1]!.split("/").pop()}::${msg.replace(/\n/g, "%0A")}`);
  return finish(1);
};
// A hang anywhere is a failure, not a stuck CI job.
setTimeout(() => fail("timed out after 3 minutes"), 180_000).unref();
process.on("unhandledRejection", (e) => fail(String((e as Error)?.stack ?? e)));

for (let i = 0; ; i++) {
  if (i > 100) fail("vite preview did not start");
  if (await fetch(ORIGIN).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const problems: string[] = [];
  page.on("console", (m) => /Content.Security.Policy|Refused to/i.test(m.text()) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
  const offsite: string[] = [];
  page.on("request", (r) => !r.url().startsWith(`${ORIGIN}/`) && !r.url().startsWith("blob:") && !r.url().startsWith("data:") && offsite.push(r.url()));

  await page.goto(`${ORIGIN}/`);
  // Keyboard: the file pickers are reachable with Tab (they are visually hidden inside their labels, not `hidden`).
  const reached = new Set<string>();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => { const el = document.activeElement as HTMLInputElement | null; return el?.type === "file" ? el.closest("label")?.textContent?.trim() ?? "" : ""; });
    if (label) reached.add(label);
  }
  for (const want of ["Pin root keys…", "Load trust store…"]) if (![...reached].some((l) => l.startsWith(want))) fail(`file picker "${want}" not reachable by keyboard (reached: ${[...reached].join(", ")})`);
  console.log("ok  file pickers reachable by keyboard");
  await page.getByRole("button", { name: "Use demo keys" }).click();
  await page.getByText(/✓ Signed by Sample Org Root/).waitFor();
  // With a root pinned, an unsigned trust store is refused.
  await page.locator("label", { hasText: "Load trust store" }).locator("input").setInputFiles("samples/trust-store.json");
  await page.getByText(/isn't signed, and you've pinned a root key/).waitFor();
  await page.getByRole("button", { name: "Use demo keys" }).click();
  await page.getByText(/✓ Signed by Sample Org Root/).waitFor();
  console.log("ok  signed trust store accepted under the pinned root; unsigned one refused");

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
  await page.locator("tr", { hasText: "SMP-1002_D.pdf" }).getByRole("button", { name: "Compare drawings" }).click();
  await page.locator(".drawing-compare:not([data-changed-pixels='0'])").waitFor({ timeout: 20_000 });
  const changedPx = Number(await page.locator(".drawing-compare").getAttribute("data-changed-pixels"));
  console.log(`ok  drawing overlay highlights the rev C to D changes (${changedPx} px)`);
  await page.locator('.compare input[type="file"]').setInputFiles("samples/tampered.tdp");
  await page.getByText("can't compare against a package that doesn't verify").waitFor();
  console.log("ok  revision compare shows rev C changes and refuses a tampered package");

  const auditText = await page.locator(".audit").innerText();
  if (!/export/.test(auditText)) fail("export missing from audit log");
  console.log("ok  export recorded in audit log");

  // Laboratory workflow (synthetic surrogate): baseline, authority, signed ledger, evidence, sync.
  await page.getByRole("button", { name: "Use lab demo keys" }).click();
  await page.getByText(/✓ Signed by Lab Authority Root/).waitFor();
  await page.locator('input[accept=".tdp,.zip"]').first().setInputFiles("samples/lab/SYN-PH-2000_A.tdp");
  await page.getByText("TRUSTED", { exact: true }).waitFor();
  await page.locator(".workflow .synthetic", { hasText: "SYNTHETIC" }).waitFor();
  const badge = (label: string) => page.locator(`.badge[data-status="${label}"]`);
  if (!(await badge("Package integrity").getAttribute("class"))!.includes("ok")) fail("package integrity badge not ok");
  if (!(await badge("Operation authorized").getAttribute("class"))!.includes("none")) fail("a package alone must not show an authorized operation");
  if (!(await badge("Source release").getAttribute("class"))!.includes("none")) fail("source release must not be implied by package integrity");
  console.log("ok  lab package trusted; integrity verified but source release and authorization not implied");

  await page.getByRole("button", { name: "Use lab authority and processes" }).click();
  await page.locator(".workflow .tag", { hasText: "LAB FIXTURE" }).waitFor();
  const ledgerInput = page.locator(".workflow label", { hasText: "Open ledger" }).locator("input");
  await ledgerInput.setInputFiles("samples/lab/ledgers/SN-0001.ledger.json");
  await page.locator('[data-ledger-verdict="held"]').waitFor();
  await page.locator(".workflow label", { hasText: "Add evidence files" }).locator("input").setInputFiles(
    readdirSync("samples/lab/evidence").map((f) => `samples/lab/evidence/${f}`),
  );
  await page.locator('[data-ledger-verdict="verified"]').waitFor();
  if (!(await badge("Source release").getAttribute("class"))!.includes("ok")) fail("source release badge not ok after a verified source-release record");
  if (!(await badge("Inspection").getAttribute("class"))!.includes("ok")) fail("inspection badge not ok");
  const recs = await page.locator(".workflow table.records tbody tr").count();
  if (recs !== 16) fail(`expected 16 signed records, got ${recs}`);
  await page.locator('.workflow .states li[aria-current="step"]', { hasText: "closed" }).waitFor();
  console.log("ok  SN-0001 ledger held until evidence was supplied, then verified: 16 records, state closed, separate status badges");

  await ledgerInput.setInputFiles("samples/lab/ledgers/invalid-skip.ledger.json");
  await page.locator('[data-ledger-verdict="rejected"]').waitFor();
  await page.locator(".workflow .checks li.fail", { hasText: /not allowed from state source-released/ }).waitFor();
  await ledgerInput.setInputFiles("samples/lab/ledgers/SN-0003.ledger.json");
  await page.locator('[data-ledger-verdict="verified"]').waitFor();
  if (!(await badge("Inspection").getAttribute("class"))!.includes("warn")) fail("indeterminate inspection should be held (warn), not accepted");
  console.log("ok  forbidden step rejected with its reason; indeterminate inspection shown as held");

  // Record a step in the browser: the inspector raises an NCR against SN-0003's held inspection.
  await page.locator(".record-form label", { hasText: "Signing key file" }).locator("input").setInputFiles("samples/lab/keys/inspector.key.json");
  await page.getByLabel("Passphrase").fill("lab-demo-passphrase (public, demo only)");
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByText(/Signing as Ines Inspector/).waitFor({ timeout: 30_000 });
  await page.locator(".record-form select").first().selectOption("raise-nonconformance");
  const dataBox = page.locator(".record-form textarea");
  const tmpl = JSON.parse(await dataBox.inputValue());
  await dataBox.fill(JSON.stringify({ ...tmpl, ncrId: "NCR-E2E", characteristics: ["CH-002"], description: "e2e: wrong characteristic" }));
  await page.locator(".record-form label", { hasText: "Reason" }).locator("input").fill("e2e");
  await page.getByRole("button", { name: "Check and sign" }).click();
  await page.locator(".record-form .banner.fail", { hasText: /DENIED, nothing signed: .*CH-002 was not rejected or held/ }).waitFor();
  await dataBox.fill(JSON.stringify({ ...tmpl, ncrId: "NCR-E2E", characteristics: ["CH-001"], description: "e2e: tab within U of the upper limit" }));
  await page.getByRole("button", { name: "Check and sign" }).click();
  await page.locator(".record-form .banner.pass", { hasText: /Signed record 11: raise-nonconformance/ }).waitFor();
  await page.locator('[data-ledger-verdict="verified"]', { hasText: "11 records" }).waitFor();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download ledger" }).click();
  const saved = JSON.parse(readFileSync(await (await dl).path(), "utf8"));
  if (saved.entries.length !== 11) fail(`downloaded ledger has ${saved.entries.length} records`);
  console.log("ok  browser signing: a forbidden NCR is refused with nothing signed; a valid one is signed, re-verified and downloadable");

  // A lot ledger: per-unit tracks; and supersession once rev B is loaded.
  await ledgerInput.setInputFiles("samples/lab/ledgers/LOT-0004.ledger.json");
  await page.locator('[data-ledger-verdict="verified"]').waitFor();
  await page.getByLabel("Unit").selectOption({ label: "SN-0005: scrapped" });
  await page.locator(".badge[data-status='Disposition']", { hasText: "scrap (SN-0005)" }).waitFor();
  await page.locator(".workflow label", { hasText: "Load newer baselines" }).locator("input").setInputFiles("samples/lab/SYN-PH-2000_B.tdp");
  await page.locator(".badge[data-status='Baseline']", { hasText: "Superseded by BL-SYN-PH-2000-B" }).waitFor();
  console.log("ok  lot ledger shows each unit's track; loading rev B marks rev A superseded");

  await page.locator(".workflow label", { hasText: "Open proposals" }).locator("input").setInputFiles("samples/lab/exchange/SN-0002.proposals.json");
  await page.locator(".workflow label", { hasText: "Import acknowledgements" }).locator("input").setInputFiles("samples/lab/exchange/SN-0002.acks.json");
  await page.locator('[data-sync-state="conflict"]').first().waitFor();
  await page.getByText(/Acknowledgements signed by Lab Fixture PLM acknowledgement key/).waitFor();
  await page.getByText(/Needs a newly published baseline/).waitFor();
  console.log("ok  sync acknowledgements imported: conflict explicit, change request flagged for a new baseline");

  await page.locator('input[accept=".tdp,.zip"]').first().setInputFiles("samples/lab/SYN-PH-2000_B.tdp");
  await page.getByText("TRUSTED", { exact: true }).waitFor();
  await page.getByText(/Geometry review needed: CH-002/).waitFor();
  console.log("ok  rev B shows the stale geometry link and holds planning for review");

  if (problems.length) fail(`console/CSP problems:\n${problems.join("\n")}`);
  if (offsite.length) fail(`off-origin requests: ${offsite.join(", ")}`);
  console.log("ok  no CSP violations, no off-origin requests");
} catch (e) {
  fail(String((e as Error).stack ?? e));
} finally {
  await browser.close();
}
finish(0);
