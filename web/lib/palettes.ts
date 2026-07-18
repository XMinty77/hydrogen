// =============================================================================
// palettes.ts — reader for assets/palettes.json (designed in lab/scripts/
// palettes.jl; TypeScript mirror of export/Palettes/PaletteSet.cs).
//
// Ramps carry their stops in both sRGB and OKLab so the renderer can upload
// whichever space it is configured to interpolate in. The phase wheel carries
// a 257-sample per-hue max-chroma curve (last sample repeats the first, so a
// clamped texture lookup acts cyclic) — the "vivid" wheel data.
// =============================================================================

export interface Ramp {
  positions: number[];
  srgb: number[][];
  oklab: number[][];
}

export interface PaletteSet {
  ramps: Record<string, Ramp>;
  phaseL: number;
  phaseC: number;
  phaseH0: number;
  phaseCmax: Float32Array;
}

export async function loadPalettes(url: string): Promise<PaletteSet> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const json = await res.json();
  return {
    ramps: json.ramps,
    phaseL: json.phase.L,
    phaseC: json.phase.C,
    phaseH0: json.phase.h0,
    phaseCmax: Float32Array.from(json.phase.cmax),
  };
}
