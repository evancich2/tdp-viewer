/** Browser evidence for a decrypted public NIST model; generated laboratory trust only. */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
const out=resolve(process.argv[2]??".lab-evidence"),origin="http://127.0.0.1:4181";
const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","preview","--host","127.0.0.1","--port","4181","--strictPort"],{stdio:"ignore"});
let browser: Awaited<ReturnType<typeof chromium.launch>>|undefined;
try {
  for(let i=0;;i++){if(i>100)throw new Error("preview startup timeout");if(await fetch(origin).then(r=>r.ok,()=>false))break;await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:"chrome",headless:true});const page=await browser.newPage({viewport:{width:1100,height:1000}});const errors:string[]=[],offsite:string[]=[];
  page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(!r.url().startsWith(origin)&&!r.url().startsWith("blob:")&&!r.url().startsWith("data:"))offsite.push(r.url());});
  await page.goto(origin);
  await page.locator("label",{hasText:"Pin root keys"}).locator("input").setInputFiles(resolve(out,"recipient-anchors.json"));
  await page.locator("label",{hasText:"Load trust store"}).locator("input").setInputFiles(resolve(out,"recipient-trust-store.signed.json"));
  await page.getByText(/Signed by Lab recipient B root/).waitFor();
  await page.locator('input[accept=".tdp,.zip"]').first().setInputFiles(resolve(out,"nist-received.tdp"));await page.getByText("TRUSTED",{exact:true}).waitFor();
  await page.getByRole("button",{name:"models/nist.stp",exact:true}).click();await page.locator('.model-canvas[data-solids="1"]').waitFor({timeout:60000});
  await page.waitForTimeout(300);const triangleText=await page.locator('.model-canvas').getAttribute('data-triangles');
  const prior=JSON.parse(readFileSync(resolve(out,'results.json'),'utf8')) as {geometries:{file:string;rawTriangles:number;triangles:number}[]};
  const expected=prior.geometries.find(g=>g.file==='nist_stc_06_asme1_ap242-e3.stp');
  if(!expected||Number(triangleText)!==expected.rawTriangles)throw new Error(`unexpected rendered triangles ${triangleText}`);
  await page.locator('.model').screenshot({path:resolve(out,'nist-model-browser.png')});await page.screenshot({path:resolve(out,'nist-recipient-browser-full.png'),fullPage:true});
  if(errors.length||offsite.length)throw new Error(JSON.stringify({errors,offsite}));
  writeFileSync(resolve(out,'browser-result.json'),JSON.stringify({accepted:true,model:'nist_stc_06_asme1_ap242-e3.stp',solids:1,rawRenderedTriangles:Number(triangleText),weldedTriangles:expected.triangles,root:'Lab recipient B root',pageErrors:errors,offsiteRequests:offsite,limit:'Geometry view only; no PMI interpretation or NIST endorsement'},null,2));console.log(`PASS: public NIST STC-06 geometry rendered after signed encrypted laboratory handoff, ${triangleText} raw triangles`);
} finally {await browser?.close();server.kill();}
