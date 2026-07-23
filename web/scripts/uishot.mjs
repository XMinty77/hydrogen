// One-off full-page UI screenshot (panels + GUI included) for layout checks.
// Usage: node scripts/uishot.mjs "<query>" out.png [clicks...]
//   clicks: CSS selectors or text= locators clicked in order before the shot.
//   Prefix a locator with force: when a tall lil-gui panel visually overlaps
//   the target during automation (for example force:text=plane A).
//   Prefix CSS with dom: to dispatch click() without pointer hit-testing.
import { chromium } from "playwright";

const [query = "", out = ".shots/ui.png", ...clicks] = process.argv.slice(2);
const base = process.env.SHOT_BASE ?? "http://localhost:3001";
const args = process.env.SHOT_GPU
  ? ["--use-angle=default", "--enable-gpu", "--ignore-gpu-blocklist"]
  : [];
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("page error:", msg.text());
});
page.on("pageerror", (err) => console.error("page exception:", err.message));
page.on("download", (download) => console.log(`download: ${download.suggestedFilename()}`));
await page.goto(`${base}/?${query}`);
await page.waitForFunction(() => window.__renderReady === true, { timeout: 60000 });
for (const c of clicks) {
  if (c.startsWith("dom:")) {
    await page.locator(c.slice(4)).first().evaluate((node) => node.click());
    await page.waitForTimeout(300);
    continue;
  }
  const force = c.startsWith("force:");
  const locator = force ? c.slice(6) : c;
  await (locator.startsWith("text=")
    ? page.getByText(locator.slice(5), { exact: true }).first()
    : page.locator(locator).first()).click({ force });
  await page.waitForTimeout(300);
}
await page.waitForTimeout(700);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
