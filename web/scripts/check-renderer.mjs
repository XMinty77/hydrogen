// Exercise shader variants, table loading, capture, and GPU resource lifetime
// against a production export. CHECK_BASE defaults to http://localhost:3003.
// CHECK_REFERENCE enables pixel comparisons with an unchanged export.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import sharp from "sharp";

const base = process.env.CHECK_BASE ?? "http://localhost:3003";
const reference = process.env.CHECK_REFERENCE;
const args = process.env.CHECK_SOFTWARE === "1"
  ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
  : ["--use-angle=default", "--enable-gpu", "--ignore-gpu-blocklist"];
const browser = await chromium.launch({ args });

async function init(page) {
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  await page.addInitScript(() => {
    const probe = window.__resources = { programs: new Set(), textures: new Set(), framebuffers: new Set(), lost: 0 };
    for (const [kind, noun] of [["programs", "Program"], ["textures", "Texture"], ["framebuffers", "Framebuffer"]]) {
      const proto = WebGL2RenderingContext.prototype;
      const create = proto[`create${noun}`];
      const remove = proto[`delete${noun}`];
      proto[`create${noun}`] = function (...args) {
        const result = create.apply(this, args);
        probe[kind].add(result);
        return result;
      };
      proto[`delete${noun}`] = function (object) { probe[kind].delete(object); return remove.call(this, object); };
    }
    document.addEventListener("webglcontextlost", (e) => {
      if (e.target.classList.contains("view")) probe.lost++;
    }, true);
  });
  return errors;
}

async function render(page, host, query) {
  await page.goto(`${host}/?${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__renderReady || document.querySelector(".stats")?.textContent.startsWith("failed"), undefined, { timeout: 90_000 });
  assert.equal(await page.evaluate(() => window.__renderReady), true, await page.locator(".stats").textContent());
  await page.waitForFunction(() => document.querySelector("#loading, .loading")?.hidden, undefined, { timeout: 5000 });
  const loss = await page.evaluate(() => window.__resources.lost);
  assert.equal(loss, 0, "renderer lost its context");
  return page.locator("canvas.view").screenshot();
}

async function setControl(page, label, value) {
  const controller = page.locator(".lil-gui .controller").filter({ has: page.locator(".name", { hasText: new RegExp(`^${label}$`) }) });
  assert.equal(await controller.count(), 1, `missing control ${label}`);
  await controller.locator("input, select").first().evaluate((input, value) => {
    if (input.type === "checkbox") input.checked = value;
    else input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await page.waitForTimeout(150);
  await page.waitForFunction(() => !document.querySelector(".stats")?.textContent.includes("compiling"), undefined, { timeout: 90_000 });
}

try {
  // Loading must exist and remain usable before any JavaScript runs.
  const shell = await browser.newPage({ javaScriptEnabled: false });
  await shell.goto(base);
  assert.equal(await shell.locator("#loading").isVisible(), true);
  assert.equal(await shell.locator("#loading-note").textContent(), "starting");
  await shell.close();
  console.log("PASS loading screen without JavaScript");

  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = await init(page);
  const ref = reference ? await browser.newPage({ viewport: { width: 800, height: 600 } }) : null;
  if (ref) await init(ref);
  const cases = [
    ["ea", ""],
    ["slice", "view=slice&plane=xz"],
    ["mip", "integrator=mip"],
    ["scatter", "integrator=scatter&steps=24&shadowSteps=4&ambientDirs=2"],
    ["mida", "integrator=mida"],
    ["iso", "integrator=iso&shadeModel=ggx"],
    ["isolegacy", "integrator=isolegacy&shadeModel=blinn"],
    ["pathtrace", "integrator=pathtrace&spp=2"],
    ["eikonal", "integrator=eikonal&eikSteps=32"],
    ["superposition", "terms=2,0,0;2,1,0&mode=real&color=signed"],
    ["eight terms", "view=slice&terms=2,0,0;2,1,0;3,0,0;3,1,1;3,2,1;4,0,0;4,1,-1;4,2,2&t=3"],
    ["n=25", "state=25,24,-24&view=slice&plane=xy"],
    ["post + clips + axes", "post=1&grain=1&vignette=1&axes=1&clip=forward,0&clip=right,0"],
    ["ink", "flow=1&flowMethod=ink&view=slice&flowFrames=3"],
    ["motes", "flow=1&flowMethod=motes&flowParticleSide=32&flowFrames=3"],
    ["trails", "flow=1&flowMethod=trails&flowParticleSide=32&flowFrames=3&post=1"],
    ["accretion", "flow=1&flowMethod=accretion&flowParticleSide=32&flowFrames=3"],
    ["granular", "flow=1&flowMethod=granular&flowVolumeGrid=16&flowFrames=3"],
    ["fourth-order RK2", "flow=1&flowMethod=ink&view=slice&flowDerivative=fourth&flowIntegrator=midpoint&terms=2,1,1;3,2,2&flowFrames=3"],
  ];
  for (const [name, settings] of cases) {
    const params = new URLSearchParams(settings);
    params.set("size", "128");
    if (!params.has("state")) params.set("state", "4,2,1");
    const query = params.toString();
    const image = await render(page, base, query);
    assert.equal(errors.length, 0, errors.join("\n"));
    const stats = await sharp(image).stats();
    assert(stats.channels.some((c) => c.max - c.min > 8), `${name} produced a blank frame`);
    let diff = "";
    if (ref) {
      const before = await render(ref, reference, query);
      const a = await sharp(image).removeAlpha().raw().toBuffer();
      const b = await sharp(before).removeAlpha().raw().toBuffer();
      assert.equal(a.length, b.length);
      let total = 0;
      for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
      const mae = total / a.length;
      assert(mae < 1.5, `${name} changed appearance: MAE ${mae}`);
      diff = ` · mean pixel difference ${mae.toFixed(3)}/255`;
    }
    console.log(`PASS ${name}${diff}`);
  }
  if (ref) await ref.close();

  // Resize repeatedly while path tracing: accumulation must stay at two FBOs.
  await render(page, base, "scale=0.25&integrator=pathtrace");
  for (const width of [640, 960, 720, 1080, 800]) {
    await page.setViewportSize({ width, height: 600 });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__resources.framebuffers.size), 2, "path-trace resize leaked framebuffers");
  }
  await setControl(page, "technique", "ea");
  assert.equal(await page.evaluate(() => window.__resources.framebuffers.size), 0, "inactive accumulation was retained");
  console.log("PASS path-tracing resize and technique-switch cleanup");

  // A PNG must contain the rendered image with preserveDrawingBuffer disabled.
  const downloadPromise = page.waitForEvent("download");
  await page.keyboard.press("p");
  const download = await downloadPromise;
  const file = await download.path();
  const captured = await sharp(file).stats();
  assert(captured.channels.some((c) => c.stdev > 2), "PNG capture is blank");
  console.log("PASS PNG capture");

  // Optional targets must disappear when their controls are disabled.
  await render(page, base, "scale=0.25&post=1&flow=1&flowParticleSide=32");
  assert.equal(await page.evaluate(() => window.__resources.framebuffers.size), 7);
  await setControl(page, "show advected flow", false);
  assert.equal(await page.evaluate(() => window.__resources.framebuffers.size), 3);
  await setControl(page, "enable finishing", false);
  assert.equal(await page.evaluate(() => window.__resources.framebuffers.size), 0);
  console.log("PASS disabled flow/post target cleanup");

  // Switch into an uncached state and back: only its two exact tables load.
  const tables = [];
  page.on("request", (request) => {
    if (request.url().includes("/tables/")) tables.push(request.url());
  });
  await setControl(page, "n", 25);
  await page.waitForTimeout(300);
  assert.equal(tables.length, 1, "changing n should fetch only the missing radial table");
  await setControl(page, "n", 4);
  await page.waitForTimeout(300);
  assert.equal(tables.length, 1, "returning to a cached state refetched its tables");
  console.log("PASS live state selection and table cache");

  // More variants than the cache limit must still leave bounded GPU programs.
  for (let round = 0; round < 2; round++) {
    for (const technique of ["ea", "mip", "mida", "iso", "isolegacy", "scatter"]) {
      await setControl(page, "technique", technique);
      for (const shade of ["off", "lambert", "blinn", "ggx"])
        await setControl(page, "shadeModel", shade);
    }
  }
  assert(await page.evaluate(() => window.__resources.programs.size <= 16), "shader cache grew beyond its limit");
  console.log("PASS bounded shader variant cache");
  assert.equal(errors.length, 0, errors.join("\n"));
  await page.close();
} finally {
  await browser.close();
}
