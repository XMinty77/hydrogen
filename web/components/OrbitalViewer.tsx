"use client";

// =============================================================================
// OrbitalViewer.tsx — the interactive demo: one fullscreen WebGL2 canvas, a
// lil-gui control panel, and a render loop over the shared GLSL renderer.
//
// Layers (each documented in its own module):
//   lib/horb.ts      — baked-asset reader (tables + display stats)
//   lib/palettes.ts  — palette definitions
//   lib/renderer.ts  — shader assembly + uniform upload (the C# host's twin)
//   lib/cameras.ts   — orbit + fly cameras (CLI-compatible conventions)
//
// This file owns what remains: UI state, its mapping to render parameters
// (slice-plane construction, camera-locked clip planes), input handling, the
// requestAnimationFrame loop, and — for the path tracer — deciding when the
// progressive accumulation must restart (any change to a parameter the image
// depends on).
//
// Rendering techniques (iteration 5): the single `technique` selector spans
// three shader programs — mip/ea/scatter/mida/iso run volume.frag,
// pathtrace runs the progressive Monte Carlo pipeline, eikonal the
// refraction renderer. Every parameter of every technique is exposed in the
// GUI (this round is explicitly for experimentation) and mirrored in the URL.
//
// URL parameters mirror the offline CLI (?state=4,2,1&view=volume&mode=complex
// &camera=35,25,2.6&size=1024 …) so any view is shareable/scriptable — the
// screenshot harness (scripts/shot.mjs) drives the app through them and waits
// for window.__renderReady. For the path tracer, shot mode keeps accumulating
// until ?spp=N samples before flagging ready.
// =============================================================================

import GUI from "lil-gui";
import { useEffect, useRef } from "react";
import { CameraRig, type CameraPose } from "../lib/cameras";
import { framingRadius, loadHorb } from "../lib/horb";
import { loadPalettes } from "../lib/palettes";
import {
  OrbitalRenderer,
  type CameraParams,
  type CommonParams,
  type LightParams,
  type ShadeParams,
} from "../lib/renderer";
import { cross, norm, scale, type Vec3 } from "../lib/vec3";

const DEG = Math.PI / 180;

type ClipAxis = "forward" | "right" | "up";

interface ClipParams {
  enabled: boolean;
  axis: ClipAxis;
  /** Plane offset from the origin along the axis, in framing radii. */
  offset: number;
  /** Keep the near side instead of the far side. */
  flip: boolean;
  /** Follow the live camera (the axis re-orients every frame) instead of
   * staying fixed at the initial camera's axes (the default — user decision
   * 2026-07-19: a cut that rides the camera disorients while orbiting). */
  camLock: boolean;
}

const TECHNIQUES = ["mip", "ea", "scatter", "mida", "iso", "pathtrace", "eikonal"] as const;
type Technique = (typeof TECHNIQUES)[number];

const ENVS = ["black", "uniform", "studio", "hue", "checker"] as const;
type EnvName = (typeof ENVS)[number];

const SHADE_MODELS = ["off", "lambert", "blinn", "ggx"] as const;
type ShadeModel = (typeof SHADE_MODELS)[number];

/** The full UI state. Defaults reproduce the offline CLI's defaults so web
 * and stills start from the same picture; per-technique defaults are this
 * iteration's tuned starting points. */
function defaultParams() {
  return {
    view: "volume" as "slice" | "volume",
    n: 4,
    l: 2,
    m: 1,
    mode: "complex" as "real" | "complex",
    color: "signed" as "ramp" | "signed" | "phase",
    value: "density" as "density" | "amplitude",
    gamma: 0.71,
    /** Extra range compression before gamma (esp. for MIDA): see common.glsl. */
    compress: "off" as "off" | "log" | "asinh",
    compressK: 20,
    dither: true,
    ramp: "accretion_tuned",
    rampSpace: "oklab" as "oklab" | "srgb",
    phaseVivid: true,
    phaseChromaPow: 0.6,
    /** Canvas backing-store scale relative to CSS pixels × devicePixelRatio. */
    renderScale: 0.25,

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

    // Volume — shared by the raymarched techniques. EA defaults are the
    // user-tuned values of 2026-07-19 and are untouched by this iteration.
    technique: "ea" as Technique,
    steps: 64,
    density: 5,
    opacityPow: 2.15,
    emission: 6.7,
    tonemap: "gamma" as "gamma" | "agx",
    exposure: 0,
    fov: 40,

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

    // Eikonal refraction (technique "eikonal"). Tuned 2026-07-19: studio env
    // + gentle log map reads as an opalescent gem; the split at the equator
    // is the (4,2,1) node plane (n → 1 there) — real physics, keep it.
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
type Params = ReturnType<typeof defaultParams>;

const COLOR_MODE = { ramp: 0, signed: 1, phase: 2 } as const;
const INTEGRATOR = { mip: 0, ea: 1, scatter: 2, mida: 3, iso: 4 } as const;
const TONEMAP = { gamma: 0, agx: 1 } as const;
const COMPRESS = { off: 0, log: 1, asinh: 2 } as const;
const ENV_MODE = { black: 0, uniform: 1, studio: 2, hue: 3, checker: 4 } as const;
const SHADE_MODEL = { off: 0, lambert: 1, blinn: 2, ggx: 3 } as const;

// ---------------------------------------------------------------------------
// URL vocabulary. Bespoke keys (state, camera, clip, slice geometry) keep
// their historical handling; everything added by iteration 5 goes through
// these tables — one row per parameter: [key, round-digits, integer?].
// The same tables drive both parsing and writeback, so they cannot drift.
// ---------------------------------------------------------------------------
type NumKey = {
  [K in keyof Params]: Params[K] extends number ? K : never;
}[keyof Params];

const NUM_KEYS: [NumKey, number, boolean?][] = [
  ["gamma", 3],
  ["compressK", 1],
  ["phaseChromaPow", 3],
  ["renderScale", 3],
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
const NUM_ALIASES: Partial<Record<NumKey, string>> = {
  phaseChromaPow: "chromaPow",
  renderScale: "scale",
};

/** Apply ?key=value overrides (see file header). Unknown keys are ignored. */
function applyUrlOverrides(p: Params, search: string) {
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
  str("color", ["ramp", "signed", "phase"], (v) => (p.color = v));
  str("value", ["density", "amplitude"], (v) => (p.value = v));
  str("compress", ["off", "log", "asinh"], (v) => (p.compress = v));
  if (q.get("ramp")) p.ramp = q.get("ramp")!;
  str("rampSpace", ["oklab", "srgb"], (v) => (p.rampSpace = v));
  if (q.get("vivid") === "0") p.phaseVivid = false;
  if (q.get("dither") === "0") p.dither = false;

  str("plane", ["xz", "xy", "yz", "custom"], (v) => (p.slicePlane = v));
  num("az", (v) => (p.sliceAz = v));
  num("el", (v) => (p.sliceEl = v));
  num("roll", (v) => (p.sliceRoll = v));
  num("offset", (v) => (p.sliceOffset = v));
  num("zoom", (v) => (p.sliceZoom = v));

  str("integrator", TECHNIQUES, (v) => (p.technique = v));
  str("tonemap", ["gamma", "agx"], (v) => (p.tonemap = v));
  str("shadeModel", SHADE_MODELS, (v) => (p.shadeModel = v));
  str("ptEnv", ENVS, (v) => (p.ptEnv = v));
  str("eikEnv", ENVS, (v) => (p.eikEnv = v));
  str("eikMap", ["pow", "log"], (v) => (p.eikMap = v));

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

/** Slice-plane geometry. Presets replicate export/Program.cs verbatim (so web
 * and CLI slices are directly comparable); "custom" builds the plane from an
 * (azimuth, elevation) normal, an in-plane roll, and a normal offset. */
function slicePlaneVectors(p: Params, framing: number) {
  const ext = framing / p.sliceZoom;
  const off = p.sliceOffset * framing;
  switch (p.slicePlane) {
    case "xz":
      return { origin: [0, off, 0], axisU: [ext, 0, 0], axisV: [0, 0, ext] } as
        { origin: Vec3; axisU: Vec3; axisV: Vec3 };
    case "xy":
      return { origin: [0, 0, off] as Vec3, axisU: [ext, 0, 0] as Vec3, axisV: [0, ext, 0] as Vec3 };
    case "yz":
      return { origin: [off, 0, 0] as Vec3, axisU: [0, ext, 0] as Vec3, axisV: [0, 0, ext] as Vec3 };
    case "custom": {
      const az = p.sliceAz * DEG;
      const el = p.sliceEl * DEG;
      const n: Vec3 = [
        Math.cos(el) * Math.cos(az),
        Math.cos(el) * Math.sin(az),
        Math.sin(el),
      ];
      // In-plane frame: reference-projected axes (z-reference, x fallback near
      // the poles), chosen so custom(az=90°, el=0°, roll=0°) ≡ the xz preset.
      const ref: Vec3 = Math.abs(n[2]) > 0.99 ? [1, 0, 0] : [0, 0, 1];
      const u0 = norm(cross(n, ref));
      const v0 = cross(u0, n);
      const cr = Math.cos(p.sliceRoll * DEG);
      const sr = Math.sin(p.sliceRoll * DEG);
      return {
        origin: scale(n, off),
        axisU: scale(
          [u0[0] * cr + v0[0] * sr, u0[1] * cr + v0[1] * sr, u0[2] * cr + v0[2] * sr],
          ext,
        ) as Vec3,
        axisV: scale(
          [v0[0] * cr - u0[0] * sr, v0[1] * cr - u0[1] * sr, v0[2] * cr - u0[2] * sr],
          ext,
        ) as Vec3,
      };
    }
  }
}

/** Clip planes: each active clip keeps the half-space dot(axis, p) ≥
 * offset·framing (or ≤, when flipped), where axis is a basis vector of a
 * camera pose — the *initial* camera's by default (a world-fixed cut you can
 * orbit around to inspect), or the live camera's when camLock is on (the cut
 * rides with the view, carving a viewer-facing cutaway). */
function clipPlaneVectors(
  clips: [ClipParams, ClipParams],
  livePose: CameraPose,
  basePose: CameraPose,
  framing: number,
): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const c of clips) {
    if (!c.enabled) continue;
    const pose = c.camLock ? livePose : basePose;
    const axis = c.axis === "forward" ? pose.fwd : c.axis === "right" ? pose.right : pose.up;
    const s = c.flip ? -1 : 1;
    out.push([s * axis[0], s * axis[1], s * axis[2], -s * c.offset * framing]);
  }
  return out;
}

/** Seed the custom-plane orientation from a preset (used when a drag begins
 * on a preset slice: the drag continues from the preset's orientation). */
function seedCustomFromPreset(p: Params) {
  if (p.slicePlane === "custom") return;
  [p.sliceAz, p.sliceEl] =
    p.slicePlane === "xz" ? [90, 0] : p.slicePlane === "yz" ? [0, 0] : [0, 89];
  p.sliceRoll = 0;
  p.slicePlane = "custom";
}

export default function OrbitalViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const statsEl = statsRef.current!;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const on = <K extends keyof WindowEventMap>(
      target: Window | Document | HTMLElement,
      type: string,
      fn: (e: any) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => target.removeEventListener(type, fn));
    };

    (async () => {
      const params = defaultParams();
      applyUrlOverrides(params, location.search);
      const q = new URLSearchParams(location.search);
      const fixedSize = q.get("size") ? Math.max(16, +q.get("size")!) : null;
      const camOverride = q.get("camera")?.split(",").map(Number);
      /** Shot mode: path-traced frames accumulate to this many samples per
       * pixel before the harness is told the render is ready. */
      const sppTarget = q.get("spp") ? Math.max(1, +q.get("spp")!) : 32;

      const gl = canvas.getContext("webgl2", {
        antialias: false, // shader output is already dithered; MSAA is useless
        preserveDrawingBuffer: true, // screenshot harness reads the canvas
      });
      if (!gl) {
        statsEl.textContent = "WebGL2 unavailable in this browser.";
        return;
      }

      const [asset, palettes] = await Promise.all([
        loadHorb("generated/orbitals.bin"),
        loadPalettes("generated/palettes.json"),
      ]);
      const renderer = await OrbitalRenderer.create(gl, asset, palettes, "generated/shaders");
      if (disposed) return;

      const rig = new CameraRig();
      if (camOverride?.length === 3 && camOverride.every(Number.isFinite))
        [rig.azDeg, rig.elDeg, rig.dist] = camOverride;
      // Frozen copy of the starting camera's axes: the reference frame for
      // non-camLocked clip planes (framing factor is irrelevant — only the
      // basis directions are used).
      const basePose = rig.pose(1);

      // ----------------------------------------------------------------- GUI
      const gui = new GUI({ title: "hydrogen" });
      cleanups.push(() => gui.destroy());

      const fState = gui.addFolder("state");
      const nC = fState.add(params, "n", 1, asset.nMax, 1);
      const lC = fState.add(params, "l", 0, asset.nMax - 1, 1);
      const mC = fState.add(params, "m", -(asset.nMax - 1), asset.nMax - 1, 1);
      const clampState = () => {
        params.l = Math.min(params.l, params.n - 1);
        params.m = Math.max(-params.l, Math.min(params.l, params.m));
        lC.max(params.n - 1);
        mC.min(-params.l).max(params.l);
        [nC, lC, mC].forEach((c) => c.updateDisplay());
      };
      nC.onChange(clampState);
      lC.onChange(clampState);
      mC.onChange(clampState);
      clampState();
      fState
        .add(params, "mode", ["real", "complex"])
        .onChange((v: string) => {
          // Keep the conventional pairing; the color control stays free after.
          params.color = v === "real" ? "ramp" : "phase";
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
        });

      gui.add(params, "view", ["slice", "volume"]).onChange(syncFolders);

      const fDisplay = gui.addFolder("display");
      fDisplay.add(params, "color", ["ramp", "signed", "phase"]);
      fDisplay.add(params, "value", ["density", "amplitude"]);
      fDisplay.add(params, "gamma", 0.2, 1, 0.01);
      fDisplay.add(params, "compress", ["off", "log", "asinh"]);
      fDisplay.add(params, "compressK", 1, 500, 1);
      fDisplay.add(params, "dither");
      fDisplay.add(params, "renderScale", 0.25, 1.5, 0.05);

      const fPalette = gui.addFolder("palette").close();
      fPalette.add(params, "ramp", Object.keys(palettes.ramps));
      fPalette.add(params, "rampSpace", ["oklab", "srgb"]);
      fPalette.add(params, "phaseVivid");
      fPalette.add(params, "phaseChromaPow", 0, 1, 0.01);

      const fSlice = gui.addFolder("slice plane");
      fSlice.add(params, "slicePlane", ["xz", "xy", "yz", "custom"]).listen();
      fSlice.add(params, "sliceAz", -180, 180, 0.1).listen();
      fSlice.add(params, "sliceEl", -89, 89, 0.1).listen();
      fSlice.add(params, "sliceRoll", -180, 180, 0.1);
      fSlice.add(params, "sliceOffset", -1, 1, 0.005);
      fSlice.add(params, "sliceZoom", 0.5, 20, 0.01).listen();

      const fVolume = gui.addFolder("volume");
      fVolume.add(params, "technique", TECHNIQUES as unknown as string[]).onChange(syncFolders);
      fVolume.add(params, "steps", 64, 1200, 1);
      fVolume.add(params, "density", 1, 50, 0.5);
      fVolume.add(params, "opacityPow", 0.5, 4, 0.05);
      fVolume.add(params, "emission", 0, 20, 0.05);
      fVolume.add(params, "tonemap", ["gamma", "agx"]);
      fVolume.add(params, "exposure", -4, 4, 0.05);
      fVolume.add(params, "fov", 20, 90, 1);

      const fLight = gui.addFolder("key light");
      fLight.add(params, "lightAz", -180, 180, 1);
      fLight.add(params, "lightEl", -89, 89, 1);
      fLight.add(params, "lightGain", 0, 30, 0.1);
      fLight.add(params, "hgG", -0.9, 0.9, 0.01).name("anisotropy g");

      const fScatter = gui.addFolder("multi-scattering");
      fScatter.add(params, "shadowSteps", 4, 64, 1);
      fScatter.add(params, "shadowDensity", 0, 400, 1);
      fScatter.add(params, "octaves", 1, 6, 1);
      fScatter.add(params, "octaveGain", 0.1, 0.9, 0.01);
      fScatter.add(params, "octaveExt", 0.1, 0.9, 0.01);
      fScatter.add(params, "ambientGain", 0, 10, 0.1);
      fScatter.add(params, "ambientDirs", 1, 12, 1);
      fScatter.add(params, "ambientRadius", 0.05, 0.6, 0.01);
      fScatter.add(params, "ambientDensity", 0, 1000, 5);

      const fMida = gui.addFolder("mida");
      fMida.add(params, "midaGamma", -1, 1, 0.01).name("γ  (EA ← MIDA → MIP)");

      const fIso = gui.addFolder("isosurfaces");
      fIso.add(params, "isoLevel", 0.02, 0.98, 0.005).name("level (depth sweep)");
      fIso.add(params, "isoCount", 1, 6, 1);
      fIso.add(params, "isoSpacing", 0.2, 0.95, 0.01);
      fIso.add(params, "isoAlpha", 0.05, 1, 0.01);
      fIso.add(params, "isoEmission", 0, 10, 0.05);
      fIso.add(params, "isoRim", 0, 10, 0.05);

      const fShade = gui.addFolder("surface shading");
      fShade.add(params, "shadeModel", SHADE_MODELS as unknown as string[]);
      fShade.add(params, "shadeDiffuse", 0, 2, 0.01);
      fShade.add(params, "shadeSpec", 0, 10, 0.05);
      fShade.add(params, "shadeRough", 0.02, 1, 0.01);
      fShade.add(params, "shadeF0", 0, 0.5, 0.005);
      fShade.add(params, "shadeConf", 0, 10, 0.05).name("gradient confidence");
      fShade.add(params, "gradDelta", 0.0005, 0.02, 0.0005);

      const fPt = gui.addFolder("path tracer");
      fPt.add(params, "maxBounces", 0, 16, 1);
      fPt.add(params, "albedo", 0, 1, 0.01);
      fPt.add(params, "scatterTint", 0, 1, 0.01);
      fPt.add(params, "sppFrame", 1, 8, 1).name("samples / frame");
      fPt.add(params, "aperture", 0, 0.25, 0.001);
      fPt.add(params, "focus", 0.2, 6, 0.01);
      fPt.add(params, "ptEnv", ENVS as unknown as string[]).name("environment");
      fPt.add(params, "ptEnvGain", 0, 5, 0.05);

      const fEik = gui.addFolder("eikonal");
      fEik.add(params, "eikSteps", 64, 1200, 1).name("steps");
      fEik.add(params, "iorScale", 0, 1.5, 0.005).name("Δn (index scale)");
      fEik.add(params, "eikMap", ["pow", "log"]).name("density map");
      fEik.add(params, "eikPow", 0.1, 2, 0.01);
      fEik.add(params, "eikLogK", 1, 500, 1);
      fEik.add(params, "absorb", 0, 20, 0.05);
      fEik.add(params, "eikEmission", 0, 10, 0.05);
      fEik.add(params, "dispersion", 0, 0.2, 0.001);
      fEik.add(params, "eikEnv", ENVS as unknown as string[]).name("environment");
      fEik.add(params, "eikEnvGain", 0, 5, 0.05);
      fEik.add(params, "eikGradDelta", 0.0005, 0.02, 0.0005);

      const fCamera = gui.addFolder("camera");
      // Bound to a proxy, not rig.mode: lil-gui writes the bound property
      // *before* onChange, which would hide the old mode from setMode and
      // break the orbit→fly pose seeding.
      const camUi = { mode: rig.mode };
      fCamera
        .add(camUi, "mode", ["orbit", "fly"])
        .name("camera")
        .onChange((v: "orbit" | "fly") => rig.setMode(v, framing()));
      fCamera.add(rig, "azDeg", -180, 180, 0.1).listen();
      fCamera.add(rig, "elDeg", -89, 89, 0.1).listen();
      fCamera.add(rig, "dist", 1.05, 12, 0.01).listen();
      fCamera.add(rig, "flySpeed", 0.05, 3, 0.01);

      const clipFolder = (label: string, c: ClipParams) => {
        const f = gui.addFolder(label).close();
        f.add(c, "enabled");
        f.add(c, "axis", ["forward", "right", "up"]);
        f.add(c, "offset", -1.2, 1.2, 0.005);
        f.add(c, "flip");
        f.add(c, "camLock").name("lock to camera");
        return f;
      };
      const fClipA = clipFolder("clip plane A", params.clips[0]);
      const fClipB = clipFolder("clip plane B", params.clips[1]);

      /** Which auxiliary folders each technique needs. */
      function syncFolders() {
        const vol = params.view === "volume";
        const t = params.technique;
        const show = (f: GUI, cond: boolean) => (cond ? f.show() : f.hide());
        show(fSlice, !vol);
        show(fVolume, vol);
        show(fCamera, vol);
        show(fClipA, vol);
        show(fClipB, vol);
        show(fLight, vol && ["ea", "scatter", "iso", "pathtrace"].includes(t));
        show(fScatter, vol && t === "scatter");
        show(fMida, vol && t === "mida");
        show(fIso, vol && t === "iso");
        show(fShade, vol && ["ea", "scatter", "iso"].includes(t));
        show(fPt, vol && t === "pathtrace");
        show(fEik, vol && t === "eikonal");
      }
      syncFolders();

      const framing = () => framingRadius(asset, params.n);

      // --------------------------------------------------------------- input
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      on(canvas, "pointerdown", (e: PointerEvent) => {
        if (params.view === "volume" && rig.mode === "fly") {
          canvas.requestPointerLock();
          return;
        }
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
      });
      on(canvas, "pointermove", (e: PointerEvent) => {
        if (document.pointerLockElement === canvas) {
          rig.look(e.movementX, e.movementY);
          return;
        }
        if (!dragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        if (params.view === "volume") rig.drag(dx, dy);
        else {
          seedCustomFromPreset(params);
          params.sliceAz -= dx * 0.3;
          params.sliceEl = Math.min(89, Math.max(-89, params.sliceEl + dy * 0.3));
        }
      });
      on(canvas, "pointerup", () => (dragging = false));
      on(
        canvas,
        "wheel",
        (e: WheelEvent) => {
          e.preventDefault();
          if (params.view === "volume") rig.wheel(e.deltaY);
          else
            params.sliceZoom = Math.min(
              20,
              Math.max(0.5, params.sliceZoom * Math.exp(-e.deltaY * 0.001)),
            );
        },
        { passive: false },
      );
      const guiHasFocus = () =>
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLSelectElement;
      on(window, "keydown", (e: KeyboardEvent) => {
        if (!guiHasFocus()) rig.keyDown(e.code);
      });
      on(window, "keyup", (e: KeyboardEvent) => rig.keyUp(e.code));
      on(document, "pointerlockchange", () => {
        if (document.pointerLockElement !== canvas) rig.clearKeys();
      });

      // ---------------------------------------------------------- the loop
      const resize = () => {
        const w = fixedSize ?? Math.round(canvas.clientWidth * devicePixelRatio * params.renderScale);
        const h = fixedSize ?? Math.round(canvas.clientHeight * devicePixelRatio * params.renderScale);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
      };
      if (fixedSize) {
        canvas.classList.remove("view-fill");
        canvas.style.width = canvas.style.height = `${fixedSize}px`;
      }

      // ------------------------------------------------- URL state writeback
      // The address bar mirrors the live view (user request 2026-07-19), so
      // any moment of exploration is copyable as a link. Only values that
      // differ from the defaults are written — the same vocabulary
      // applyUrlOverrides reads back — and only for the active technique,
      // keeping URLs short. replaceState (no pushState) leaves history alone.
      const urlDefaults = defaultParams();
      let lastQuery: string | null = null;
      const syncUrl = () => {
        const p = params;
        const d = urlDefaults;
        const t = p.technique;
        const vol = p.view === "volume";
        const q = new URLSearchParams();
        const r = (v: number, digits = 3) => +v.toFixed(digits);

        if (p.n !== d.n || p.l !== d.l || p.m !== d.m)
          q.set("state", `${p.n},${p.l},${p.m}`);
        if (p.view !== d.view) q.set("view", p.view);
        if (p.mode !== d.mode) q.set("mode", p.mode);
        // color is implied by mode (real→ramp, complex→phase) unless changed.
        if (p.color !== (p.mode === "real" ? "ramp" : "phase")) q.set("color", p.color);
        if (p.value !== d.value) q.set("value", p.value);
        if (p.compress !== d.compress) q.set("compress", p.compress);
        if (p.ramp !== d.ramp) q.set("ramp", p.ramp);
        if (p.rampSpace !== d.rampSpace) q.set("rampSpace", p.rampSpace);
        if (!p.phaseVivid) q.set("vivid", "0");
        if (!p.dither) q.set("dither", "0");

        // Numeric params, gated to the groups the current view/technique
        // actually reads (see the shader headers for ownership).
        const groups: [NumKey[], boolean][] = [
          [["gamma", "phaseChromaPow", "renderScale"], true],
          [["compressK"], p.compress !== "off"],
          [["steps"], vol && t !== "pathtrace" && t !== "eikonal"],
          [["density", "opacityPow", "emission"], vol && t !== "mip" && t !== "iso" && t !== "eikonal"],
          [["exposure", "fov"], vol],
          [["lightAz", "lightEl", "lightGain", "hgG"],
            vol && ["ea", "scatter", "iso", "pathtrace"].includes(t)],
          [["shadowSteps", "shadowDensity", "octaves", "octaveGain", "octaveExt",
            "ambientGain", "ambientDirs", "ambientRadius", "ambientDensity"],
            vol && (t === "scatter" || t === "iso")],
          [["midaGamma"], vol && t === "mida"],
          [["isoLevel", "isoCount", "isoSpacing", "isoAlpha", "isoEmission", "isoRim"],
            vol && t === "iso"],
          [["shadeDiffuse", "shadeSpec", "shadeRough", "shadeF0", "shadeConf", "gradDelta"],
            vol && p.shadeModel !== "off" && ["ea", "scatter", "iso"].includes(t)],
          [["maxBounces", "albedo", "scatterTint", "sppFrame", "aperture", "focus", "ptEnvGain"],
            vol && t === "pathtrace"],
          [["eikSteps", "iorScale", "eikPow", "eikLogK", "absorb", "eikEmission",
            "dispersion", "eikEnvGain", "eikGradDelta"],
            vol && t === "eikonal"],
        ];
        const active = new Set<NumKey>();
        for (const [keys, cond] of groups) if (cond) keys.forEach((k) => active.add(k));
        for (const [key, digits] of NUM_KEYS)
          if (active.has(key) && p[key] !== d[key])
            q.set(NUM_ALIASES[key] ?? key, `${r(p[key], digits)}`);

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
          if (p.tonemap !== d.tonemap) q.set("tonemap", p.tonemap);
          if (p.shadeModel !== d.shadeModel && ["ea", "scatter", "iso"].includes(t))
            q.set("shadeModel", p.shadeModel);
          if (t === "pathtrace" && p.ptEnv !== d.ptEnv) q.set("ptEnv", p.ptEnv);
          if (t === "eikonal") {
            if (p.eikEnv !== d.eikEnv) q.set("eikEnv", p.eikEnv);
            if (p.eikMap !== d.eikMap) q.set("eikMap", p.eikMap);
          }
          // Camera: only the orbit pose has a URL form (fly is transient).
          if (rig.mode === "orbit") {
            const az = r(rig.azDeg, 1), el = r(rig.elDeg, 1), dist = r(rig.dist, 2);
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
        // Commas are query-safe; keep them readable (?state=4,2,1 — the
        // documented style) instead of URLSearchParams' %2C.
        const query = q.toString().replace(/%2C/gi, ",");
        if (query !== lastQuery) {
          lastQuery = query;
          history.replaceState(null, "", query ? `?${query}` : location.pathname);
        }
      };

      // Everything the path-traced image depends on: when this signature
      // changes, the accumulation restarts. Display-only params (tonemap,
      // exposure, dither, sppFrame) are deliberately absent — they apply to
      // the already-accumulated result.
      let lastPtSig = "";
      const ptSignature = (pose: CameraPose, clips: number[][]) =>
        JSON.stringify([
          params.n, params.l, params.m, params.mode, params.color, params.value,
          params.gamma, params.compress, params.compressK, params.ramp,
          params.rampSpace, params.phaseVivid, params.phaseChromaPow,
          params.density, params.opacityPow, params.emission,
          params.lightAz, params.lightEl, params.lightGain, params.hgG,
          params.maxBounces, params.albedo, params.scatterTint,
          params.aperture, params.focus, params.ptEnv, params.ptEnvGain,
          pose.pos, pose.fwd, clips, canvas.width, canvas.height,
        ]);

      let lastT = performance.now();
      let emaMs = 0;
      let statsAge = 0;
      const loop = (tMs: number) => {
        if (disposed) return;
        const dt = Math.min((tMs - lastT) / 1000, 0.1);
        lastT = tMs;
        resize();
        rig.update(dt, framing());

        const common: CommonParams = {
          n: params.n,
          l: params.l,
          m: params.m,
          realMode: params.mode === "real",
          colorMode: COLOR_MODE[params.color],
          rampName: params.ramp,
          rampSpaceSrgb: params.rampSpace === "srgb",
          gamma: params.gamma,
          valueMode: params.value === "amplitude" ? 1 : 0,
          compressMode: COMPRESS[params.compress],
          compressK: params.compressK,
          dither: params.dither,
          phaseVivid: params.phaseVivid,
          phaseChromaPow: params.phaseChromaPow,
        };

        if (params.view === "slice") {
          // Aspect correction: uv spans the full canvas on both axes, so equal
          // half-extents would stretch the field on a non-square canvas. The
          // U axis gets the width/height factor — pixels become square, the
          // vertical extent stays the framing (the volume renderer's
          // vertical-FOV convention), and wider windows just see more world.
          const sp = slicePlaneVectors(params, framing());
          const aspect = canvas.width / canvas.height;
          renderer.renderSlice({ common, ...sp, axisU: scale(sp.axisU, aspect) });
        } else {
          const pose = rig.pose(framing());
          const clips = clipPlaneVectors(params.clips, pose, basePose, framing());
          const camera: CameraParams = {
            camPos: pose.pos,
            camRight: pose.right,
            camUp: pose.up,
            camFwd: pose.fwd,
            fovYDeg: params.fov,
            tonemap: TONEMAP[params.tonemap],
            exposureEv: params.exposure,
            clipPlanes: clips,
          };
          const light: LightParams = {
            lightAzDeg: params.lightAz,
            lightElDeg: params.lightEl,
            lightGain: params.lightGain,
            hgG: params.hgG,
          };
          const shade: ShadeParams = {
            shadeModel: SHADE_MODEL[params.shadeModel],
            shadeDiffuse: params.shadeDiffuse,
            shadeSpec: params.shadeSpec,
            shadeRough: params.shadeRough,
            shadeF0: params.shadeF0,
            shadeConf: params.shadeConf,
            gradDelta: params.gradDelta,
          };

          if (params.technique === "pathtrace") {
            if (!renderer.floatRenderable) {
              statsEl.textContent =
                "path tracing needs float render targets (EXT_color_buffer_float) — unavailable here.";
              return;
            }
            const sig = ptSignature(pose, clips);
            if (sig !== lastPtSig) {
              lastPtSig = sig;
              renderer.resetAccum();
            }
            renderer.pathtraceSample({
              common,
              camera,
              light,
              densityScale: params.density,
              opacityPow: params.opacityPow,
              emissionGain: params.emission,
              maxBounces: params.maxBounces,
              albedo: params.albedo,
              scatterTint: params.scatterTint,
              sppFrame: params.sppFrame,
              aperture: params.aperture * framing(),
              focusDist: params.focus * framing(),
              envMode: ENV_MODE[params.ptEnv],
              envGain: params.ptEnvGain,
            });
          } else if (params.technique === "eikonal") {
            renderer.renderEikonal({
              common,
              camera,
              steps: params.eikSteps,
              iorScale: params.iorScale,
              eikMap: params.eikMap === "log" ? 1 : 0,
              eikPow: params.eikPow,
              eikLogK: params.eikLogK,
              absorb: params.absorb,
              emission: params.eikEmission,
              dispersion: params.dispersion,
              envMode: ENV_MODE[params.eikEnv],
              envGain: params.eikEnvGain,
              gradDelta: params.eikGradDelta,
            });
          } else {
            renderer.renderVolume({
              common,
              camera,
              light,
              shade,
              integrator: INTEGRATOR[params.technique],
              steps: params.steps,
              densityScale: params.density,
              opacityPow: params.opacityPow,
              emissionGain: params.emission,
              shadowSteps: params.shadowSteps,
              shadowDensity: params.shadowDensity,
              octaves: params.octaves,
              octaveGain: params.octaveGain,
              octaveExt: params.octaveExt,
              ambientGain: params.ambientGain,
              ambientDirs: params.ambientDirs,
              ambientRadius: params.ambientRadius,
              ambientDensity: params.ambientDensity,
              midaGamma: params.midaGamma,
              isoLevel: params.isoLevel,
              isoCount: params.isoCount,
              isoSpacing: params.isoSpacing,
              isoAlpha: params.isoAlpha,
              isoEmission: params.isoEmission,
              isoRim: params.isoRim,
            });
          }
        }

        emaMs = emaMs === 0 ? dt * 1000 : emaMs * 0.9 + dt * 1000 * 0.1;
        if ((statsAge += dt) > 0.25) {
          statsAge = 0;
          if (!fixedSize) syncUrl();
          const help =
            params.view === "slice"
              ? "drag: rotate plane · wheel: zoom"
              : rig.mode === "orbit"
                ? "drag: orbit · wheel: dolly"
                : "click: capture mouse · WASD+EQ fly · Shift fast · Esc release";
          const spp =
            params.view === "volume" && params.technique === "pathtrace"
              ? ` · ${renderer.pathtraceSamples} spp`
              : "";
          statsEl.textContent =
            `|${params.n},${params.l},${params.m}⟩ ${params.mode} · ` +
            `${canvas.width}×${canvas.height} · ${emaMs.toFixed(1)} ms${spp}\n${help}`;
        }

        // Shot mode (?size=N) renders deterministically and stops: one frame
        // for the direct techniques, or — for the path tracer — as many
        // accumulation passes as it takes to reach ?spp=N samples per pixel.
        const converging =
          params.view === "volume" &&
          params.technique === "pathtrace" &&
          renderer.pathtraceSamples < sppTarget;
        if (!fixedSize || !converging)
          (window as unknown as { __renderReady?: boolean }).__renderReady = true;
        if (!fixedSize || converging) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    })().catch((err) => {
      console.error(err);
      statsEl.textContent = `failed to start: ${err}`;
    });

    return () => {
      disposed = true;
      cleanups.forEach((f) => f());
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="view view-fill" />
      <div ref={statsRef} className="stats">
        loading tables + shaders…
      </div>
    </>
  );
}
