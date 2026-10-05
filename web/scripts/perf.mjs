// Reproducible cold-start/frame-time probe. Run against a production export
// for comparisons: PERF_BASE=http://localhost:3001 npm run perf -- 'scale=0.25'
import { chromium } from "playwright";

const base = process.env.PERF_BASE ?? "http://localhost:3001";
const query = process.argv[2] ?? "scale=0.25";
const browser = await chromium.launch({
  args: process.env.PERF_GPU === "1"
    ? ["--use-angle=default", "--enable-gpu", "--ignore-gpu-blocklist"]
    : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(() => {
    const probe = window.__perf = { programs: 0, contexts: 0, lost: 0, stalls: [], frames: [], readyMs: null };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      const context = getContext.apply(this, args);
      if (args[0] === "webgl2" && context && !context.__counted) {
        context.__counted = true;
        probe.contexts++;
        this.addEventListener("webglcontextlost", () => {
          // Old versions intentionally release the loading renderer's context.
          if (this.classList.contains("view")) probe.lost++;
        });
      }
      return context;
    };
    const proto = WebGL2RenderingContext.prototype;
    const create = proto.createProgram;
    proto.createProgram = function (...args) { probe.programs++; return create.apply(this, args); };
    for (const name of ["getShaderParameter", "getProgramParameter"]) {
      const original = proto[name];
      proto[name] = function (...args) {
        const start = performance.now();
        const result = original.apply(this, args);
        const ms = performance.now() - start;
        if (ms > 10) probe.stalls.push({ name, ms: Math.round(ms) });
        return result;
      };
    }
    let last = null;
    function frame(now) {
      if (window.__renderReady) {
        probe.readyMs ??= performance.now();
        if (last !== null) probe.frames.push(now - last);
        last = now;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  await page.goto(`${base}/?${query}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(() => window.__renderReady, undefined, { timeout: 120_000 });
  // Give the governor a chance to settle, then collect ten seconds of frames.
  await page.waitForTimeout(3000);
  await page.evaluate(() => { window.__perf.frames = []; });
  await page.waitForTimeout(10_000);
  const result = await page.evaluate(() => {
    const { frames, ...probe } = window.__perf;
    const sorted = frames.toSorted((a, b) => a - b);
    const canvas = document.querySelector("canvas.view");
    const gl = canvas.getContext("webgl2");
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      ...probe,
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unknown",
      firstContentfulPaintMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
      runtimeBytes: performance.getEntriesByType("resource")
        .filter((r) => r.name.includes("/generated/"))
        .reduce((sum, r) => sum + r.decodedBodySize, 0),
      resolution: [canvas.width, canvas.height],
      frames: sorted.length,
      medianMs: sorted[Math.floor(sorted.length * 0.5)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      stats: document.querySelector(".stats")?.textContent,
    };
  });
  console.log(JSON.stringify({ query, ...result, errors }, null, 2));
  if (errors.length || result.lost) process.exitCode = 1;
} finally {
  await browser.close();
}
