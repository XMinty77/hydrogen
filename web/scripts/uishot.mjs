// One-off full-page UI screenshot (panels + GUI included) for layout checks.
// Usage: node scripts/uishot.mjs "<query>" out.png [clicks...]
//   clicks: CSS selectors or text= locators clicked in order before the shot.
import { chromium } from "playwright";

const [query = "", out = ".shots/ui.png", ...clicks] = process.argv.slice(2);
const base = process.env.SHOT_BASE ?? "http://localhost:3001";
const args = process.env.SHOT_GPU
  ? ["--use-angle=default", "--enable-gpu", "--ignore-gpu-blocklist"]
  : [];
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto(`${base}/?${query}`);
await page.waitForFunction(() => window.__renderReady === true, { timeout: 60000 });
for (const c of clicks) {
  await (c.startsWith("text=") ? page.getByText(c.slice(5), { exact: true }).first() : page.locator(c).first()).click();
  await page.waitForTimeout(300);
}
await page.waitForTimeout(700);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
