// Renders public/icons/icon.svg to the PNG sizes browsers need for install, using installed Chrome.
// Run after changing the SVG: npx tsx tools/make-icons.ts
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const svg = readFileSync("public/icons/icon.svg", "utf8");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const render = async (size: number, file: string, padding = 0) => {
  await page.setViewportSize({ width: size, height: size });
  // Maskable icons need the artwork inside the central safe zone, on a full-bleed background.
  const inner = size - padding * 2;
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page.setContent(
    `<html style="margin:0;overflow:hidden"><body style="margin:0;overflow:hidden;background:${padding ? "#1f5fbf" : "transparent"}">` +
      `<img src="${src}" style="display:block;margin:${padding}px;width:${inner}px;height:${inner}px"></body></html>`,
  );
  await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
  await page.screenshot({ path: file, omitBackground: !padding });
};
await render(192, "public/icons/icon-192.png");
await render(512, "public/icons/icon-512.png");
await render(512, "public/icons/icon-maskable-512.png", 52);
await render(180, "public/icons/apple-touch-icon.png");
await browser.close();
console.log("wrote public/icons/*.png");
