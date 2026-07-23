// =============================================================================
// params.ts — the UI parameter model and its URL codec.
//
// One plain object (`Params`) holds every user-facing setting; lil-gui and the
// custom panels bind straight to it. The URL vocabulary mirrors the offline
// CLI (export/Program.cs) and is table-driven: NUM_KEYS lists every numeric
// parameter once, and both the parser (applyUrlOverrides) and the writer
// (buildQuery) walk the same table, so the two directions cannot drift.
//
// buildQuery writes only values that differ from the defaults, and only for
// parameter groups the current view/technique actually reads — the address
// bar mirrors the live view without becoming a wall of noise.
// =============================================================================

import type { SuperTerm } from "./superposition";
import { decodeTerms, encodeTerms } from "./superposition";

export type ClipAxis = "forward" | "right" | "up";

export interface ClipParams {
  enabled: boolean;
  axis: ClipAxis;
  /** Plane offset from the origin along the axis, in framing radii. */
  offset: number;
  /** Keep the near side instead of the far side. */
  flip: boolean;
  /** Follow the live camera (the axis re-orients every frame) instead of
   * staying fixed in the initial camera's reference frame. */
  camLock: boolean;
}

/** One editable ramp stop (sRGB hex + position ∈ [0,1]). */
export interface RampStop {
  pos: number;
  hex: string;
}

export const TECHNIQUES = ["mip", "ea", "scatter", "mida", "iso", "isolegacy", "pathtrace", "eikonal"] as const;
export type Technique = (typeof TECHNIQUES)[number];

export const ENVS = ["black", "uniform", "studio", "hue", "checker"] as const;
export type EnvName = (typeof ENVS)[number];

export const SHADE_MODELS = ["off", "lambert", "blinn", "ggx"] as const;
export type ShadeModel = (typeof SHADE_MODELS)[number];

export const FLOW_METHODS = [
  "ink", "motes", "trails", "accretion", "granular",
] as const;
export type FlowMethod = (typeof FLOW_METHODS)[number];
export const FLOW_VOLUME_METHODS = ["granular"] as const;

export const FLOW_COLORS = ["palette-speed", "palette-material", "phase"] as const;
export type FlowColor = (typeof FLOW_COLORS)[number];

export const FLOW_SEEDS = ["density", "flux", "uniform"] as const;
export type FlowSeed = (typeof FLOW_SEEDS)[number];

export const FLOW_DERIVATIVES = ["central", "fourth"] as const;
export type FlowDerivative = (typeof FLOW_DERIVATIVES)[number];

export const FLOW_INTEGRATORS = ["euler", "midpoint"] as const;
export type FlowIntegrator = (typeof FLOW_INTEGRATORS)[number];

export const FLOW_COMPOSITES = ["additive", "screen", "alpha"] as const;
export type FlowComposite = (typeof FLOW_COMPOSITES)[number];

export const BLOOM_COMPOSITES = ["screen", "additive"] as const;
export type BloomComposite = (typeof BLOOM_COMPOSITES)[number];

export const COLOR_MODE = { ramp: 0, signed: 1, phase: 2, okphase: 3 } as const;
export type ColorName = keyof typeof COLOR_MODE;
export const COLOR_NAMES = ["ramp", "signed", "phase", "okphase"] as const;
// isolegacy shares the isosurface integrator (4); the uIsoLegacy uniform picks
// the original shell shading (set from the technique name in OrbitalViewer).
export const INTEGRATOR = { mip: 0, ea: 1, scatter: 2, mida: 3, iso: 4, isolegacy: 4 } as const;
export const TONEMAP = { gamma: 0, agx: 1 } as const;
export const COMPRESS = { off: 0, log: 1, asinh: 2 } as const;
export const ENV_MODE = { black: 0, uniform: 1, studio: 2, hue: 3, checker: 4 } as const;
export const SHADE_MODEL = { off: 0, lambert: 1, blinn: 2, ggx: 3 } as const;
export const FLOW_COLOR = { "palette-speed": 0, "palette-material": 1, phase: 2 } as const;
export const FLOW_SEED = { density: 0, flux: 1, uniform: 2 } as const;
export const FLOW_DERIVATIVE = { central: 0, fourth: 1 } as const;
export const FLOW_INTEGRATOR = { euler: 0, midpoint: 1 } as const;
export const FLOW_COMPOSITE = { additive: 0, screen: 1, alpha: 2 } as const;

/** Wrap an angle in degrees to (−180, 180] — camera/plane azimuths and rolls
 * stay in one canonical revolution no matter how far the user drags. */
export function wrapDeg(a: number): number {
  const w = ((a + 180) % 360 + 360) % 360 - 180;
  return w === -180 ? 180 : w;
}

/** The default sRGB stops of the editable custom ramp — seeded from the
 * project's accretion look so opening the editor starts somewhere pleasant. */
export const DEFAULT_CUSTOM_STOPS: RampStop[] = [
  { pos: 0, hex: "#05030f" },
  { pos: 0.35, hex: "#3b1c58" },
  { pos: 0.65, hex: "#e0562e" },
  { pos: 0.85, hex: "#ffc94e" },
  { pos: 1, hex: "#fff7e0" },
];

/** The full UI state. Defaults reproduce the offline CLI's defaults so web
 * and stills start from the same picture. */
export function defaultParams() {
  return {
    view: "volume" as "slice" | "volume",
    n: 4,
    l: 2,
    m: 1,
    mode: "complex" as "real" | "complex",

    // Superposition (empty terms = plain single state; see superposition.ts).
    terms: [] as SuperTerm[],
    superNormalize: true,

    // Time evolution: ψₖ picks up e^{−iEₙt}; visible as phase-hue rotation on
    // a single state and as genuine |ψ|² beats on multi-n superpositions.
    timeRun: false,
    /** Simulated atomic-units of time per wall-clock second (log-scaled UI). */
    timeScale: 5,
    /** Current simulated time, au. In the URL only while paused (so a shared
     * link reproduces the exact frame). */
    simTime: 0,

    // Color follows the mode by default (ramp for real, phase for complex),
    // mirroring the CLI (export/Program.cs). applyUrlOverrides re-derives this
    // from the resolved mode, so a bare ?mode=real still lands on ramp; after
    // load the two controls are fully independent (mode changes never touch it).
    color: "phase" as ColorName,
    value: "density" as "density" | "amplitude",
    gamma: 0.71,
    /** Extra range compression before gamma (esp. for MIDA): see common.glsl. */
    compress: "off" as "off" | "log" | "asinh",
    compressK: 20,
    /** HDR white point in multiples of q999 (1 = off). Raise it — best with a
     * log/asinh compress — to pull the saturated lobe cores back into the ramp
     * so their interior gradient shows instead of clamping to one flat color. */
    compressWhite: 1,
    dither: true,

    // Screen-space finishing. The master switch is off by default so analytic
    // comparisons retain the established output; enabling it starts with a
    // restrained soft-knee bloom. Every effect operates on the completed
    // scene, including probability flow, and is included in PNG capture.
    postEnabled: false,
    bloomEnabled: true,
    bloomThreshold: 0.72,
    bloomKnee: 0.4,
    bloomIntensity: 0.55,
    bloomRadius: 1,
    bloomIterations: 3,
    bloomScale: 0.5,
    bloomSaturation: 1,
    bloomTint: "#ffffff",
    bloomComposite: "screen" as BloomComposite,
    postExposure: 0,
    postContrast: 1,
    postSaturation: 1,
    postVibrance: 0,
    postAberration: 0,
    postAberrationFalloff: 1.5,
    vignetteEnabled: false,
    vignetteAmount: 0.28,
    vignetteRadius: 0.82,
    vignetteSoftness: 0.38,
    vignetteRoundness: 1,
    vignetteCenterX: 0,
    vignetteCenterY: 0,
    grainEnabled: false,
    grainAmount: 0.025,
    grainScale: 1,
    grainSpeed: 1,
    grainColored: false,

    ramp: "accretion_tuned",
    rampSpace: "oklab" as "oklab" | "srgb",
    /** Stops of the user-editable "custom" ramp (palette editor). */
    rampStops: DEFAULT_CUSTOM_STOPS.map((s) => ({ ...s })) as RampStop[],
    phaseVivid: true,
    phaseChromaPow: 0.6,
    /** okphase only: also reflect the hue across the signed mode's 250° OKLab
     * axis on the negative-real half, so ψ and −ψ read as complementary. */
    okPhaseSigned: false,
    // Phase-wheel overrides; NaN = "use the palette file's value" (resolved
    // after palettes.json loads — see OrbitalViewer).
    phaseL: NaN,
    phaseC: NaN,
    phaseH0Deg: NaN,

    /** Canvas backing-store scale relative to CSS pixels × devicePixelRatio.
     * < 1 renders below display resolution (fast, for weak GPUs); > 1
     * oversamples and lets the browser downscale — supersampled AA. */
    renderScale: 0.25,
    /** Drop resolution automatically when the frame rate tanks (low-end GPUs);
     * the slider above stays the upper bound. */
    autoQuality: true,
    /** Backing-store scale used only while exporting a PNG. Interactive
     * renderScale and the auto-quality multiplier are ignored for capture. */
    captureScale: 2,
    /** Path-tracer convergence target for an interactive PNG capture. */
    captureSpp: 64,
    /** Warm-up frames used to rebuild resolution-dependent ink/trail history. */
    captureFlowFrames: 30,

    // Genuine probability flow. Every method transports visible material with
    // v = j/(rho+epsilon): slice dye, persistent 3-D tracers, or a world-space
    // dye atlas. Presentation changes never add velocity to the field.
    flowEnabled: false,
    flowMethod: "accretion" as FlowMethod,
    flowRun: true,
    flowReverse: false,
    flowDerivative: "central" as FlowDerivative,
    /** Finite-difference half-step, fraction of the orbital domain. */
    flowDelta: 0.0025,
    /** Transport regularizer epsilon in multiples of q999. */
    flowNodeEps: 0.0005,
    /** Atomic units advanced per wall-clock second. */
    flowTimeScale: 160,
    /** Safety cap in complete domain radii per wall-clock second. */
    flowMaxSpeed: 1.5,
    flowIntegrator: "midpoint" as FlowIntegrator,
    flowSubsteps: 1,
    flowSeed: "density" as FlowSeed,
    flowSeedPower: 0.65,
    flowSpawnTries: 8,
    flowSeedInsideClips: true,
    /** Incrementing this deterministically changes the random ensemble/noise. */
    flowResetNonce: 0,
    /** Dim underlying density so transported light remains legible. */
    flowBase: 0.18,
    flowColor: "palette-speed" as FlowColor,
    flowColorGain: 3,
    flowColorFloor: 0.08,
    flowDensityGate: 0.45,
    flowLegend: true,

    // 3-D persistent particle ensemble. particleSide² motes are integrated on
    // the GPU. A short local ribbon plus the temporal HDR buffer creates trails.
    flowParticleSide: 128,
    flowLifetime: 8,
    flowStreakLength: 0.035,
    flowSpeedStretch: 0.65,
    flowWidth: 0.85,
    flowHalo: 5,
    flowHaloGain: 0.12,
    flowTailPower: 1.6,
    flowHeadBoost: 1.2,
    flowOpacity: 0.012,
    flowTrailHalfLife: 0.9,
    flowTrailDiffusion: 0.012,
    flowEmission: 4.5,
    flowCompositeOpacity: 1,
    flowComposite: "screen" as FlowComposite,
    flowClipVisible: true,

    // Slice dye: semi-Lagrangian backtracing + continual density/flux-seeded
    // noise injection. It is independent of 3-D trail persistence.
    flowInkScale: 64,
    flowInkDecay: 0.32,
    flowInkInjection: 0.55,
    flowInkDiffusion: 0.08,
    flowInkThroughFade: 0.65,
    flowInkContrast: 1.35,
    flowInkOpacity: 0.86,

    // World-space passive dye. z slices are stored in a 2-D RGBA8 atlas,
    // semi-Lagrangian transported, then sampled as a sparse stochastic medium.
    // Analytic rho remains a separate visibility gate in the resolve.
    flowVolumeGrid: 36,
    flowVolumeSteps: 80,
    flowVolumeNoiseScale: 11,
    flowVolumeNoiseOctaves: 4,
    flowVolumeLacunarity: 2.03,
    flowVolumePersistence: 0.52,
    flowVolumeNoiseContrast: 1.25,
    flowVolumeDecay: 0.01,
    flowVolumeInjection: 0.015,
    flowVolumeDiffusion: 0.005,
    flowVolumeCorrection: 0.85,
    flowVolumeSignalGain: 2.6,
    flowVolumeSignalPow: 1.2,
    flowVolumeThreshold: 0.12,
    flowVolumeSoftness: 0.16,
    flowVolumeExtinction: 1.5,
    flowVolumeEmission: 1.3,
    flowVolumeOpacity: 0.42,
    flowVolumeDitherAmount: 0.92,
    flowVolumeDitherScale: 46,
    flowVolumeDitherRate: 4,
    flowVolumeDitherCoverage: 0.28,
    flowVolumeRayJitter: 1,

    // Slice: presets use the CLI's exact axes; "custom" orients the plane
    // normal by azimuth/elevation, spins it with roll, and slides it along
    // its normal. Dragging on the canvas rotates the custom plane.
    slicePlane: "xz" as "xz" | "xy" | "yz" | "custom",
    sliceAz: 90,
    sliceEl: 0,
    sliceRoll: 0,
    /** Offset along the plane normal, in framing radii. */
    sliceOffset: 0,
    sliceZoom: 1,

    // Volume — shared by the raymarched techniques. EA defaults are
    // parity-locked with the offline host.
    technique: "ea" as Technique,
    steps: 64,
    density: 5,
    opacityPow: 2.15,
    emission: 6.7,
    tonemap: "gamma" as "gamma" | "agx",
    exposure: 0,
    fov: 40,
    /** Overlay the 3-D orientation axes (X red, Y green, Z blue) — a rotation
     * aid, blended over the finished frame (volume view only). */
    axes: false,
    /** Compact "gizmo" axes: short arms clustered around the origin/crosshair
     * (Minecraft F3 style) instead of full arms spanning the domain. Only has
     * an effect while `axes` is on. */
    axesGizmo: false,

    // Key light (scatter, lit isosurfaces, surface shading, path tracer).
    lightAz: -30,
    lightEl: 50,
    lightGain: 6,
    /** Henyey–Greenstein anisotropy: 0 isotropic, >0 forward (halos toward
     * the light), <0 backward. */
    hgG: 0.35,

    // Anisotropic ambient multi-scattering (technique "scatter").
    shadowSteps: 24,
    shadowDensity: 120,
    octaves: 3,
    octaveGain: 0.5,
    octaveExt: 0.4,
    ambientGain: 2,
    ambientDirs: 6,
    ambientRadius: 0.25,
    ambientDensity: 250,

    // MIDA (technique "mida"): −1 = plain EA … 0 = MIDA … +1 = MIP.
    midaGamma: 0,

    // Emissive isosurfaces (technique "iso"). Sweeping isoLevel pages
    // through the field's nested shells ("3D slides").
    isoLevel: 0.5,
    isoCount: 3,
    isoSpacing: 0.5,
    isoAlpha: 0.4,
    isoEmission: 2.5,
    isoRim: 1.5,
    /** Ramp-walk floor for iso shells: how far up the palette an unlit face
     * sits (0 = the shell's own cool level, 1 = flat fully-hot). See volume.frag. */
    isoAmbient: 0.15,

    // Local illumination overlay (ea/scatter volumes + isosurfaces).
    shadeModel: "off" as ShadeModel,
    shadeDiffuse: 0.5,
    shadeSpec: 2,
    shadeRough: 0.3,
    shadeF0: 0.05,
    /** Gradient-confidence gate: higher = only the sharpest shells get lit. */
    shadeConf: 1.5,
    /** Finite-difference half-step for gradients, fraction of rMax. */
    gradDelta: 0.004,

    // Volumetric path tracing (technique "pathtrace").
    maxBounces: 4,
    albedo: 0.85,
    /** 0 white scattering … 1 palette-colored multiple scattering. */
    scatterTint: 0.7,
    sppFrame: 1,
    /** Thin-lens aperture, in framing radii (0 = pinhole). */
    aperture: 0,
    /** Focal distance, in framing radii (the default camera orbits at 2.6). */
    focus: 2.6,
    ptEnv: "black" as EnvName,
    ptEnvGain: 1,

    // Eikonal refraction. The studio environment and gentle logarithmic map
    // produce the default opalescent look; visible splits at nodal planes are
    // field structure, not mesh seams.
    eikSteps: 300,
    iorScale: 0.25,
    eikMap: "log" as "pow" | "log",
    eikPow: 0.5,
    eikLogK: 10,
    absorb: 1,
    eikEmission: 3,
    dispersion: 0.05,
    eikEnv: "studio" as EnvName,
    eikEnvGain: 1,
    eikGradDelta: 0.004,

    clips: [
      { enabled: false, axis: "forward", offset: 0, flip: false, camLock: false },
      { enabled: false, axis: "up", offset: 0, flip: false, camLock: false },
    ] as [ClipParams, ClipParams],
  };
}
export type Params = ReturnType<typeof defaultParams>;

// ---------------------------------------------------------------------------
// URL vocabulary. Bespoke keys (state, camera, clip, slice geometry, terms,
// rampStops) keep dedicated handling; every plain numeric parameter goes
// through this table — one row per parameter: [key, round-digits, integer?].
// ---------------------------------------------------------------------------
export type NumKey = {
  [K in keyof Params]: Params[K] extends number ? K : never;
}[keyof Params];

export const NUM_KEYS: [NumKey, number, boolean?][] = [
  ["gamma", 3],
  ["compressK", 1],
  ["compressWhite", 2],
  ["phaseChromaPow", 3],
  ["phaseL", 3],
  ["phaseC", 3],
  ["phaseH0Deg", 1],
  ["renderScale", 3],
  ["captureScale", 2],
  ["captureSpp", 0, true],
  ["captureFlowFrames", 0, true],
  ["bloomThreshold", 3],
  ["bloomKnee", 3],
  ["bloomIntensity", 3],
  ["bloomRadius", 2],
  ["bloomIterations", 0, true],
  ["bloomScale", 2],
  ["bloomSaturation", 2],
  ["postExposure", 2],
  ["postContrast", 2],
  ["postSaturation", 2],
  ["postVibrance", 2],
  ["postAberration", 2],
  ["postAberrationFalloff", 2],
  ["vignetteAmount", 2],
  ["vignetteRadius", 2],
  ["vignetteSoftness", 2],
  ["vignetteRoundness", 2],
  ["vignetteCenterX", 2],
  ["vignetteCenterY", 2],
  ["grainAmount", 3],
  ["grainScale", 2],
  ["grainSpeed", 2],
  ["flowDelta", 5],
  ["flowNodeEps", 6],
  ["flowTimeScale", 2],
  ["flowMaxSpeed", 2],
  ["flowSubsteps", 0, true],
  ["flowSeedPower", 2],
  ["flowSpawnTries", 0, true],
  ["flowResetNonce", 0, true],
  ["flowBase", 2],
  ["flowColorGain", 2],
  ["flowColorFloor", 2],
  ["flowDensityGate", 2],
  ["flowParticleSide", 0, true],
  ["flowLifetime", 2],
  ["flowStreakLength", 4],
  ["flowSpeedStretch", 2],
  ["flowWidth", 2],
  ["flowHalo", 2],
  ["flowHaloGain", 3],
  ["flowTailPower", 2],
  ["flowHeadBoost", 2],
  ["flowOpacity", 4],
  ["flowTrailHalfLife", 2],
  ["flowTrailDiffusion", 3],
  ["flowEmission", 2],
  ["flowCompositeOpacity", 2],
  ["flowInkScale", 1],
  ["flowInkDecay", 2],
  ["flowInkInjection", 2],
  ["flowInkDiffusion", 3],
  ["flowInkThroughFade", 2],
  ["flowInkContrast", 2],
  ["flowInkOpacity", 2],
  ["flowVolumeGrid", 0, true],
  ["flowVolumeSteps", 0, true],
  ["flowVolumeNoiseScale", 2],
  ["flowVolumeNoiseOctaves", 0, true],
  ["flowVolumeLacunarity", 2],
  ["flowVolumePersistence", 2],
  ["flowVolumeNoiseContrast", 2],
  ["flowVolumeDecay", 2],
  ["flowVolumeInjection", 2],
  ["flowVolumeDiffusion", 3],
  ["flowVolumeCorrection", 2],
  ["flowVolumeSignalGain", 2],
  ["flowVolumeSignalPow", 2],
  ["flowVolumeThreshold", 2],
  ["flowVolumeSoftness", 2],
  ["flowVolumeExtinction", 2],
  ["flowVolumeEmission", 2],
  ["flowVolumeOpacity", 2],
  ["flowVolumeDitherAmount", 2],
  ["flowVolumeDitherScale", 1],
  ["flowVolumeDitherRate", 2],
  ["flowVolumeDitherCoverage", 2],
  ["flowVolumeRayJitter", 2],
  ["timeScale", 3],
  ["simTime", 2],
  ["steps", 0, true],
  ["density", 2],
  ["opacityPow", 2],
  ["emission", 2],
  ["exposure", 2],
  ["fov", 1],
  ["lightAz", 1],
  ["lightEl", 1],
  ["lightGain", 2],
  ["hgG", 2],
  ["shadowSteps", 0, true],
  ["shadowDensity", 1],
  ["octaves", 0, true],
  ["octaveGain", 2],
  ["octaveExt", 2],
  ["ambientGain", 2],
  ["ambientDirs", 0, true],
  ["ambientRadius", 2],
  ["ambientDensity", 1],
  ["midaGamma", 2],
  ["isoLevel", 3],
  ["isoCount", 0, true],
  ["isoSpacing", 2],
  ["isoAlpha", 2],
  ["isoEmission", 2],
  ["isoRim", 2],
  ["isoAmbient", 2],
  ["shadeDiffuse", 2],
  ["shadeSpec", 2],
  ["shadeRough", 2],
  ["shadeF0", 3],
  ["shadeConf", 2],
  ["gradDelta", 4],
  ["maxBounces", 0, true],
  ["albedo", 2],
  ["scatterTint", 2],
  ["sppFrame", 0, true],
  ["aperture", 3],
  ["focus", 2],
  ["ptEnvGain", 2],
  ["eikSteps", 0, true],
  ["iorScale", 3],
  ["eikPow", 2],
  ["eikLogK", 1],
  ["absorb", 2],
  ["eikEmission", 2],
  ["dispersion", 3],
  ["eikEnvGain", 2],
  ["eikGradDelta", 4],
];

// URL aliases that differ from the param name (backward compatibility).
export const NUM_ALIASES: Partial<Record<NumKey, string>> = {
  phaseChromaPow: "chromaPow",
  renderScale: "scale",
  simTime: "t",
};

// ---------------------------------------------------------------------------
// Custom-ramp codec: rampStops=hex@pos,hex@pos,…  (hex without '#').
// ---------------------------------------------------------------------------
export function encodeRampStops(stops: RampStop[]): string {
  return stops
    .map((s) => `${s.hex.replace("#", "")}@${+s.pos.toFixed(3)}`)
    .join(",");
}

export function decodeRampStops(spec: string): RampStop[] | null {
  const stops: RampStop[] = [];
  for (const part of spec.split(",")) {
    const m = /^([0-9a-f]{6})@(-?[\d.]+)$/i.exec(part.trim());
    if (!m) return null;
    stops.push({ hex: `#${m[1].toLowerCase()}`, pos: Math.max(0, Math.min(1, +m[2])) });
  }
  if (stops.length < 2 || stops.length > 8) return null;
  stops.sort((a, b) => a.pos - b.pos);
  return stops;
}

/** Apply ?key=value overrides. Unknown keys are ignored. */
export function applyUrlOverrides(p: Params, search: string, nMax: number) {
  const q = new URLSearchParams(search);
  const num = (k: string, set: (v: number) => void) => {
    const v = q.get(k);
    if (v !== null && Number.isFinite(+v)) set(+v);
  };
  const str = <T extends string>(k: string, allowed: readonly T[], set: (v: T) => void) => {
    const v = q.get(k);
    if (v !== null && (allowed as readonly string[]).includes(v)) set(v as T);
  };

  const state = q.get("state")?.split(",").map(Number);
  if (state?.length === 3 && state.every(Number.isFinite))
    [p.n, p.l, p.m] = state;
  str("view", ["slice", "volume"], (v) => (p.view = v));
  str("mode", ["real", "complex"], (v) => {
    p.mode = v;
  });
  // Default the color to the resolved mode (ramp for real, phase for complex —
  // matching export/Program.cs) BEFORE applying an explicit ?color, so a link
  // that names only the mode reproduces the CLI's picture rather than inheriting
  // a stale default. An explicit ?color always wins.
  p.color = p.mode === "real" ? "ramp" : "phase";
  str("color", COLOR_NAMES, (v) => (p.color = v));
  str("value", ["density", "amplitude"], (v) => (p.value = v));
  str("compress", ["off", "log", "asinh"], (v) => (p.compress = v));
  if (q.get("ramp")) p.ramp = q.get("ramp")!;
  str("rampSpace", ["oklab", "srgb"], (v) => (p.rampSpace = v));
  if (q.get("vivid") === "0") p.phaseVivid = false;
  if (q.get("dither") === "0") p.dither = false;
  if (q.get("autoQuality") === "0") p.autoQuality = false;
  if (q.get("okSigned") === "1") p.okPhaseSigned = true;
  if (q.get("axes") === "1") p.axes = true;
  if (q.get("axesGizmo") === "1") p.axesGizmo = true;
  if (q.get("flow") === "1") p.flowEnabled = true;
  if (q.get("flowRun") === "0") p.flowRun = false;
  if (q.get("flowReverse") === "1") p.flowReverse = true;
  if (q.get("flowSeedClips") === "0") p.flowSeedInsideClips = false;
  if (q.get("flowClip") === "0") p.flowClipVisible = false;
  if (q.get("flowLegend") === "0") p.flowLegend = false;
  if (q.get("post") === "1") p.postEnabled = true;
  if (q.get("bloom") === "0") p.bloomEnabled = false;
  if (q.get("vignette") === "1") p.vignetteEnabled = true;
  if (q.get("grain") === "1") p.grainEnabled = true;
  if (q.get("grainColor") === "1") p.grainColored = true;
  str("bloomComposite", BLOOM_COMPOSITES, (v) => (p.bloomComposite = v));
  const bloomTint = q.get("bloomTint");
  if (bloomTint && /^[0-9a-f]{6}$/i.test(bloomTint))
    p.bloomTint = `#${bloomTint.toLowerCase()}`;

  const rampStops = q.get("rampStops");
  if (rampStops) {
    const stops = decodeRampStops(rampStops);
    if (stops) p.rampStops = stops;
  }

  const terms = q.get("terms");
  if (terms) p.terms = decodeTerms(terms, nMax);
  if (q.get("normalize") === "0") p.superNormalize = false;
  if (q.get("time") === "1") p.timeRun = true;

  str("plane", ["xz", "xy", "yz", "custom"], (v) => (p.slicePlane = v));
  num("az", (v) => (p.sliceAz = wrapDeg(v)));
  num("el", (v) => (p.sliceEl = Math.max(-89, Math.min(89, v))));
  num("roll", (v) => (p.sliceRoll = wrapDeg(v)));
  num("offset", (v) => (p.sliceOffset = v));
  num("zoom", (v) => (p.sliceZoom = v));

  str("integrator", TECHNIQUES, (v) => (p.technique = v));
  str("tonemap", ["gamma", "agx"], (v) => (p.tonemap = v));
  str("shadeModel", SHADE_MODELS, (v) => (p.shadeModel = v));
  str("ptEnv", ENVS, (v) => (p.ptEnv = v));
  str("eikEnv", ENVS, (v) => (p.eikEnv = v));
  str("eikMap", ["pow", "log"], (v) => (p.eikMap = v));
  str("flowMethod", FLOW_METHODS, (v) => (p.flowMethod = v));
  str("flowColor", FLOW_COLORS, (v) => (p.flowColor = v));
  str("flowSeed", FLOW_SEEDS, (v) => (p.flowSeed = v));
  str("flowDerivative", FLOW_DERIVATIVES, (v) => (p.flowDerivative = v));
  str("flowIntegrator", FLOW_INTEGRATORS, (v) => (p.flowIntegrator = v));
  str("flowComposite", FLOW_COMPOSITES, (v) => (p.flowComposite = v));

  for (const [key, , integer] of NUM_KEYS)
    num(NUM_ALIASES[key] ?? key, (v) => {
      (p as Record<NumKey, number>)[key] = integer ? Math.round(v) : v;
    });

  // clip=axis,offset[,flip[,camLock]] — repeatable (first → clip A, …).
  q.getAll("clip").forEach((spec, i) => {
    if (i >= 2) return;
    const [axis, offset, flip, camLock] = spec.split(",");
    if (axis === "forward" || axis === "right" || axis === "up")
      p.clips[i] = {
        enabled: true,
        axis,
        offset: Number.isFinite(+offset) ? +offset : 0,
        flip: flip === "1",
        camLock: camLock === "1",
      };
  });
}

/** What buildQuery needs to know about the live camera. */
export interface UrlCameraState {
  isOrbit: boolean;
  azDeg: number;
  elDeg: number;
  dist: number;
}

/** Phase-wheel defaults from palettes.json — phaseL/C/H0 reach the URL only
 * when they differ from these (NaN params mean "palette default"). */
export interface PhaseDefaults {
  L: number;
  C: number;
  h0Deg: number;
}

/** Serialize the current view as a query string (no leading '?'). Writes only
 * values that differ from the defaults, gated to parameter groups the active
 * view/technique reads. */
export function buildQuery(
  p: Params,
  cam: UrlCameraState,
  phaseDefaults: PhaseDefaults,
): string {
  const d = defaultParams();
  const t = p.technique;
  const iso = t === "iso" || t === "isolegacy";   // share the isosurface group
  const vol = p.view === "volume";
  const volumeFlow = (FLOW_VOLUME_METHODS as readonly string[]).includes(p.flowMethod);
  const particleFlow = p.flowMethod !== "ink" && !volumeFlow;
  const q = new URLSearchParams();
  const r = (v: number, digits = 3) => +v.toFixed(digits);

  if (p.n !== d.n || p.l !== d.l || p.m !== d.m)
    q.set("state", `${p.n},${p.l},${p.m}`);
  if (p.terms.length > 0) {
    q.set("terms", encodeTerms(p.terms));
    if (!p.superNormalize) q.set("normalize", "0");
  }
  if (p.timeRun) q.set("time", "1");
  if (p.view !== d.view) q.set("view", p.view);
  if (p.mode !== d.mode) q.set("mode", p.mode);
  // color is implied by mode (real→ramp, complex→phase) unless changed.
  if (p.color !== (p.mode === "real" ? "ramp" : "phase")) q.set("color", p.color);
  if (p.color === "okphase" && p.okPhaseSigned) q.set("okSigned", "1");
  if (p.value !== d.value) q.set("value", p.value);
  if (p.compress !== d.compress) q.set("compress", p.compress);
  if (p.ramp !== d.ramp) q.set("ramp", p.ramp);
  if (p.ramp === "custom") q.set("rampStops", encodeRampStops(p.rampStops));
  if (p.rampSpace !== d.rampSpace) q.set("rampSpace", p.rampSpace);
  if (!p.phaseVivid) q.set("vivid", "0");
  if (!p.dither) q.set("dither", "0");
  if (!p.autoQuality) q.set("autoQuality", "0");
  if (p.postEnabled) {
    q.set("post", "1");
    if (!p.bloomEnabled) q.set("bloom", "0");
    if (p.bloomComposite !== d.bloomComposite)
      q.set("bloomComposite", p.bloomComposite);
    if (p.bloomTint.toLowerCase() !== d.bloomTint)
      q.set("bloomTint", p.bloomTint.replace("#", "").toLowerCase());
    if (p.vignetteEnabled) q.set("vignette", "1");
    if (p.grainEnabled) q.set("grain", "1");
    if (p.grainEnabled && p.grainColored) q.set("grainColor", "1");
  }
  if (p.flowEnabled) {
    q.set("flow", "1");
    if (p.flowMethod !== d.flowMethod) q.set("flowMethod", p.flowMethod);
    if (p.flowColor !== d.flowColor) q.set("flowColor", p.flowColor);
    if (p.flowSeed !== d.flowSeed) q.set("flowSeed", p.flowSeed);
    if (p.flowDerivative !== d.flowDerivative)
      q.set("flowDerivative", p.flowDerivative);
    if (p.flowIntegrator !== d.flowIntegrator)
      q.set("flowIntegrator", p.flowIntegrator);
    if (p.flowMethod !== "ink" && p.flowComposite !== d.flowComposite)
      q.set("flowComposite", p.flowComposite);
    if (!p.flowRun) q.set("flowRun", "0");
    if (p.flowReverse) q.set("flowReverse", "1");
    if (p.flowMethod !== "ink" && !p.flowSeedInsideClips) q.set("flowSeedClips", "0");
    if (particleFlow && !p.flowClipVisible) q.set("flowClip", "0");
    if (!p.flowLegend) q.set("flowLegend", "0");
  }

  // Numeric params, gated to the groups the current view/technique actually
  // reads (see the shader headers for ownership).
  const phaseColorActive = p.color === "phase"
    || (p.flowEnabled && p.flowColor === "phase");
  const groups: [NumKey[], boolean][] = [
    [["gamma", "renderScale", "captureScale", "captureSpp", "captureFlowFrames",
      "compressWhite"], true],
    [["postExposure", "postContrast", "postSaturation", "postVibrance",
      "postAberration"], p.postEnabled],
    [["postAberrationFalloff"], p.postEnabled && p.postAberration > 0],
    [["bloomThreshold", "bloomKnee", "bloomIntensity", "bloomRadius",
      "bloomIterations", "bloomScale", "bloomSaturation"],
      p.postEnabled && p.bloomEnabled],
    [["vignetteAmount", "vignetteRadius", "vignetteSoftness",
      "vignetteRoundness", "vignetteCenterX", "vignetteCenterY"],
      p.postEnabled && p.vignetteEnabled],
    [["grainAmount", "grainScale", "grainSpeed"],
      p.postEnabled && p.grainEnabled],
    [["flowDelta", "flowNodeEps", "flowTimeScale", "flowMaxSpeed",
      "flowSeedPower", "flowResetNonce", "flowBase", "flowColorFloor",
      "flowDensityGate"], p.flowEnabled],
    [["flowColorGain"], p.flowEnabled && p.flowColor !== "palette-material"],
    [["flowSubsteps"], p.flowEnabled && p.flowMethod !== "ink"],
    [["flowSpawnTries"], p.flowEnabled && particleFlow],
    [["flowParticleSide", "flowLifetime", "flowStreakLength", "flowSpeedStretch",
      "flowWidth", "flowHalo", "flowHaloGain", "flowTailPower", "flowHeadBoost",
      "flowOpacity", "flowTrailHalfLife", "flowTrailDiffusion", "flowEmission",
      "flowCompositeOpacity"], p.flowEnabled && particleFlow],
    [["flowInkScale", "flowInkDecay", "flowInkInjection", "flowInkDiffusion",
      "flowInkThroughFade", "flowInkContrast", "flowInkOpacity"],
      p.flowEnabled && p.flowMethod === "ink"],
    [["flowVolumeGrid", "flowVolumeSteps", "flowVolumeNoiseScale",
      "flowVolumeNoiseOctaves", "flowVolumeLacunarity", "flowVolumePersistence",
      "flowVolumeNoiseContrast", "flowVolumeDecay",
      "flowVolumeInjection", "flowVolumeDiffusion", "flowVolumeCorrection",
      "flowVolumeSignalGain",
      "flowVolumeSignalPow", "flowVolumeThreshold", "flowVolumeSoftness",
      "flowVolumeExtinction",
      "flowVolumeEmission", "flowVolumeOpacity", "flowVolumeDitherAmount",
      "flowVolumeDitherScale", "flowVolumeDitherRate", "flowVolumeDitherCoverage",
      "flowVolumeRayJitter"], p.flowEnabled && volumeFlow],
    [["phaseChromaPow"], phaseColorActive],
    [["timeScale"], p.timeRun || p.simTime !== 0],
    // simTime is meaningful frozen: written only when time is NOT running
    // (a shared link then reproduces the exact frame).
    [["simTime"], !p.timeRun && p.simTime !== 0],
    [["compressK"], p.compress !== "off"],
    [["steps"], vol && t !== "pathtrace" && t !== "eikonal"],
    [["density", "opacityPow", "emission"], vol && t !== "mip" && !iso && t !== "eikonal"],
    [["exposure", "fov"], vol],
    [["lightAz", "lightEl"], vol && (iso || t === "scatter" || t === "pathtrace"
      || (t === "ea" && p.shadeModel !== "off"))],
    [["lightGain"], vol && (t === "scatter" || t === "pathtrace"
      || (p.shadeModel !== "off" && (t === "ea" || t === "isolegacy"
        || (t === "iso" && ["blinn", "ggx"].includes(p.shadeModel)))))],
    [["hgG"], vol && (t === "scatter" || t === "pathtrace")],
    [["shadowSteps", "shadowDensity", "octaves", "octaveGain", "octaveExt"],
      vol && (t === "scatter" || (iso && p.shadeModel !== "off"))],
    [["ambientGain", "ambientDirs", "ambientRadius", "ambientDensity"],
      vol && t === "scatter"],
    [["midaGamma"], vol && t === "mida"],
    [["isoLevel", "isoCount", "isoSpacing", "isoAlpha", "isoEmission", "isoRim"],
      vol && iso],
    [["isoAmbient"], vol && t === "iso"],
    [["shadeDiffuse"], vol && p.shadeModel !== "off"
      && (["ea", "scatter", "isolegacy"] as string[]).includes(t)],
    [["shadeSpec", "shadeRough", "shadeF0"], vol
      && (p.shadeModel === "blinn" || p.shadeModel === "ggx")
      && (iso || t === "ea" || t === "scatter")],
    [["shadeConf"], vol && p.shadeModel !== "off" && (t === "ea" || t === "scatter")],
    [["gradDelta"], vol && (iso
      || (p.shadeModel !== "off" && (t === "ea" || t === "scatter")))],
    [["maxBounces", "albedo", "scatterTint", "sppFrame", "aperture", "focus", "ptEnvGain"],
      vol && t === "pathtrace"],
    [["eikSteps", "iorScale", "eikPow", "eikLogK", "absorb", "eikEmission",
      "dispersion", "eikEnvGain", "eikGradDelta"],
      vol && t === "eikonal"],
  ];
  const active = new Set<NumKey>();
  for (const [keys, cond] of groups) if (cond) keys.forEach((k) => active.add(k));
  for (const [key, digits] of NUM_KEYS) {
    if (!active.has(key) || Number.isNaN(p[key])) continue;
    if (p[key] !== d[key])
      q.set(NUM_ALIASES[key] ?? key, `${r(p[key], digits)}`);
  }

  // Phase-wheel overrides: bespoke defaults (palettes.json, not defaultParams).
  // Lightness/chroma apply to the phase wheel only; the hue-zero offset also
  // steers okphase's rotation, so it rides along for that mode too.
  if (phaseColorActive) {
    if (!Number.isNaN(p.phaseL) && r(p.phaseL) !== r(phaseDefaults.L))
      q.set("phaseL", `${r(p.phaseL)}`);
    if (!Number.isNaN(p.phaseC) && r(p.phaseC) !== r(phaseDefaults.C))
      q.set("phaseC", `${r(p.phaseC)}`);
  }
  if (phaseColorActive || p.color === "okphase") {
    if (!Number.isNaN(p.phaseH0Deg) && r(p.phaseH0Deg, 1) !== r(phaseDefaults.h0Deg, 1))
      q.set("phaseH0Deg", `${r(p.phaseH0Deg, 1)}`);
  }

  if (!vol) {
    if (p.slicePlane !== d.slicePlane) q.set("plane", p.slicePlane);
    if (p.slicePlane === "custom") {
      q.set("az", `${r(p.sliceAz, 1)}`);
      q.set("el", `${r(p.sliceEl, 1)}`);
      if (p.sliceRoll !== 0) q.set("roll", `${r(p.sliceRoll, 1)}`);
    }
    if (p.sliceOffset !== 0) q.set("offset", `${r(p.sliceOffset)}`);
    if (p.sliceZoom !== 1) q.set("zoom", `${r(p.sliceZoom, 2)}`);
  } else {
    if (t !== d.technique) q.set("integrator", t);
    if (p.axes) q.set("axes", "1");
    if (p.axes && p.axesGizmo) q.set("axesGizmo", "1");
    if (p.tonemap !== d.tonemap) q.set("tonemap", p.tonemap);
    if (p.shadeModel !== d.shadeModel && (iso || ["ea", "scatter"].includes(t)))
      q.set("shadeModel", p.shadeModel);
    if (t === "pathtrace" && p.ptEnv !== d.ptEnv) q.set("ptEnv", p.ptEnv);
    if (t === "eikonal") {
      if (p.eikEnv !== d.eikEnv) q.set("eikEnv", p.eikEnv);
      if (p.eikMap !== d.eikMap) q.set("eikMap", p.eikMap);
    }
    // Camera: only the orbit pose has a URL form (fly is transient).
    if (cam.isOrbit) {
      const az = r(wrapDeg(cam.azDeg), 1), el = r(cam.elDeg, 1), dist = r(cam.dist, 2);
      if (az !== 35 || el !== 25 || dist !== 2.6)
        q.set("camera", `${az},${el},${dist}`);
    }
    for (const c of p.clips) {
      if (!c.enabled) continue;
      let spec = `${c.axis},${r(c.offset)}`;
      if (c.flip || c.camLock) spec += `,${c.flip ? 1 : 0}`;
      if (c.camLock) spec += ",1";
      q.append("clip", spec);
    }
  }
  // Commas/semicolons/@ are query-safe; keep them readable (?state=4,2,1 —
  // the documented style) instead of URLSearchParams' escapes.
  return q
    .toString()
    .replace(/%2C/gi, ",")
    .replace(/%3B/gi, ";")
    .replace(/%40/gi, "@")
    .replace(/%23/gi, "");
}
