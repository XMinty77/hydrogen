// =============================================================================
// superposition.ts — superposed-orbital state: terms, time evolution, presets.
//
// A superposition is a list of terms ψ = Σₖ cₖ ψ_{nₖlₖmₖ} where the user gives
// each term an amplitude and a phase offset, in either harmonic basis (the
// "real"/"complex" mode applies to the whole sum — both bases are legitimate:
// the real orbitals are a unitary rotation of the complex ones).
//
// Time evolution: every basis orbital is an energy eigenstate (real orbitals
// combine only degenerate ±m states), so ψₖ(t) = ψₖ·e^{−iEₙt} with
// Eₙ = −1/(2n²) hartree. The whole time dependence therefore lives in the
// complex coefficients — computed here on the CPU each frame, uploaded as
// uSupCoef, costing the shader nothing. Beats between different n produce
// genuine |ψ|² motion; equal-n superpositions are stationary (their relative
// phases never change), which is itself physically faithful.
//
// Display normalization: |ψ|² integrates to Σ|cₖ|²·∫|ψₖ|² by orthogonality,
// so the effective q999 quantile is the |cₖ|²-weighted sum of the per-state
// quantiles — exact in the mean, and interference peaks are absorbed by the
// display mapping's clamp exactly like the single-state q999 excursions.
// =============================================================================

import type { HorbAsset } from "./horb";
import { framingRadius, statsKey } from "./horb";

export interface SuperTerm {
  n: number;
  l: number;
  m: number;
  /** Coefficient magnitude (relative; optionally normalized across terms). */
  amp: number;
  /** Coefficient phase offset at t = 0, degrees. */
  phaseDeg: number;
}

export const MAX_TERMS = 8;

/** Bound-state energy, hartree (atomic units): Eₙ = −1/(2n²). */
export const energyOf = (n: number) => -0.5 / (n * n);

/** Clamp a term's quantum numbers into validity (l < n, |m| ≤ l). */
export function clampTerm(t: SuperTerm, nMax: number): SuperTerm {
  const n = Math.max(1, Math.min(nMax, Math.round(t.n)));
  const l = Math.max(0, Math.min(n - 1, Math.round(t.l)));
  const m = Math.max(-l, Math.min(l, Math.round(t.m)));
  return { ...t, n, l, m };
}

/** Complex coefficients cₖ(t) = norm·ampₖ·e^{i(φ₀ₖ − Eₙₖ·t)} as a flat
 * [re₀, im₀, re₁, im₁, …] array ready for the uSupCoef upload. */
export function coefficientsAt(
  terms: SuperTerm[],
  timeAu: number,
  normalize: boolean,
): Float32Array {
  let scale = 1;
  if (normalize) {
    const sum = terms.reduce((s, t) => s + t.amp * t.amp, 0);
    scale = sum > 0 ? 1 / Math.sqrt(sum) : 1;
  }
  const out = new Float32Array(terms.length * 2);
  terms.forEach((t, k) => {
    const phase = (t.phaseDeg * Math.PI) / 180 - energyOf(t.n) * timeAu;
    out[2 * k] = scale * t.amp * Math.cos(phase);
    out[2 * k + 1] = scale * t.amp * Math.sin(phase);
  });
  return out;
}

/** |cₖ|²-weighted display-normalization quantile (see file header). */
export function effectiveQ999(
  terms: SuperTerm[],
  asset: HorbAsset,
  realMode: boolean,
  normalize: boolean,
): number {
  const sum = terms.reduce((s, t) => s + t.amp * t.amp, 0);
  const scale = normalize && sum > 0 ? 1 / sum : 1;
  let q = 0;
  for (const t of terms) {
    const stats = asset.stats.get(statsKey(t.n, t.l, t.m, realMode));
    if (!stats) throw new Error(`no stats for (${t.n},${t.l},${t.m})`);
    q += scale * t.amp * t.amp * stats.q999;
  }
  return q > 0 ? q : 1;
}

/** Framing radius covering every term (drives camera distance + slice extent). */
export function superFraming(terms: SuperTerm[], asset: HorbAsset): number {
  return Math.max(...terms.map((t) => framingRadius(asset, t.n)));
}

/** The slowest beat period 2π/min|ΔE| across term pairs, in atomic units —
 * used to suggest a time scale that makes the dynamics visible. Returns null
 * for degenerate (stationary) superpositions. */
export function beatPeriod(terms: SuperTerm[]): number | null {
  let dEmin = Infinity;
  for (let i = 0; i < terms.length; i++)
    for (let j = i + 1; j < terms.length; j++) {
      const dE = Math.abs(energyOf(terms[i].n) - energyOf(terms[j].n));
      if (dE > 1e-12) dEmin = Math.min(dEmin, dE);
    }
  return Number.isFinite(dEmin) ? (2 * Math.PI) / dEmin : null;
}

// ---------------------------------------------------------------------------
// URL codec: terms=n,l,m,amp,phaseDeg;… (amp/phase optional, default 1/0).
// Commas and semicolons are query-safe, so superpositions stay readable links.
// ---------------------------------------------------------------------------

export function encodeTerms(terms: SuperTerm[]): string {
  return terms
    .map((t) => {
      const base = `${t.n},${t.l},${t.m}`;
      const amp = +t.amp.toFixed(3);
      const ph = +t.phaseDeg.toFixed(1);
      return ph !== 0 ? `${base},${amp},${ph}` : amp !== 1 ? `${base},${amp}` : base;
    })
    .join(";");
}

export function decodeTerms(spec: string, nMax: number): SuperTerm[] {
  const terms: SuperTerm[] = [];
  for (const part of spec.split(";")) {
    const v = part.split(",").map(Number);
    if (v.length < 3 || v.slice(0, 3).some((x) => !Number.isFinite(x))) continue;
    terms.push(
      clampTerm(
        {
          n: v[0],
          l: v[1],
          m: v[2],
          amp: Number.isFinite(v[3]) ? Math.max(0, v[3]) : 1,
          phaseDeg: Number.isFinite(v[4]) ? v[4] : 0,
        },
        nMax,
      ),
    );
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}
