// =============================================================================
// bake-loading.mjs — bake the loading screen's miniature orbital asset.
//
//   node scripts/bake-loading.mjs        (writes lib/loading-asset.ts)
//
// The loading screen renders ONE fixed scene (see lib/loading-scene.ts): the
// |1,0,0⟩ + |2,1,0⟩ superposition under time evolution. It therefore needs a
// vanishing fraction of assets/orbitals.bin — two radial tables, two angular
// tables, and two display quantiles — and it needs them *inline*, since its
// whole point is to be on screen long before a 16 MB fetch completes.
//
// So rather than re-deriving the physics, this script slices the certified
// HORB bake and resamples it down: 8192 → 512 radial samples, 4096 → 128
// angular samples, by exactly the linear interpolation the shader's own table
// lookup performs. The result is ~5 KB of Float32 (≈7 KB base64) emitted as a
// TypeScript module that ships inside the app's first JS chunk.
//
// Both states have m = 0, so their angular tables are P̄_00 (constant) and
// P̄_10 (∝ cos θ) — smooth enough that 128 samples hold ~1e-4 of peak, while
// the radial rows keep 512 so their piecewise-linear knots stay well below the
// isosurface shading's finite-difference step (gradDelta·rMax ≈ 0.16 a₀).
//
// Re-run after re-baking assets/orbitals.bin; the output is committed.
// =============================================================================

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(webRoot);
const src = join(repoRoot, "assets", "orbitals.bin");
const out = join(webRoot, "lib", "loading-asset.ts");

/** The scene's terms, in the order the shader's rows are indexed. */
const TERMS = [
  { n: 1, l: 0, m: 0 },
  { n: 2, l: 1, m: 0 },
];
const RADIAL_SAMPLES = 512;
const ANGULAR_SAMPLES = 128;

// ---------------------------------------------------------------- read HORB
const buf = readFileSync(src);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
if (buf.subarray(0, 4).toString("latin1") !== "HORB")
  throw new Error(`${src}: not a HORB asset`);
const version = dv.getUint32(4, true);
if (version !== 1) throw new Error(`${src}: unsupported HORB version ${version}`);
const headerLen = dv.getUint32(8, true);
const header = JSON.parse(buf.subarray(12, 12 + headerLen).toString("utf8"));
// The blob's byte offset is not necessarily 4-aligned — copy, as horb.ts does.
const blob = new Float32Array(
  buf.buffer.slice(
    buf.byteOffset + 12 + headerLen,
    buf.byteOffset + buf.byteLength,
  ),
);

/** Linear interpolation of `values` at normalized coordinate f ∈ [0,1] — the
 * CPU twin of lookupTableRow in shaders/common.glsl. */
function lookup(values, f) {
  const n = values.length;
  const x = Math.min(Math.max(f, 0), 1) * (n - 1);
  const i0 = Math.min(Math.floor(x), n - 2);
  const t = x - i0;
  return values[i0] * (1 - t) + values[i0 + 1] * t;
}

/** Resample a table onto `count` points of the same normalized coordinate. */
function resample(values, count) {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = lookup(values, i / (count - 1));
  return out;
}

const find = (list, pred, what) => {
  const hit = list.find(pred);
  if (!hit) throw new Error(`${src}: no ${what}`);
  return hit;
};

const rows = TERMS.map(({ n, l, m }) => {
  const radial = find(
    header.radial_tables,
    (t) => t.n === n && t.l === l,
    `radial table for n=${n}, l=${l}`,
  );
  const angular = find(
    header.angular_tables,
    (t) => t.l === l && t.m === Math.abs(m),
    `angular table for l=${l}, m=${Math.abs(m)}`,
  );
  const stats = find(
    header.stats,
    (s) => s.n === n && s.l === l && s.m === Math.abs(m) && s.mode === "real",
    `real-mode stats for (${n},${l},${m})`,
  );
  const full = (offset, count) => blob.subarray(offset, offset + count);
  return {
    n,
    l,
    m,
    rMax: radial.r_max,
    q999: stats.q999,
    radial: resample(full(radial.offset, header.radial_samples), RADIAL_SAMPLES),
    angular: resample(
      full(angular.offset, header.angular_samples),
      ANGULAR_SAMPLES,
    ),
    // Worst resampling residual against the full-resolution table, as a
    // fraction of that table's peak — reported so a re-bake that degrades the
    // approximation is visible rather than silent.
    radialErr: residual(full(radial.offset, header.radial_samples), RADIAL_SAMPLES),
    angularErr: residual(
      full(angular.offset, header.angular_samples),
      ANGULAR_SAMPLES,
    ),
  };
});

/** Worst |resampled − original| over the original grid, relative to its peak. */
function residual(values, count) {
  const small = resample(values, count);
  let peak = 0;
  let worst = 0;
  for (let i = 0; i < values.length; i++) {
    peak = Math.max(peak, Math.abs(values[i]));
    worst = Math.max(worst, Math.abs(lookup(small, i / (values.length - 1)) - values[i]));
  }
  return worst / (peak || 1);
}

// ------------------------------------------------------------------- emit TS
const pack = (arrays) => {
  const flat = new Float32Array(arrays.reduce((s, a) => s + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    flat.set(a, at);
    at += a.length;
  }
  return Buffer.from(flat.buffer).toString("base64");
};

const num = (x) => {
  const s = String(x);
  return s.includes(".") || s.includes("e") ? s : `${s}`;
};

const text = `// =============================================================================
// loading-asset.ts — GENERATED by scripts/bake-loading.mjs. Do not edit.
//
// The loading screen's miniature slice of assets/orbitals.bin: the radial and
// angular tables plus display quantiles for exactly the two states its scene
// superposes, resampled from the certified bake (see the script header for the
// resolutions and why they suffice) and inlined as base64 Float32 so the
// screen can render before any network fetch resolves.
// =============================================================================

/** States baked here, in row order — ψ = Σₖ cₖ · ψ_{nₖlₖmₖ}. */
export const LOADING_TERMS = [
${rows.map((r) => `  { n: ${r.n}, l: ${r.l}, m: ${r.m} },`).join("\n")}
] as const;

/** Per-term radial extent (a₀); ψₖ ≡ 0 beyond it. */
export const LOADING_RMAX = [${rows.map((r) => num(r.rMax)).join(", ")}];

/** Per-term real-mode |ψ|² display-normalization quantile. */
export const LOADING_Q999 = [${rows.map((r) => num(r.q999)).join(", ")}];

/** Framing half-extent for principal quantum number n: factor·n² + pad. */
export const LOADING_EXTENT = { factor: ${num(header.extent.factor)}, pad: ${num(header.extent.pad)} };

/** Uncompressed byte length of the full asset — the denominator for the
 * progress readout (Content-Length reports the *compressed* size when the host
 * serves the asset gzipped, which would overshoot). */
export const LOADING_ASSET_BYTES = ${statSync(src).size};

/** Table row widths. Row k of each blob belongs to LOADING_TERMS[k]. */
export const LOADING_RADIAL_WIDTH = ${RADIAL_SAMPLES};
export const LOADING_ANGULAR_WIDTH = ${ANGULAR_SAMPLES};

/** R_nl sampled uniformly in √(r/rMax), rows concatenated (little-endian
 * Float32, base64). Worst resampling residual vs the full table:
${rows.map((r) => ` *   (${r.n},${r.l}): ${r.radialErr.toExponential(2)} of peak`).join("\n")}
 */
export const LOADING_RADIAL_B64 =
  "${pack(rows.map((r) => r.radial))}";

/** P̄_lm sampled uniformly in θ ∈ [0, π], rows concatenated. Residuals:
${rows.map((r) => ` *   (${r.l},${Math.abs(r.m)}): ${r.angularErr.toExponential(2)} of peak`).join("\n")}
 */
export const LOADING_ANGULAR_B64 =
  "${pack(rows.map((r) => r.angular))}";
`;

writeFileSync(out, text);
const bytes = (rows.length * (RADIAL_SAMPLES + ANGULAR_SAMPLES)) * 4;
console.log(
  `bake-loading: wrote ${out}\n` +
    `  ${rows.length} terms · ${RADIAL_SAMPLES} radial + ${ANGULAR_SAMPLES} angular samples` +
    ` · ${bytes} B (${Math.round((bytes * 4) / 3)} B base64)`,
);
for (const r of rows)
  console.log(
    `  (${r.n},${r.l},${r.m}) rMax ${r.rMax.toFixed(3)} · q999 ${r.q999.toExponential(3)}` +
      ` · residual radial ${r.radialErr.toExponential(2)}, angular ${r.angularErr.toExponential(2)}`,
  );
