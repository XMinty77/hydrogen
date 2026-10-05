// Independent pixel comparison with the archived table-based live renderer.
// No server is needed; test-only clocks sample the complete signed color cycle.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import ts from 'typescript';
import sharp from 'sharp';
import { chromium } from 'playwright';

function factory(name) {
  let js = '';
  for (const part of ['color', 'loading-asset', name]) {
    let source = readFileSync(new URL(`../lib/${part}.ts`, import.meta.url), 'utf8');
    // Large time jumps in this deterministic test should not trigger the FPS governor.
    source = source.replace('if (emaMs > 45', 'if (false && emaMs > 45');
    // Normalize the archived reference's backdrop to the current black page.
    // Keep its orbital palette, table evaluation, lighting, and bloom intact.
    if (part === 'loading-scene')
      source = source.replace('vec3 bgLinear = rampColorLinear(0.0);', 'vec3 bgLinear = vec3(0.0);');
    js += ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, removeComments: true,
    } }).outputText.replace(/^import[^]*?from "[^"]+";\n/gm, '').replace(/^export /gm, '');
  }
  return `function factory(canvas){${js};return startLoadingScene(canvas,performance.timeOrigin,true);}`;
}

const browser = await chromium.launch({ args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist'] });
mkdirSync('.shots', { recursive: true });
try {
  const pages = [];
  for (const name of ['loading-scene', 'loading-orbital']) {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setContent(`<!doctype html><style>body{margin:0;background:#000}canvas{width:256px;height:256px}</style><canvas></canvas><script>
      let queue=[],clock=0;requestAnimationFrame=fn=>{queue.push(fn);return queue.length};performance.now=()=>clock;
      ${factory(name)}
      const scene=factory(document.querySelector('canvas'));if(!scene)throw Error('Reference GL unavailable');
      window.step=ms=>{do{clock=Math.min(ms,clock+100);const next=queue;queue=[];next.forEach(fn=>fn(clock));}while(clock<ms)};
    </script>`);
    assert.equal(errors.length, 0, errors.join('\n')); pages.push(page);
  }
  const tiles = [], errors = [];
  for (let phase = 0; phase < 16; phase++) {
    const time = phase * 4 * Math.PI * 1000 / 16;
    const shots = [];
    for (const page of pages) { await page.evaluate(t => window.step(t), time); shots.push(await page.screenshot()); }
    const raw = await Promise.all(shots.map(s => sharp(s).raw().toBuffer()));
    let difference = 0;
    for (let i = 0; i < raw[0].length; i++) difference += Math.abs(raw[0][i] - raw[1][i]);
    const mae = difference / raw[0].length; errors.push(mae);
    assert(mae < .25, `phase ${phase}/16 differs from reference: ${mae.toFixed(4)}/255`);
    // Original on left, analytic version on right, four phase pairs per row.
    shots.forEach((input, version) => tiles.push({ input,
      left: (phase % 4) * 512 + version * 256, top: Math.floor(phase / 4) * 256 }));
  }
  await sharp({ create: { width: 2048, height: 1024, channels: 3, background: '#000' } })
    .composite(tiles).png().toFile('.shots/loading-cycle-comparison.png');
  console.log(`PASS all 16 phases of full 12.56637 s cycle · maximum mean channel difference ${Math.max(...errors).toFixed(4)}/255`);
} finally { await browser.close(); }
