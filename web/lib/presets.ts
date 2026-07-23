// Curated starting scenes for the interactive viewer. Keeping the catalog out
// of GUI construction makes each scene deterministic, reviewable, and easy to
// exercise from browser automation.

import { defaultParams, type Params } from "./params";
import { clampTerm } from "./superposition";

export type PresetCategory = "superpositions" | "flow";

export interface ViewerPreset {
  id: string;
  category: PresetCategory;
  name: string;
  description: string;
  tags: readonly string[];
  values: Partial<Params>;
  /** Optional orbit-camera composition applied after the new scene loads. */
  camera?: { azDeg: number; elDeg: number; dist: number };
}

const term = (n: number, l: number, m: number, amp = 1, phaseDeg = 0) => ({
  n, l, m, amp, phaseDeg,
});

export const VIEWER_PRESETS: readonly ViewerPreset[] = [
  {
    id: "super-sp",
    category: "superpositions",
    name: "sp hybrid",
    description: "Stationary directional hybrid formed from degenerate 2s and 2p states.",
    tags: ["stationary", "volume"],
    values: {
      view: "volume", n: 2, l: 0, m: 0, mode: "real", color: "ramp",
      terms: [term(2, 0, 0), term(2, 1, 0)], superNormalize: true,
      timeRun: false, timeScale: 5, simTime: 0,
    },
    camera: { azDeg: 35, elDeg: 22, dist: 2.6 },
  },
  {
    id: "super-sp3",
    category: "superpositions",
    name: "sp³ hybrid",
    description: "Four n = 2 terms combine into a stationary tetrahedral orbital.",
    tags: ["stationary", "volume"],
    values: {
      view: "volume", n: 2, l: 0, m: 0, mode: "real", color: "ramp",
      terms: [term(2, 0, 0), term(2, 1, 1), term(2, 1, -1), term(2, 1, 0)],
      superNormalize: true, timeRun: false, timeScale: 5, simTime: 0,
    },
    camera: { azDeg: 38, elDeg: 28, dist: 2.6 },
  },
  {
    id: "super-dipole",
    category: "superpositions",
    name: "1s–2p dipole beat",
    description: "Textbook signed density transfer along z; Space pauses the oscillation.",
    tags: ["animated", "signed"],
    values: {
      view: "volume", n: 1, l: 0, m: 0, mode: "real", color: "signed",
      terms: [term(1, 0, 0), term(2, 1, 0)], superNormalize: true,
      timeRun: true, timeScale: 4, simTime: 0,
    },
    camera: { azDeg: 32, elDeg: 18, dist: 2.65 },
  },
  {
    id: "super-breathing",
    category: "superpositions",
    name: "2s + 3s breathing",
    description: "Purely radial interference moves probability between concentric shells.",
    tags: ["animated", "radial"],
    values: {
      view: "volume", n: 2, l: 0, m: 0, mode: "real", color: "ramp",
      terms: [term(2, 0, 0), term(3, 0, 0)], superNormalize: true,
      timeRun: true, timeScale: 20, simTime: 0,
    },
    camera: { azDeg: 35, elDeg: 25, dist: 2.6 },
  },
  {
    id: "super-spd",
    category: "superpositions",
    name: "3s + 3p + 3d lobe",
    description: "A stationary same-energy sculpture combining three angular characters.",
    tags: ["stationary", "volume"],
    values: {
      view: "volume", n: 3, l: 0, m: 0, mode: "real", color: "ramp",
      terms: [term(3, 0, 0), term(3, 1, 0), term(3, 2, 0)],
      superNormalize: true, timeRun: false, timeScale: 5, simTime: 0,
    },
    camera: { azDeg: 28, elDeg: 20, dist: 2.7 },
  },
  {
    id: "super-rydberg",
    category: "superpositions",
    name: "Circular Rydberg packet",
    description: "An equatorial phase portrait of a localized n = 8…13 packet, showing orbital motion and revival.",
    tags: ["animated", "phase slice"],
    values: {
      view: "slice", n: 10, l: 9, m: 9, mode: "complex", color: "okphase",
      terms: [8, 9, 10, 11, 12, 13].map((n) =>
        term(n, n - 1, n - 1, +Math.exp(-((n - 10.3) ** 2) / (2 * 1.3 ** 2)).toFixed(3))),
      superNormalize: true, timeRun: true, timeScale: 900, simTime: 0,
      slicePlane: "xy", sliceOffset: 0, sliceZoom: 1.15,
      compress: "asinh", compressK: 12, compressWhite: 3,
    },
  },
  {
    id: "flow-transfer",
    category: "flow",
    name: "1s–2p oscillation · advected ink",
    description: "Transport crosses the moving interference lobes while persistent dye exposes its path.",
    tags: ["animated", "slice", "genuine flow"],
    values: {
      view: "slice", n: 1, l: 0, m: 0, mode: "real", color: "signed",
      terms: [term(1, 0, 0), term(2, 1, 0)], superNormalize: true,
      slicePlane: "xz", sliceOffset: 0, sliceZoom: 1.15,
      flowEnabled: true, flowMethod: "ink", flowBase: 0.06, flowTimeScale: 10,
      flowColor: "palette-material", flowColorGain: 1.5,
      flowDensityGate: 0.08, flowInkScale: 80, flowInkDecay: 0.25,
      flowInkInjection: 2, flowInkDiffusion: 0.03,
      flowInkContrast: 0.65, flowInkOpacity: 1.8,
      flowRun: true, timeRun: true, timeScale: 4, simTime: 0,
    },
  },
] as const;

export const PRESET_CATEGORIES: readonly {
  id: PresetCategory;
  label: string;
  description: string;
}[] = [
  {
    id: "superpositions",
    label: "superpositions",
    description: "Curated combinations with deterministic rendering and composition",
  },
  {
    id: "flow",
    label: "probability flow",
    description: "Selected studies where transport adds clear physical meaning",
  },
];

/** Load one authored scene while preserving only device/output preferences. */
export function applyViewerPreset(params: Params, preset: ViewerPreset, nMax: number) {
  // lil-gui binds clip controls to the two nested objects, not to the array
  // property. Preserve those object identities while replacing their values;
  // otherwise applying a preset leaves the visible controls detached from the
  // clip state consumed by the renderer.
  const boundClips = params.clips;
  const defaults = defaultParams();
  const output = {
    renderScale: params.renderScale,
    autoQuality: params.autoQuality,
    captureScale: params.captureScale,
    captureSpp: params.captureSpp,
    captureFlowFrames: params.captureFlowFrames,
    rampStops: params.rampStops.map((stop) => ({ ...stop })),
  };
  Object.assign(params, defaults, output, preset.values);
  const nextClips = preset.values.clips ?? defaults.clips;
  boundClips.forEach((clip, i) => Object.assign(clip, nextClips[i]));
  params.clips = boundClips;
  params.terms = (preset.values.terms ?? []).map((value) =>
    clampTerm({ ...value }, nMax));
}
