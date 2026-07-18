// =============================================================================
// shot.mjs — headless screenshot harness for the web demo.
//
//   npm run shot -- "view=slice&state=4,2,1&size=1024" [out.png]
//
// Loads the dev server (default http://localhost:3000, override with
// SHOT_BASE) with the given query string, waits for the app to flag its first
// rendered frame (window.__renderReady), then captures the canvas element
// pixel-exactly. This is the web-side counterpart of the C# CLI's --out: the
// same URL-parameter vocabulary the app exposes for sharing drives it, so a
// web render can be diffed against an offline still or the lab's CPU
// reference (lab/scripts/render_reference.jl compare).
//
// Chromium runs with SwiftShader unless SHOT_GPU=1 requests the real GPU via
// EGL — handy on the workstation, unavailable in CI.
// =============================================================================

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const query = process.argv[2] ?? "";
const out = resolve(process.argv[3] ?? ".shots/shot.png");
const base = process.env.SHOT_BASE ?? "http://localhost:3000";
const url = `${base}/?${query}`;

const gpuArgs =
  process.env.SHOT_GPU === "1"
    ? ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu", "--ignore-gpu-blocklist"]
    : [];

const browser = await chromium.launch({ args: gpuArgs });
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1200 },
    deviceScaleFactor: 1,
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("page error:", msg.text());
  });
  page.on("pageerror", (err) => console.error("page exception:", err.message));

  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.__renderReady === true, undefined, {
    timeout: 60_000,
  });
  // One extra frame so the flagged render is definitely presented.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

  mkdirSync(dirname(out), { recursive: true });
  await page.locator("canvas").screenshot({ path: out });
  console.log(`wrote ${out}  (${url})`);
} finally {
  await browser.close();
}
