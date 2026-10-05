// Check the actual exported inline loader and presentation under startup work.
// CHECK_BASE=http://localhost:3003 npm run check:loading
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const base = process.env.CHECK_BASE ?? 'http://localhost:3003';
const query = process.env.CHECK_LOADING_QUERY ??
  'integrator=scatter&shadeModel=ggx&terms=1,0,0;2,1,0&post=1&scale=0.25&steps=24&shadowSteps=4&ambientDirs=2';
const browser = await chromium.launch({
  args: process.env.CHECK_SOFTWARE === '1'
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist'],
});
mkdirSync('.shots', { recursive: true });
const percentile = (a, p) => a.toSorted((x, y) => x - y)[Math.floor((a.length - 1) * p)];

async function shell(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 }, ...options });
  // Loader must work before the framework/viewer chunks arrive.
  await page.route('**/_next/static/**/*.js', r => r.fulfill({ body: '', contentType: 'application/javascript' }));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const assets = [];
  page.on('request', r => { if (['image', 'media'].includes(r.resourceType())) assets.push(r.url()); });
  await page.goto(base);
  await page.waitForFunction(() => window.__hydrogenLoader);
  await page.evaluate(() => window.__hydrogenLoader.ready);
  assert.equal(assets.length, 0, 'loader fetched an image/video');
  assert.equal(errors.length, 0, errors.join('\n'));
  return page;
}

async function trace(page, operation, startMark, endMark) {
  const client = await page.context().newCDPSession(page), events = [];
  client.on('Tracing.dataCollected', e => events.push(...e.value));
  await client.send('Tracing.start', {
    categories: 'benchmark,cc,blink.user_timing,disabled-by-default-devtools.screenshot',
    transferMode: 'ReportEvents',
  });
  await operation();
  const done = new Promise(resolve => client.once('Tracing.tracingComplete', resolve));
  await client.send('Tracing.end'); await done;
  const start = events.find(e => e.name === startMark)?.ts;
  const end = events.find(e => e.name === endMark)?.ts;
  assert(start && end, 'missing interval markers');
  const shots = events.filter(e => e.name === 'Screenshot' && e.ts > start && e.ts < end);
  const times = [start, ...shots.map(e => e.ts), end];
  const gaps = times.slice(1).map((t, i) => (t - times[i]) / 1000);
  await client.detach();
  return { duration: (end - start) / 1000, frames: shots.length,
    unique: new Set(shots.map(e => e.args.snapshot)).size,
    p95: percentile(gaps, .95), max: Math.max(...gaps) };
}

try {
  const page = await shell();
  assert(await page.locator('#loading-first-frame').evaluate(c => c.hidden), 'worker handoff failed');
  assert.equal(page.workers().length, 1);
  const paints = await page.evaluate(() => performance.getEntriesByType('paint').map(e => [e.name, e.startTime]));
  const html = await page.locator('#loading').evaluate(e => {
    const clone = e.cloneNode(true);
    for (const c of clone.querySelectorAll('canvas')) { c.width = c.height = 256; c.hidden = false; }
    return clone.outerHTML;
  });
  writeFileSync('.shots/loading-preview.html', `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#000}</style>${html}`);
  console.log(`PASS initial HTML before framework JS · ${gzipSync(html).length} bytes gzip · no image/video requests · paints ${JSON.stringify(paints)}`);
  const before = await page.screenshot();
  await page.waitForTimeout(250);
  const after = await page.screenshot({ path: '.shots/loading-live.png' });
  assert(!before.equals(after), 'live orbital did not change');

  const cpu = await trace(page, async () => {
    await page.evaluate(() => new Promise(resolve => setTimeout(() => {
      performance.mark('loader-block-start');
      const until = performance.now() + 700;
      while (performance.now() < until) { /* Busy main thread. */ }
      performance.mark('loader-block-end'); resolve();
    }, 200)));
    await page.waitForTimeout(100);
  }, 'loader-block-start', 'loader-block-end');
  assert(cpu.frames >= 25 && cpu.unique >= 25, 'worker failed to present moving frames during CPU stall');
  assert(cpu.max < 75, `CPU stall interrupted presentation: ${cpu.max.toFixed(1)} ms`);
  console.log(`PASS 700 ms CPU stall · ${cpu.frames} distinct moving frames · p95 ${cpu.p95.toFixed(1)} ms · max ${cpu.max.toFixed(1)} ms`);
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.locator('.loading-orbital').boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 390, 'mobile orbital clipped');
  await page.screenshot({ path: '.shots/loading-mobile.png' });
  await page.evaluate(() => { document.getElementById('loading').hidden = true; });
  await page.waitForFunction(() => !document.getElementById('loading-first-frame').getContext('webgl2') || document.getElementById('loading-first-frame').getContext('webgl2').isContextLost());
  await page.waitForTimeout(300);
  assert.equal(page.workers().length, 0, 'hidden loader retained worker');
  console.log('PASS mobile layout and worker/context disposal');
  await page.close();

  const reduced = await shell({ reducedMotion: 'reduce' });
  assert.equal(reduced.workers().length, 0, 'reduced motion started a worker');
  const still = await reduced.screenshot(); await reduced.waitForTimeout(250);
  assert(still.equals(await reduced.screenshot()), 'reduced-motion orbital animated');
  await reduced.close();
  const fallback = await browser.newPage();
  await fallback.addInitScript(() => { window.Worker = undefined; });
  await fallback.route('**/_next/static/**/*.js', r => r.fulfill({ body: '', contentType: 'application/javascript' }));
  await fallback.goto(base); await fallback.evaluate(() => window.__hydrogenLoader.ready);
  assert(!(await fallback.locator('#loading-first-frame').evaluate(c => c.hidden)));
  await fallback.close();
  console.log('PASS reduced motion and no-worker fallback');

  const startup = await browser.newPage({ viewport: { width: 1000, height: 750 } });
  const errors = []; startup.on('pageerror', e => errors.push(e.message));
  startup.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let release; const gate = new Promise(r => { release = r; });
  await startup.route('**/generated/orbitals.json', async r => {
    const response = await r.fetch(); await gate; await r.fulfill({ response });
  });
  await startup.addInitScript(() => {
    const create = WebGL2RenderingContext.prototype.createProgram;
    WebGL2RenderingContext.prototype.createProgram = function (...args) {
      // Bootstrap loader programs precede viewer catalog load; mark only viewer GL.
      if (window.__catalogReleased && !performance.getEntriesByName('viewer-compile-start').length)
        performance.mark('viewer-compile-start');
      return create.apply(this, args);
    };
    new MutationObserver(() => {
      if (document.getElementById('loading')?.classList.contains('loading-done') &&
        !performance.getEntriesByName('viewer-compile-end').length) performance.mark('viewer-compile-end');
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  await startup.goto(`${base}/?${query}`);
  await startup.evaluate(() => window.__hydrogenLoader.ready);
  const gpu = await trace(startup, async () => {
    await startup.evaluate(() => { window.__catalogReleased = true; }); release();
    await startup.waitForFunction(() => window.__renderReady, undefined, { timeout: 90_000 });
  }, 'viewer-compile-start', 'viewer-compile-end');
  console.log(`STARTUP ${gpu.duration.toFixed(1)} ms compiling/drawing · ${gpu.frames} presented frames · p95 ${gpu.p95.toFixed(1)} ms · max gap including edges ${gpu.max.toFixed(1)} ms`);
  await startup.waitForFunction(() => document.getElementById('loading').hidden);
  await startup.waitForTimeout(300);
  assert.equal(startup.workers().length, 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS real viewer startup, hydration, fade, and cleanup');
  await startup.close();
} finally { await browser.close(); }
