// =============================================================================
// horb.ts — reader for the baked orbital asset (HORB v1).
//
// TypeScript mirror of export/Horb/HorbAsset.cs and the reference reader in
// lab/src/asset.jl. Format:
//
//   bytes 0..3   magic "HORB"
//   bytes 4..7   UInt32 version (= 1), little-endian
//   bytes 8..11  UInt32 JSON header length H
//   12..12+H-1   UTF-8 JSON header (table offsets in Float32 *elements*)
//   rest         one contiguous little-endian Float32 blob
//
// Table semantics (fixed by the format; see lab/src/tables.jl):
//   radial (n,l)  — R_nl sampled uniformly in √(r/r_max), r_max per table
//   angular (l,m) — P̄_lm sampled uniformly in θ ∈ [0, π], m = |m| ≥ 0
//   stats         — per (n, l, |m|, mode) display-normalization quantiles
// =============================================================================

export interface RadialTable {
  n: number;
  l: number;
  rMax: number;
  values: Float32Array;
}

export interface AngularTable {
  l: number;
  m: number;
  values: Float32Array;
}

/** Volume-weighted |ψ|² statistics for display normalization. Baked so every
 * render of a state — any cut, any camera, any frame — shares one fixed
 * normalization and nothing flickers. */
export interface DisplayStats {
  maxDensity: number;
  q999: number;
  q9999: number;
}

export interface HorbAsset {
  nMax: number;
  extentFactor: number;
  extentPad: number;
  radial: Map<string, RadialTable>; // key `${n},${l}`
  angular: Map<string, AngularTable>; // key `${l},${|m|}`
  stats: Map<string, DisplayStats>; // key `${n},${l},${|m|},${"real"|"complex"}`
}

export const radialKey = (n: number, l: number) => `${n},${l}`;
export const angularKey = (l: number, m: number) => `${l},${Math.abs(m)}`;
export const statsKey = (n: number, l: number, m: number, realMode: boolean) =>
  `${n},${l},${Math.abs(m)},${realMode ? "real" : "complex"}`;

/** Display/framing radius for principal quantum number n — the default
 * half-extent for slices and camera framing. The radial tables themselves
 * extend farther (to their per-state safe clip radius). */
export function framingRadius(asset: HorbAsset, n: number): number {
  return asset.extentFactor * n * n + asset.extentPad;
}

export function parseHorb(buf: ArrayBuffer): HorbAsset {
  const dv = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== "HORB") throw new Error("not a HORB asset (bad magic)");
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error(`unsupported HORB version ${version}`);

  const headerLen = dv.getUint32(8, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 12, headerLen)),
  );

  // The blob's byte offset (12 + headerLen) is not necessarily 4-aligned, so a
  // zero-copy Float32Array view is not guaranteed to be legal — copy it once.
  const blob = new Float32Array(buf.slice(12 + headerLen));
  const take = (offset: number, count: number) =>
    blob.subarray(offset, offset + count);

  const radialSamples: number = header.radial_samples;
  const angularSamples: number = header.angular_samples;

  const radial = new Map<string, RadialTable>();
  for (const t of header.radial_tables)
    radial.set(radialKey(t.n, t.l), {
      n: t.n,
      l: t.l,
      rMax: t.r_max,
      values: take(t.offset, radialSamples),
    });

  const angular = new Map<string, AngularTable>();
  for (const t of header.angular_tables)
    angular.set(angularKey(t.l, t.m), {
      l: t.l,
      m: t.m,
      values: take(t.offset, angularSamples),
    });

  const stats = new Map<string, DisplayStats>();
  for (const s of header.stats)
    stats.set(statsKey(s.n, s.l, s.m, s.mode === "real"), {
      maxDensity: s.max,
      q999: s.q999,
      q9999: s.q9999,
    });

  return {
    nMax: header.n_max,
    extentFactor: header.extent.factor,
    extentPad: header.extent.pad,
    radial,
    angular,
    stats,
  };
}

export async function loadHorb(url: string): Promise<HorbAsset> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return parseHorb(await res.arrayBuffer());
}
