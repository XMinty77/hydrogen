// =============================================================================
// renderer.ts — the WebGL2 host for the shared GLSL ES renderer.
//
// TypeScript twin of export/Render/OrbitalRenderer.cs (+ its Slice/Volume
// subclasses): same shader-assembly contract (prelude.glsl + common.glsl +
// <view>.frag concatenated as one fragment source), same table textures
// (R32F width×1, NEAREST — lookups are texelFetch + explicit mix, so results
// are bit-comparable with the offline C# host), same uniform semantics
// (documented once, in shaders/common.glsl + the view shaders).
//
// The heavy lifting (program introspection, uniform type dispatch, texture
// creation) is delegated to twgl; this file only encodes the project's
// contracts.
// =============================================================================

import * as twgl from "twgl.js";
import {
  angularKey,
  framingRadius,
  radialKey,
  statsKey,
  type HorbAsset,
} from "./horb";
import type { PaletteSet, Ramp } from "./palettes";
import { effectiveQ999, MAX_TERMS, type SuperTerm } from "./superposition";
import type { Vec3 } from "./vec3";

/** Parameters shared by every render pass — mirror of CommonParams in
 * OrbitalRenderer.cs. View-specific geometry rides in the per-view param
 * interfaces below. */
export interface CommonParams {
  n: number;
  l: number;
  m: number;
  realMode: boolean;
  /** Superposition terms; empty ⇒ the certified single-state path. The
   * renderer packs each term's tables into one row of a 2D texture pair. */
  terms: SuperTerm[];
  /** Flat [re, im, …] coefficients for the terms (time factor folded in by
   * the host each frame — see superposition.ts). Length 2·terms.length. */
  termCoefs: Float32Array | null;
  superNormalize: boolean;
  /** 0 ramp, 1 signed (real mode), 2 phase (complex mode). */
  colorMode: number;
  rampName: string;
  /** The user-edited ramp, consulted when rampName === "custom". */
  customRamp: Ramp | null;
  rampSpaceSrgb: boolean;
  gamma: number;
  /** 0: brightness from |ψ|² (density), 1: from |ψ| (amplitude). */
  valueMode: number;
  /** Extra range compression before gamma: 0 off, 1 log, 2 asinh. */
  compressMode: number;
  /** Compression strength k (only read when compressMode > 0). */
  compressK: number;
  /** Extra-range white point (multiples of q999) that maps to full brightness;
   * paired with compressMode to reveal the saturated lobe cores. 1 = off. */
  compressWhite: number;
  dither: boolean;
  phaseVivid: boolean;
  phaseChromaPow: number;
  /** okphase only: reflect the hue on the negative-real half (signed pairing). */
  okPhaseSigned: boolean;
  /** Phase-wheel overrides; NaN falls back to palettes.json values. */
  phaseL: number;
  phaseC: number;
  phaseH0Rad: number;
  /** Dim the analytic base while an advected flow layer is visible. */
  flowOverlayEnabled: boolean;
  flowBase: number;
}

export interface SliceParams {
  common: CommonParams;
  origin: Vec3;
  axisU: Vec3;
  axisV: Vec3;
}

/** Perspective camera + the display transform — shared by every 3D view. */
export interface CameraParams {
  camPos: Vec3;
  camRight: Vec3;
  camUp: Vec3;
  camFwd: Vec3;
  fovYDeg: number;
  /** 0 linearToSrgb clamp, 1 AgX filmic (HDR integrators only). */
  tonemap: number;
  /** EV shift (2^EV) on the HDR accumulation before the transform. */
  exposureEv: number;
  /** Up to two half-space planes (nx, ny, nz, w): keep n·p + w ≥ 0. */
  clipPlanes: [number, number, number, number][];
}

/** Key light + phase anisotropy — shared by scatter, shading, path tracer. */
export interface LightParams {
  /** Direction in the orbit camera's spherical convention (degrees). */
  lightAzDeg: number;
  lightElDeg: number;
  lightGain: number;
  /** Henyey–Greenstein anisotropy g ∈ (−1, 1); 0 = isotropic. */
  hgG: number;
}

/** Local-illumination overlay (volume.frag integrators 1–2 and 4). */
export interface ShadeParams {
  /** 0 off, 1 Lambert, 2 Blinn–Phong, 3 GGX/Fresnel. */
  shadeModel: number;
  shadeDiffuse: number;
  shadeSpec: number;
  shadeRough: number;
  shadeF0: number;
  /** Gradient-confidence scale (how "surface-like" a sample must be). */
  shadeConf: number;
  /** Finite-difference half-step for gradients, fraction of rMax. */
  gradDelta: number;
}

export interface VolumeParams {
  common: CommonParams;
  camera: CameraParams;
  light: LightParams;
  shade: ShadeParams;
  /** 0 MIP, 1 EA, 2 ambient multi-scatter, 3 MIDA, 4 isosurfaces. */
  integrator: number;
  /** Isosurfaces only: use self-emissive rather than palette-mapped shading. */
  isoLegacy: boolean;
  steps: number;
  densityScale: number;
  opacityPow: number;
  emissionGain: number;
  // -- scatter (integrator 2) --
  shadowSteps: number;
  shadowDensity: number;
  octaves: number;
  octaveGain: number;
  octaveExt: number;
  ambientGain: number;
  ambientDirs: number;
  ambientRadius: number;
  ambientDensity: number;
  // -- MIDA (integrator 3) --
  midaGamma: number;
  // -- isosurfaces (integrator 4) --
  isoLevel: number;
  isoCount: number;
  isoSpacing: number;
  isoAlpha: number;
  isoEmission: number;
  isoRim: number;
  isoAmbient: number;
}

/** Physical and numerical controls shared by every genuine-flow solver. */
export interface FlowFieldParams {
  /** 0 second-order central differences, 1 fourth-order central differences. */
  derivative: number;
  derivativeDelta: number;
  /** Regularizer in multiples of q999: v = j / (rho + epsilon*q999). */
  nodeEps: number;
  /** Atomic units represented per wall-clock second. */
  timeScale: number;
  /** Safety cap in domain radii per wall-clock second. */
  maxSpeed: number;
  reverse: boolean;
  /** 0 Euler, 1 midpoint/RK2. */
  integrator: number;
  substeps: number;
  /** 0 Born-density, 1 current-flux, 2 uniform-volume seeding. */
  seedMode: number;
  seedPower: number;
  spawnTries: number;
  seedInsideClips: boolean;
  resetNonce: number;
}

/** Persistent 3-D tracer ensemble + temporal HDR trail treatment. */
export interface FlowParticleParams {
  common: CommonParams;
  camera: CameraParams;
  field: FlowFieldParams;
  dt: number;
  particleSide: number;
  lifetime: number;
  streakLength: number;
  speedStretch: number;
  widthPx: number;
  halo: number;
  haloGain: number;
  tailPower: number;
  headBoost: number;
  opacity: number;
  trailHalfLife: number;
  trailDiffusion: number;
  emission: number;
  compositeOpacity: number;
  /** 0 additive, 1 screen, 2 premultiplied-alpha. */
  compositeMode: number;
  /** 0 palette-speed, 1 palette material-coordinate, 2 wavefunction phase. */
  colorMode: number;
  colorGain: number;
  colorFloor: number;
  /** Exponent of the local rho/q999 visibility gate; 0 disables it. */
  densityGate: number;
  clipVisible: boolean;
}

/** Semi-Lagrangian dye advection on the active 2-D slice. */
export interface FlowInkParams {
  common: CommonParams;
  field: FlowFieldParams;
  dt: number;
  origin: Vec3;
  axisU: Vec3;
  axisV: Vec3;
  colorMode: number;
  colorGain: number;
  colorFloor: number;
  densityGate: number;
  noiseScale: number;
  decay: number;
  injection: number;
  diffusion: number;
  throughFade: number;
  contrast: number;
  opacity: number;
}

/** Persistent world-space dye atlas plus its volumetric presentation. The
 * orbital rho is still evaluated analytically in the resolve; only this
 * passive material is advected through the probability transport velocity. */
export interface FlowVolumeParams {
  common: CommonParams;
  camera: CameraParams;
  field: FlowFieldParams;
  dt: number;
  /** Cubic voxel count; the z slices are packed into a square-ish 2-D atlas. */
  grid: number;
  steps: number;
  noiseScale: number;
  noiseOctaves: number;
  lacunarity: number;
  persistence: number;
  noiseContrast: number;
  decay: number;
  injection: number;
  diffusion: number;
  /** Bounded MacCormack anti-diffusion: 0 plain semi-Lagrangian, 1 full. */
  correction: number;
  signalGain: number;
  signalPow: number;
  threshold: number;
  softness: number;
  extinction: number;
  emission: number;
  opacity: number;
  ditherAmount: number;
  ditherScale: number;
  ditherRate: number;
  ditherCoverage: number;
  rayJitter: number;
  colorMode: number;
  colorGain: number;
  colorFloor: number;
  densityGate: number;
  /** 0 additive, 1 screen, 2 premultiplied-alpha. */
  compositeMode: number;
}

export interface PathtraceParams {
  common: CommonParams;
  camera: CameraParams;
  light: LightParams;
  densityScale: number;
  opacityPow: number;
  emissionGain: number;
  maxBounces: number;
  albedo: number;
  scatterTint: number;
  sppFrame: number;
  /** Thin-lens aperture radius, world (a₀); 0 = pinhole. */
  aperture: number;
  /** Focal distance along camFwd, world (a₀). */
  focusDist: number;
  /** Environment: 0 black, 1 uniform, 2 studio, 3 hue sphere, 4 checker. */
  envMode: number;
  envGain: number;
}

export interface EikonalParams {
  common: CommonParams;
  camera: CameraParams;
  steps: number;
  iorScale: number;
  /** 0 power map, 1 logarithmic map. */
  eikMap: number;
  eikPow: number;
  eikLogK: number;
  absorb: number;
  emission: number;
  dispersion: number;
  envMode: number;
  envGain: number;
  /** Finite-difference half-step, fraction of rMax (index gradients). */
  gradDelta: number;
}

/** Display-referred finishing applied to the completed analytic + flow scene. */
export interface PostProcessParams {
  bloomEnabled: boolean;
  bloomThreshold: number;
  bloomKnee: number;
  bloomIntensity: number;
  bloomRadius: number;
  bloomIterations: number;
  bloomScale: number;
  bloomSaturation: number;
  bloomTint: Vec3;
  /** 0 screen, 1 additive. */
  bloomComposite: number;
  exposure: number;
  contrast: number;
  saturation: number;
  vibrance: number;
  aberrationPx: number;
  aberrationFalloff: number;
  vignetteEnabled: boolean;
  vignetteAmount: number;
  vignetteRadius: number;
  vignetteSoftness: number;
  vignetteRoundness: number;
  vignetteCenter: [number, number];
  grainEnabled: boolean;
  grainAmount: number;
  grainScale: number;
  grainTime: number;
  grainColored: boolean;
}

const MAX_STOPS = 8;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function lightDirOf(l: LightParams): Vec3 {
  const az = (l.lightAzDeg * Math.PI) / 180;
  const el = (l.lightElDeg * Math.PI) / 180;
  return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
}

export class OrbitalRenderer {
  private readonly radialTex = new Map<string, WebGLTexture>();
  private readonly angularTex = new Map<string, WebGLTexture>();
  private readonly phaseCmaxTex: WebGLTexture;

  // Superposition row textures (one row per term) + their cache key. Rebuilt
  // only when the term list's (n,l,m) content changes; coefficients ride in
  // uniforms and cost nothing to animate.
  private supRadialTex: WebGLTexture | null = null;
  private supAngularTex: WebGLTexture | null = null;
  private supKey = "";
  private supRMax = new Float32Array(MAX_TERMS);

  // Path-tracer accumulation: two RGBA32F targets ping-ponged each pass
  // (read previous sum, write previous + new samples). Rebuilt on resize.
  private accumFbi: [twgl.FramebufferInfo, twgl.FramebufferInfo] | null = null;
  private accumW = 0;
  private accumH = 0;
  private accumRead = 0; // index of the buffer currently holding the sum
  private accumFrames = 0; // passes since the last reset
  private accumSamples = 0; // total samples per pixel accumulated

  // Genuine probability-flow state. Particle positions use one RGBA32F
  // position/age target; velocity comes from ping-pong displacement, avoiding
  // float MRTs that some WebGL2 implementations reject. Its HDR trail and the
  // 2-D ink field are independent ping-pong buffers. Camera edits clear only the
  // screen-space trail, while field edits may explicitly reseed the ensemble.
  private flowStateFbi: [twgl.FramebufferInfo, twgl.FramebufferInfo] | null = null;
  private flowStateSide = 0;
  private flowStateRead = 0;
  private flowStateReset = true;
  private flowFrame = 0;
  private flowTrailFbi: [twgl.FramebufferInfo, twgl.FramebufferInfo] | null = null;
  private flowTrailW = 0;
  private flowTrailH = 0;
  private flowTrailRead = 0;
  private flowTrailReset = true;
  private flowInkFbi: [twgl.FramebufferInfo, twgl.FramebufferInfo] | null = null;
  private flowInkW = 0;
  private flowInkH = 0;
  private flowInkRead = 0;
  private flowInkReset = true;
  private flowVolumeFbi: [
    twgl.FramebufferInfo, twgl.FramebufferInfo, twgl.FramebufferInfo,
  ] | null = null;
  private flowVolumeGrid = 0;
  private flowVolumeTilesX = 0;
  private flowVolumeTilesY = 0;
  private flowVolumeRead = 0;
  private flowVolumeReset = true;
  private flowVolumeFrame = 0;

  // Optional display-referred finishing. Analytic and flow passes target the
  // full-resolution scene texture while enabled; bloom uses a separately
  // scalable ping-pong pair before the final composite resolves to the canvas.
  private presentationTarget: twgl.FramebufferInfo | null = null;
  private postSceneFbi: twgl.FramebufferInfo | null = null;
  private postSceneW = 0;
  private postSceneH = 0;
  private postBloomFbi: [twgl.FramebufferInfo, twgl.FramebufferInfo] | null = null;
  private postBloomW = 0;
  private postBloomH = 0;

  /** True when RGBA32F render targets are supported (EXT_color_buffer_float). */
  readonly floatRenderable: boolean;

  private constructor(
    readonly gl: WebGL2RenderingContext,
    readonly asset: HorbAsset,
    readonly palettes: PaletteSet,
    private readonly slicePi: twgl.ProgramInfo,
    private readonly volumePi: twgl.ProgramInfo,
    private readonly pathtracePi: twgl.ProgramInfo,
    private readonly eikonalPi: twgl.ProgramInfo,
    private readonly displayPi: twgl.ProgramInfo,
    private readonly axesPi: twgl.ProgramInfo,
    private readonly flowUpdatePi: twgl.ProgramInfo,
    private readonly flowParticlesPi: twgl.ProgramInfo,
    private readonly flowDecayPi: twgl.ProgramInfo,
    private readonly flowCompositePi: twgl.ProgramInfo,
    private readonly flowInkUpdatePi: twgl.ProgramInfo,
    private readonly flowInkDisplayPi: twgl.ProgramInfo,
    private readonly flowVolumeUpdatePi: twgl.ProgramInfo,
    private readonly flowVolumeCorrectPi: twgl.ProgramInfo,
    private readonly flowVolumeRenderPi: twgl.ProgramInfo,
    private readonly postBloomExtractPi: twgl.ProgramInfo,
    private readonly postBloomBlurPi: twgl.ProgramInfo,
    private readonly postCompositePi: twgl.ProgramInfo,
  ) {
    this.phaseCmaxTex = this.createTableTexture(palettes.phaseCmax);
    this.floatRenderable = gl.getExtension("EXT_color_buffer_float") !== null;
  }

  /** Fetch the shared shader sources and compile all view programs. */
  static async create(
    gl: WebGL2RenderingContext,
    asset: HorbAsset,
    palettes: PaletteSet,
    shaderBase: string,
  ): Promise<OrbitalRenderer> {
    const files = [
      "fullscreen.vert",
      "prelude.glsl",
      "common.glsl",
      "slice.frag",
      "volume.frag",
      "pathtrace.frag",
      "eikonal.frag",
      "display.frag",
      "axes.frag",
      "flow_update.frag",
      "flow_particles.vert",
      "flow_particles.frag",
      "flow_decay.frag",
      "flow_composite.frag",
      "flow_ink_update.frag",
      "flow_ink_display.frag",
      "flow_volume_update.frag",
      "flow_volume_correct.frag",
      "flow_volume_render.frag",
      "post_bloom_extract.frag",
      "post_bloom_blur.frag",
      "post_composite.frag",
    ];
    const [vert, prelude, common, slice, volume, pathtrace, eikonal, display, axes,
      flowUpdate, flowParticlesVert, flowParticles, flowDecay, flowComposite,
      flowInkUpdate, flowInkDisplay, flowVolumeUpdate, flowVolumeCorrect,
      flowVolumeRender, postBloomExtract, postBloomBlur, postComposite] =
      await Promise.all(files.map((f) => fetchText(`${shaderBase}/${f}`)));
    // View shaders share prelude + common; the axes overlay needs neither the
    // ψ machinery nor common's uniforms, so it compiles against prelude alone.
    const compile = (viewFrag: string, withCommon = true) => {
      const src = withCommon ? prelude + common + viewFrag : prelude + viewFrag;
      const pi = twgl.createProgramInfo(gl, [vert, src]);
      if (!pi) throw new Error("shader compile/link failed (see console)");
      return pi;
    };
    return new OrbitalRenderer(
      gl,
      asset,
      palettes,
      compile(slice),
      compile(volume),
      compile(pathtrace),
      compile(eikonal),
      compile(display),
      compile(axes, false),
      compile(flowUpdate),
      twgl.createProgramInfo(gl, [flowParticlesVert, prelude + common + flowParticles]),
      compile(flowDecay, false),
      compile(flowComposite),
      compile(flowInkUpdate),
      compile(flowInkDisplay),
      compile(flowVolumeUpdate),
      compile(flowVolumeCorrect),
      compile(flowVolumeRender),
      compile(postBloomExtract, false),
      compile(postBloomBlur, false),
      compile(postComposite, false),
    );
  }

  /** R32F width×1 table texture, NEAREST/CLAMP — the same layout the C# host
   * uploads; common.glsl's lookupTable does the filtering explicitly. */
  private createTableTexture(values: Float32Array): WebGLTexture {
    const gl = this.gl;
    return twgl.createTexture(gl, {
      width: values.length,
      height: 1,
      internalFormat: gl.R32F,
      format: gl.RED,
      type: gl.FLOAT,
      src: values,
      min: gl.NEAREST,
      mag: gl.NEAREST,
      wrap: gl.CLAMP_TO_EDGE,
    });
  }

  /** The framing half-extent used for default slice extents and camera
   * distances (multiples of it). */
  framing(n: number): number {
    return framingRadius(this.asset, n);
  }

  /** Pack each superposition term's radial/angular table into one row of a
   * 2D R32F texture pair (all rows share a width — fixed by the HORB format).
   * Cached on the term list's (n,l,m) signature. */
  private ensureSuperTextures(terms: SuperTerm[]) {
    const key = terms.map((t) => `${t.n},${t.l},${t.m}`).join(";");
    if (key === this.supKey) return;
    const gl = this.gl;

    const rad0 = this.asset.radial.values().next().value!;
    const ang0 = this.asset.angular.values().next().value!;
    const radW = rad0.values.length;
    const angW = ang0.values.length;
    const radData = new Float32Array(radW * MAX_TERMS);
    const angData = new Float32Array(angW * MAX_TERMS);
    this.supRMax.fill(1);
    terms.forEach((t, k) => {
      const radial = this.asset.radial.get(radialKey(t.n, t.l));
      if (!radial) throw new Error(`no radial table for n=${t.n}, l=${t.l}`);
      const angular = this.asset.angular.get(angularKey(t.l, t.m));
      if (!angular) throw new Error(`no angular table for l=${t.l}, m=${t.m}`);
      radData.set(radial.values, k * radW);
      angData.set(angular.values, k * angW);
      this.supRMax[k] = radial.rMax;
    });

    const make = (width: number, src: Float32Array) =>
      twgl.createTexture(gl, {
        width,
        height: MAX_TERMS,
        internalFormat: gl.R32F,
        format: gl.RED,
        type: gl.FLOAT,
        src,
        min: gl.NEAREST,
        mag: gl.NEAREST,
        wrap: gl.CLAMP_TO_EDGE,
      });
    if (this.supRadialTex) gl.deleteTexture(this.supRadialTex);
    if (this.supAngularTex) gl.deleteTexture(this.supAngularTex);
    this.supRadialTex = make(radW, radData);
    this.supAngularTex = make(angW, angData);
    this.supKey = key;
  }

  /** Everything shared between passes — mirror of UploadCommon. */
  private commonUniforms(p: CommonParams): Record<string, unknown> {
    const radial = this.asset.radial.get(radialKey(p.n, p.l));
    if (!radial) throw new Error(`no radial table for n=${p.n}, l=${p.l}`);
    let radTex = this.radialTex.get(radialKey(p.n, p.l));
    if (!radTex) {
      radTex = this.createTableTexture(radial.values);
      this.radialTex.set(radialKey(p.n, p.l), radTex);
    }
    const angular = this.asset.angular.get(angularKey(p.l, p.m));
    if (!angular) throw new Error(`no angular table for l=${p.l}, m=${p.m}`);
    let angTex = this.angularTex.get(angularKey(p.l, p.m));
    if (!angTex) {
      angTex = this.createTableTexture(angular.values);
      this.angularTex.set(angularKey(p.l, p.m), angTex);
    }

    const stats = this.asset.stats.get(statsKey(p.n, p.l, p.m, p.realMode));
    if (!stats) throw new Error(`no stats for (${p.n},${p.l},${p.m})`);

    // Superposition: pack term tables, extend the domain to cover every term,
    // and swap the display normalization for the |c|²-weighted quantile.
    const superOn = p.terms.length > 0;
    let rMax = radial.rMax;
    let q999 = stats.q999;
    const supM = new Int32Array(MAX_TERMS);
    const supCoef = new Float32Array(MAX_TERMS * 2);
    if (superOn) {
      this.ensureSuperTextures(p.terms);
      rMax = Math.max(...p.terms.map((t, k) => (supM[k] = t.m, this.supRMax[k])));
      q999 = effectiveQ999(p.terms, this.asset, p.realMode, p.superNormalize);
      if (p.termCoefs) supCoef.set(p.termCoefs);
      else p.terms.forEach((t, k) => (supCoef[2 * k] = t.amp));
    }

    const ramp =
      p.rampName === "custom" && p.customRamp
        ? p.customRamp
        : this.palettes.ramps[p.rampName];
    if (!ramp) throw new Error(`unknown ramp '${p.rampName}'`);
    const stops = p.rampSpaceSrgb ? ramp.srgb : ramp.oklab;
    const rampColor = new Float32Array(MAX_STOPS * 3);
    const rampPos = new Float32Array(MAX_STOPS);
    stops.forEach((c, i) => rampColor.set(c, 3 * i));
    rampPos.set(ramp.positions);

    return {
      uRadialTab: radTex,
      uAngularTab: angTex,
      uPhaseCmaxTab: this.phaseCmaxTex,
      uRMax: rMax,
      uM: p.m,
      uRealMode: p.realMode ? 1 : 0,
      uSupCount: superOn ? p.terms.length : 0,
      uSupRadialTab: superOn ? this.supRadialTex : radTex,
      uSupAngularTab: superOn ? this.supAngularTex : angTex,
      uSupRMax: this.supRMax,
      uSupM: supM,
      uSupCoef: supCoef,
      uQ999: q999,
      uGamma: p.gamma,
      uValueMode: p.valueMode,
      uCompressMode: p.compressMode,
      uCompressK: p.compressK,
      uCompressWhite: p.compressWhite,
      uRampColor: rampColor,
      uRampPos: rampPos,
      uRampN: ramp.positions.length,
      uRampSpaceSrgb: p.rampSpaceSrgb ? 1 : 0,
      uPhaseL: Number.isNaN(p.phaseL) ? this.palettes.phaseL : p.phaseL,
      uPhaseC: Number.isNaN(p.phaseC) ? this.palettes.phaseC : p.phaseC,
      uPhaseH0: Number.isNaN(p.phaseH0Rad) ? this.palettes.phaseH0 : p.phaseH0Rad,
      uPhaseVivid: p.phaseVivid ? 1 : 0,
      uPhaseChromaPow: p.phaseChromaPow,
      uOkPhaseSigned: p.okPhaseSigned ? 1 : 0,
      uDitherAmp: p.dither ? 1 / 255 : 0,
      uColorMode: p.colorMode,
      uFlowOverlayEnabled: p.flowOverlayEnabled ? 1 : 0,
      uFlowBase: p.flowBase,
    };
  }

  /** Uniform bridge for every advected solver. */
  private flowFieldUniforms(p: FlowFieldParams): Record<string, unknown> {
    return {
      uCurrentDerivative: p.derivative,
      uCurrentDelta: p.derivativeDelta,
      uCurrentNodeEps: p.nodeEps,
      uFlowTimeScale: p.timeScale,
      uFlowMaxSpeed: p.maxSpeed,
      uFlowReverse: p.reverse ? 1 : 0,
      uFlowIntegrator: p.integrator,
      uFlowSubsteps: p.substeps,
      uFlowSeedMode: p.seedMode,
      uFlowSeedPower: p.seedPower,
      uFlowSpawnTries: p.spawnTries,
      uFlowSeedInsideClips: p.seedInsideClips ? 1 : 0,
      uFlowResetNonce: p.resetNonce,
    };
  }

  /** Camera basis, projection, display transform, clip planes. */
  private cameraUniforms(c: CameraParams, aspect: number): Record<string, unknown> {
    const clip = new Float32Array(8);
    c.clipPlanes.forEach((p, i) => clip.set(p, 4 * i));
    return {
      uCamPos: c.camPos,
      uCamRight: c.camRight,
      uCamUp: c.camUp,
      uCamFwd: c.camFwd,
      uTanHalfFov: Math.tan((c.fovYDeg * Math.PI) / 360),
      uAspect: aspect,
      uTonemap: c.tonemap,
      uExposure: c.exposureEv,
      uClipPlane: clip,
      uClipCount: Math.min(c.clipPlanes.length, 2),
    };
  }

  private draw(
    pi: twgl.ProgramInfo,
    uniforms: Record<string, unknown>,
    fb?: twgl.FramebufferInfo | null,
  ) {
    const gl = this.gl;
    const target = fb === undefined ? this.presentationTarget : fb;
    twgl.bindFramebufferInfo(gl, target); // null ⇒ canvas + full viewport
    // Be explicit: after atlas work some twgl/WebGL combinations restore the
    // default framebuffer but retain the atlas viewport, shrinking the next
    // base render into its lower-left corner.
    gl.viewport(0, 0,
      target ? target.width : gl.drawingBufferWidth,
      target ? target.height : gl.drawingBufferHeight);
    // twgl sets drawBuffers only when an FBO is created, not when one is
    // rebound. We switch between a two-target particle MRT, one-target HDR
    // buffers, and the default framebuffer every frame, so restore the exact
    // attachment list explicitly (ANGLE/SwiftShader otherwise rejects the
    // subsequent canvas draw and leaves its undefined white clear).
    gl.drawBuffers(target
      ? target.attachments.map((_, i) => gl.COLOR_ATTACHMENT0 + i)
      : [gl.BACK]);
    gl.useProgram(pi.program);
    twgl.setUniforms(pi, uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3); // fullscreen.vert needs no buffers
  }

  private deleteFramebufferInfo(fbi: twgl.FramebufferInfo) {
    const gl = this.gl;
    // Every flow attachment is explicitly texture-backed (including both MRT
    // state planes); no depth/renderbuffer attachments are created here.
    for (const attachment of fbi.attachments)
      gl.deleteTexture(attachment as WebGLTexture);
    gl.deleteFramebuffer(fbi.framebuffer);
  }

  private deleteFramebufferPair(pair: readonly twgl.FramebufferInfo[] | null) {
    if (!pair) return;
    pair.forEach((fbi) => this.deleteFramebufferInfo(fbi));
  }

  private clearFramebufferPair(pair: readonly twgl.FramebufferInfo[]) {
    const gl = this.gl;
    for (const fbi of pair) {
      twgl.bindFramebufferInfo(gl, fbi);
      gl.drawBuffers(fbi.attachments.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error(`incomplete flow framebuffer 0x${status.toString(16)}`);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  private postAttachment() {
    const gl = this.gl;
    return {
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      min: gl.LINEAR,
      mag: gl.LINEAR,
      wrap: gl.CLAMP_TO_EDGE,
    };
  }

  private ensurePostScene(w: number, h: number) {
    if (this.postSceneFbi && w === this.postSceneW && h === this.postSceneH) return;
    if (this.postSceneFbi) this.deleteFramebufferInfo(this.postSceneFbi);
    this.postSceneFbi = twgl.createFramebufferInfo(
      this.gl, [this.postAttachment()], w, h,
    );
    this.postSceneW = w;
    this.postSceneH = h;
  }

  private ensurePostBloom(w: number, h: number, scale: number) {
    const bw = Math.max(1, Math.round(w * Math.max(0.125, Math.min(1, scale))));
    const bh = Math.max(1, Math.round(h * Math.max(0.125, Math.min(1, scale))));
    if (this.postBloomFbi && bw === this.postBloomW && bh === this.postBloomH) return;
    this.deleteFramebufferPair(this.postBloomFbi);
    this.postBloomFbi = [
      twgl.createFramebufferInfo(this.gl, [this.postAttachment()], bw, bh),
      twgl.createFramebufferInfo(this.gl, [this.postAttachment()], bw, bh),
    ];
    this.postBloomW = bw;
    this.postBloomH = bh;
  }

  /** Redirect subsequent canvas-bound passes into a full-resolution scene
   * texture. Explicit simulation/accumulation FBO draws remain untouched. */
  beginPresentation(enabled: boolean) {
    if (!enabled) {
      this.presentationTarget = null;
      return;
    }
    this.ensurePostScene(this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);
    this.presentationTarget = this.postSceneFbi;
  }

  /** Bloom and grade the completed scene, then resolve it to the canvas.
   * Measurement overlays such as orientation axes should be drawn afterwards
   * so they remain crisp and do not contaminate bloom. */
  finishPresentation(p: PostProcessParams) {
    const scene = this.postSceneFbi;
    if (!scene || this.presentationTarget !== scene) return;
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    let bloomTexture = scene.attachments[0];

    if (p.bloomEnabled && p.bloomIntensity > 0) {
      this.ensurePostBloom(w, h, p.bloomScale);
      const [a, b] = this.postBloomFbi!;
      this.draw(this.postBloomExtractPi, {
        uScene: scene.attachments[0],
        uThreshold: p.bloomThreshold,
        uKnee: p.bloomKnee,
        uSaturation: p.bloomSaturation,
        uTint: p.bloomTint,
      }, a);
      const iterations = Math.max(1, Math.min(8, Math.round(p.bloomIterations)));
      const radius = Math.max(0.05, p.bloomRadius);
      for (let i = 0; i < iterations; i++) {
        this.draw(this.postBloomBlurPi, {
          uSource: a.attachments[0],
          uDirection: [radius / a.width, 0],
        }, b);
        this.draw(this.postBloomBlurPi, {
          uSource: b.attachments[0],
          uDirection: [0, radius / a.height],
        }, a);
      }
      bloomTexture = a.attachments[0];
    }

    // Explicit null bypasses presentationTarget and resolves to the canvas.
    this.draw(this.postCompositePi, {
      uScene: scene.attachments[0],
      uBloom: bloomTexture,
      uResolution: [w, h],
      uBloomIntensity: p.bloomEnabled ? p.bloomIntensity : 0,
      uBloomComposite: p.bloomComposite,
      uPostExposure: p.exposure,
      uPostContrast: p.contrast,
      uPostSaturation: p.saturation,
      uPostVibrance: p.vibrance,
      uAberrationPx: p.aberrationPx,
      uAberrationFalloff: p.aberrationFalloff,
      uVignetteEnabled: p.vignetteEnabled ? 1 : 0,
      uVignetteAmount: p.vignetteAmount,
      uVignetteRadius: p.vignetteRadius,
      uVignetteSoftness: p.vignetteSoftness,
      uVignetteRoundness: p.vignetteRoundness,
      uVignetteCenter: p.vignetteCenter,
      uGrainEnabled: p.grainEnabled ? 1 : 0,
      uGrainAmount: p.grainAmount,
      uGrainScale: p.grainScale,
      uGrainTime: p.grainTime,
      uGrainColored: p.grainColored ? 1 : 0,
    }, null);
    this.presentationTarget = null;
  }

  private ensureFlowState(side: number) {
    side = Math.max(8, Math.round(side));
    if (this.flowStateFbi && side === this.flowStateSide) return;
    this.deleteFramebufferPair(this.flowStateFbi);
    const gl = this.gl;
    const attachment = () => ({
      internalFormat: gl.RGBA32F,
      format: gl.RGBA,
      type: gl.FLOAT,
      min: gl.NEAREST,
      mag: gl.NEAREST,
      wrap: gl.CLAMP_TO_EDGE,
    });
    this.flowStateFbi = [
      twgl.createFramebufferInfo(gl, [attachment()], side, side),
      twgl.createFramebufferInfo(gl, [attachment()], side, side),
    ];
    this.flowStateSide = side;
    this.flowStateRead = 0;
    this.flowStateReset = true;
    this.flowFrame = 0;
    this.clearFramebufferPair(this.flowStateFbi);
  }

  private ensureFlowTrail(w: number, h: number) {
    if (this.flowTrailFbi && w === this.flowTrailW && h === this.flowTrailH) return;
    this.deleteFramebufferPair(this.flowTrailFbi);
    const gl = this.gl;
    const attachment = [{
      internalFormat: gl.RGBA16F,
      format: gl.RGBA,
      type: gl.HALF_FLOAT,
      min: gl.LINEAR,
      mag: gl.LINEAR,
      wrap: gl.CLAMP_TO_EDGE,
    }];
    this.flowTrailFbi = [
      twgl.createFramebufferInfo(gl, attachment, w, h),
      twgl.createFramebufferInfo(gl, attachment, w, h),
    ];
    this.flowTrailW = w;
    this.flowTrailH = h;
    this.flowTrailRead = 0;
    this.flowTrailReset = true;
    this.clearFramebufferPair(this.flowTrailFbi);
  }

  private ensureFlowInk(w: number, h: number) {
    if (this.flowInkFbi && w === this.flowInkW && h === this.flowInkH) return;
    this.deleteFramebufferPair(this.flowInkFbi);
    const gl = this.gl;
    // Dye is a bounded scalar; RGBA8 gives bilinear advection everywhere and
    // avoids making the slice method depend on float-linear filtering.
    const attachment = [{
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      min: gl.LINEAR,
      mag: gl.LINEAR,
      wrap: gl.CLAMP_TO_EDGE,
    }];
    this.flowInkFbi = [
      twgl.createFramebufferInfo(gl, attachment, w, h),
      twgl.createFramebufferInfo(gl, attachment, w, h),
    ];
    this.flowInkW = w;
    this.flowInkH = h;
    this.flowInkRead = 0;
    this.flowInkReset = true;
    this.clearFramebufferPair(this.flowInkFbi);
  }

  private ensureFlowVolume(grid: number) {
    const gl = this.gl;
    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    grid = Math.max(12, Math.round(grid));
    let tilesX = Math.ceil(Math.sqrt(grid));
    let tilesY = Math.ceil(grid / tilesX);
    // The UI stays far below this on normal hardware, but clamp defensively so
    // a hand-authored URL cannot request an incomplete atlas framebuffer.
    while ((tilesX * grid > maxTexture || tilesY * grid > maxTexture) && grid > 12) {
      grid -= 1;
      tilesX = Math.ceil(Math.sqrt(grid));
      tilesY = Math.ceil(grid / tilesX);
    }
    if (this.flowVolumeFbi && grid === this.flowVolumeGrid) return;
    this.deleteFramebufferPair(this.flowVolumeFbi);
    const attachment = [{
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      min: gl.LINEAR,
      mag: gl.LINEAR,
      wrap: gl.CLAMP_TO_EDGE,
    }];
    const w = tilesX * grid;
    const h = tilesY * grid;
    this.flowVolumeFbi = [
      twgl.createFramebufferInfo(gl, attachment, w, h),
      twgl.createFramebufferInfo(gl, attachment, w, h),
      twgl.createFramebufferInfo(gl, attachment, w, h),
    ];
    this.flowVolumeGrid = grid;
    this.flowVolumeTilesX = tilesX;
    this.flowVolumeTilesY = tilesY;
    this.flowVolumeRead = 0;
    this.flowVolumeReset = true;
    this.flowVolumeFrame = 0;
    this.clearFramebufferPair(this.flowVolumeFbi);
  }

  /** Reseed tracer positions (field/seed topology changed). */
  resetFlowParticles() {
    this.flowStateReset = true;
    this.flowFrame = 0;
    this.resetFlowTrails();
  }

  /** Clear only screen-space persistence (camera, clip, or appearance changed). */
  resetFlowTrails() {
    this.flowTrailReset = true;
  }

  /** Clear/reseed the advected slice dye (plane or field changed). */
  resetFlowInk() {
    this.flowInkReset = true;
  }

  /** Clear/reseed the camera-independent 3-D passive material. */
  resetFlowVolume() {
    this.flowVolumeReset = true;
    this.flowVolumeFrame = 0;
  }

  renderSlice(p: SliceParams) {
    this.draw(this.slicePi, {
      ...this.commonUniforms(p.common),
      uOrigin: p.origin,
      uAxisU: p.axisU,
      uAxisV: p.axisV,
    });
  }

  /** Advance the persistent 3-D ensemble and deposit it into the HDR trail.
   * This deliberately runs before the canvas/base pass: some WebGL drivers
   * invalidate default-framebuffer contents when offscreen work follows it. */
  advanceFlowParticles(p: FlowParticleParams) {
    const gl = this.gl;
    if (!this.floatRenderable)
      throw new Error("advected 3-D flow needs EXT_color_buffer_float");
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    this.ensureFlowState(p.particleSide);
    this.ensureFlowTrail(w, h);

    const states = this.flowStateFbi!;
    const stateRead = states[this.flowStateRead];
    const stateWrite = states[1 - this.flowStateRead];
    this.draw(this.flowUpdatePi, {
      ...this.commonUniforms(p.common),
      ...this.cameraUniforms(p.camera, w / h),
      ...this.flowFieldUniforms(p.field),
      uFlowPositionAge: stateRead.attachments[0],
      uFlowReset: this.flowStateReset ? 1 : 0,
      uFlowFrame: this.flowFrame,
      uFlowDt: p.dt,
      uFlowLifetime: p.lifetime,
    }, stateWrite);
    const stateWasReset = this.flowStateReset;
    this.flowStateRead = 1 - this.flowStateRead;
    this.flowStateReset = false;
    this.flowFrame += 1;
    const state = states[this.flowStateRead];

    const trailWasReset = this.flowTrailReset;
    if (trailWasReset) {
      this.clearFramebufferPair(this.flowTrailFbi!);
      this.flowTrailReset = false;
    }
    const trails = this.flowTrailFbi!;
    const trailRead = trails[this.flowTrailRead];
    const trailWrite = trails[1 - this.flowTrailRead];
    const retention = p.trailHalfLife <= 0 || p.dt <= 0
      ? (p.dt <= 0 ? 1 : 0)
      : Math.pow(0.5, p.dt / p.trailHalfLife);
    this.draw(this.flowDecayPi, {
      uFlowTrail: trailRead.attachments[0],
      uFlowTexel: [1 / w, 1 / h],
      uFlowRetention: retention,
      uFlowTrailDiffusion: p.trailDiffusion,
    }, trailWrite);
    this.flowTrailRead = 1 - this.flowTrailRead;

    // Deposit one camera-facing ribbon per particle into the just-decayed HDR
    // buffer. Additive accumulation preserves overlapping filament radiance.
    // Pausing freezes the buffer instead of brightening it every display frame;
    // after a reset we still deposit once so a paused ensemble remains visible.
    const target = trails[this.flowTrailRead];
    if (p.dt > 0 || stateWasReset || trailWasReset) {
      twgl.bindFramebufferInfo(gl, target);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.useProgram(this.flowParticlesPi.program);
      twgl.setUniforms(this.flowParticlesPi, {
        ...this.commonUniforms(p.common),
        ...this.cameraUniforms(p.camera, w / h),
        uFlowPositionAge: state.attachments[0],
        uFlowPreviousPositionAge: stateRead.attachments[0],
        uFlowParticleSide: this.flowStateSide,
        uResolution: [w, h],
        uFlowLifetime: p.lifetime,
        uFlowDt: stateWasReset ? 0 : p.dt,
        uFlowMaxSpeed: p.field.maxSpeed,
        uFlowStreakLength: p.streakLength,
        uFlowSpeedStretch: p.speedStretch,
        uFlowWidthPx: p.widthPx,
        uFlowHalo: p.halo,
        uFlowHaloGain: p.haloGain,
        uFlowTailPower: p.tailPower,
        uFlowHeadBoost: p.headBoost,
        uFlowOpacity: p.opacity,
        uFlowColorMode: p.colorMode,
        uFlowColorGain: p.colorGain,
        uFlowColorFloor: p.colorFloor,
        uFlowDensityGate: p.densityGate,
        uFlowClipVisible: p.clipVisible ? 1 : 0,
      });
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.flowStateSide * this.flowStateSide);
      gl.disable(gl.BLEND);
    }

  }

  /** Resolve the already-advanced HDR particle trail over a completed base
   * render. Call after the volume/pathtrace/eikonal pass and before axes. */
  compositeFlowParticles(p: FlowParticleParams) {
    if (!this.flowTrailFbi || p.compositeOpacity <= 0 || p.emission <= 0) return;
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const target = this.flowTrailFbi[this.flowTrailRead];
    if (p.compositeMode === 0) gl.blendFunc(gl.ONE, gl.ONE);
    else if (p.compositeMode === 1) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    this.draw(this.flowCompositePi, {
      ...this.commonUniforms(p.common),
      ...this.cameraUniforms(p.camera, w / h),
      uFlowTrail: target.attachments[0],
      uFlowEmission: p.emission,
      uFlowCompositeOpacity: p.compositeOpacity,
      uFlowCompositeMode: p.compositeMode,
    });
    gl.disable(gl.BLEND);
  }

  /** One semi-Lagrangian step of slice dye, then a palette-mapped overlay. */
  renderFlowInk(p: FlowInkParams) {
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    this.ensureFlowInk(w, h);
    const pair = this.flowInkFbi!;
    const read = pair[this.flowInkRead];
    const write = pair[1 - this.flowInkRead];
    this.draw(this.flowInkUpdatePi, {
      ...this.commonUniforms(p.common),
      ...this.flowFieldUniforms(p.field),
      uFlowInkPrevious: read.attachments[0],
      uFlowInkTexel: [1 / w, 1 / h],
      uOrigin: p.origin,
      uAxisU: p.axisU,
      uAxisV: p.axisV,
      uFlowReset: this.flowInkReset ? 1 : 0,
      uFlowDt: p.dt,
      uFlowInkScale: p.noiseScale,
      uFlowInkDecay: p.decay,
      uFlowInkInjection: p.injection,
      uFlowInkDiffusion: p.diffusion,
      uFlowInkThroughFade: p.throughFade,
    }, write);
    this.flowInkRead = 1 - this.flowInkRead;
    this.flowInkReset = false;

    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.draw(this.flowInkDisplayPi, {
      ...this.commonUniforms(p.common),
      ...this.flowFieldUniforms(p.field),
      uFlowInk: write.attachments[0],
      uOrigin: p.origin,
      uAxisU: p.axisU,
      uAxisV: p.axisV,
      uFlowColorMode: p.colorMode,
      uFlowColorGain: p.colorGain,
      uFlowColorFloor: p.colorFloor,
      uFlowDensityGate: p.densityGate,
      uFlowInkContrast: p.contrast,
      uFlowInkOpacity: p.opacity,
    });
    gl.disable(gl.BLEND);
  }

  /** Advance the world-space dye before the canvas/base pass. RGBA8 makes this
   * technique available even when float render targets are absent. */
  advanceFlowVolume(p: FlowVolumeParams) {
    this.ensureFlowVolume(p.grid);
    if (!this.flowVolumeReset && p.dt <= 0) return;
    const states = this.flowVolumeFbi!;
    const originalIndex = this.flowVolumeRead;
    const predictorIndex = (originalIndex + 1) % 3;
    const finalIndex = (originalIndex + 2) % 3;
    const original = states[originalIndex];
    const predictor = states[predictorIndex];
    this.draw(this.flowVolumeUpdatePi, {
      ...this.commonUniforms(p.common),
      ...this.cameraUniforms(p.camera, 1),
      ...this.flowFieldUniforms(p.field),
      uFlowVolumePrevious: original.attachments[0],
      uFlowVolumeGrid: this.flowVolumeGrid,
      uFlowVolumeTilesX: this.flowVolumeTilesX,
      uFlowVolumeTilesY: this.flowVolumeTilesY,
      uFlowReset: this.flowVolumeReset ? 1 : 0,
      uFlowDt: p.dt,
      uFlowVolumeNoiseScale: p.noiseScale,
      uFlowVolumeNoiseOctaves: p.noiseOctaves,
      uFlowVolumeLacunarity: p.lacunarity,
      uFlowVolumePersistence: p.persistence,
      uFlowVolumeNoiseContrast: p.noiseContrast,
      uFlowVolumeDecay: p.decay,
      uFlowVolumeInjection: p.injection,
      uFlowVolumeDiffusion: p.diffusion,
    }, predictor);
    if (!this.flowVolumeReset && p.correction > 0 && p.dt > 0) {
      this.draw(this.flowVolumeCorrectPi, {
        ...this.commonUniforms(p.common),
        ...this.cameraUniforms(p.camera, 1),
        ...this.flowFieldUniforms(p.field),
        uFlowVolumeOriginal: original.attachments[0],
        uFlowVolumePredictor: predictor.attachments[0],
        uFlowVolumeGrid: this.flowVolumeGrid,
        uFlowVolumeTilesX: this.flowVolumeTilesX,
        uFlowVolumeTilesY: this.flowVolumeTilesY,
        uFlowDt: p.dt,
        uFlowVolumeCorrection: p.correction,
      }, states[finalIndex]);
      this.flowVolumeRead = finalIndex;
    } else {
      this.flowVolumeRead = predictorIndex;
    }
    this.flowVolumeReset = false;
    this.flowVolumeFrame += 1;
  }

  /** Raymarch the persistent dye over a completed base volume. */
  compositeFlowVolume(p: FlowVolumeParams) {
    if (!this.flowVolumeFbi) return;
    if (p.opacity <= 0 || p.emission <= 0) return;
    const gl = this.gl;
    if (p.compositeMode === 0) gl.blendFunc(gl.ONE, gl.ONE);
    else if (p.compositeMode === 1) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    const state = this.flowVolumeFbi[this.flowVolumeRead];
    this.draw(this.flowVolumeRenderPi, {
      ...this.commonUniforms(p.common),
      ...this.cameraUniforms(
        p.camera,
        gl.drawingBufferWidth / gl.drawingBufferHeight,
      ),
      uFlowVolume: state.attachments[0],
      uFlowVolumeGrid: this.flowVolumeGrid,
      uFlowVolumeTilesX: this.flowVolumeTilesX,
      uFlowVolumeTilesY: this.flowVolumeTilesY,
      uFlowVolumeSteps: p.steps,
      uFlowFrame: this.flowVolumeFrame,
      uFlowColorMode: p.colorMode,
      uFlowColorGain: p.colorGain,
      uFlowColorFloor: p.colorFloor,
      uFlowDensityGate: p.densityGate,
      uFlowVolumeSignalGain: p.signalGain,
      uFlowVolumeSignalPow: p.signalPow,
      uFlowVolumeThreshold: p.threshold,
      uFlowVolumeSoftness: p.softness,
      uFlowVolumeExtinction: p.extinction,
      uFlowVolumeEmission: p.emission,
      uFlowVolumeOpacity: p.opacity,
      uFlowVolumeDitherAmount: p.ditherAmount,
      uFlowVolumeDitherScale: p.ditherScale,
      uFlowVolumeDitherRate: p.ditherRate,
      uFlowVolumeDitherCoverage: p.ditherCoverage,
      uFlowVolumeRayJitter: p.rayJitter,
    });
    gl.disable(gl.BLEND);
  }

  renderVolume(p: VolumeParams) {
    const gl = this.gl;
    this.draw(this.volumePi, {
      ...this.commonUniforms(p.common),
      ...this.cameraUniforms(p.camera, gl.drawingBufferWidth / gl.drawingBufferHeight),
      uIntegrator: p.integrator,
      uSteps: p.steps,
      uDensityScale: p.densityScale,
      uOpacityPow: p.opacityPow,
      uEmissionGain: p.emissionGain,
      uLightDir: lightDirOf(p.light),
      uLightGain: p.light.lightGain,
      uHgG: p.light.hgG,
      uShadowSteps: p.shadowSteps,
      uShadowDensity: p.shadowDensity,
      uOctaves: p.octaves,
      uOctaveGain: p.octaveGain,
      uOctaveExt: p.octaveExt,
      uAmbientGain: p.ambientGain,
      uAmbientDirs: p.ambientDirs,
      uAmbientRadius: p.ambientRadius,
      uAmbientDensity: p.ambientDensity,
      uMidaGamma: p.midaGamma,
      uIsoLevel: p.isoLevel,
      uIsoCount: p.isoCount,
      uIsoSpacing: p.isoSpacing,
      uIsoAlpha: p.isoAlpha,
      uIsoEmission: p.isoEmission,
      uIsoRim: p.isoRim,
      uIsoAmbient: p.isoAmbient,
      uIsoLegacy: p.isoLegacy ? 1 : 0,
      uShadeModel: p.shade.shadeModel,
      uShadeDiffuse: p.shade.shadeDiffuse,
      uShadeSpec: p.shade.shadeSpec,
      uShadeRough: p.shade.shadeRough,
      uShadeF0: p.shade.shadeF0,
      uShadeConf: p.shade.shadeConf,
      uGradDelta: p.shade.gradDelta,
    });
  }

  /** Blend the 3-D orientation axes over the finished frame (call last, after
   * whichever integrator drew the canvas). Shares the live camera so the arms
   * track every rotation. `axisLen` is the arm half-length in world a₀ (huge ⇒
   * the arms read as infinite lines); `near` is the view-space near clip in the
   * same units. Line thickness is specified in CSS pixels and scaled to the
   * backing store here, so it looks identical at any render scale. */
  renderAxes(camera: CameraParams, axisLen: number, near: number) {
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    // Backing-store pixels per CSS pixel (= dpr·renderScale·qualityMul). The
    // canvas backing store grows with the render scale, so a fixed pixel width
    // would look thinner the more we supersample; scale by this to hold the
    // on-screen thickness constant. Falls back to 1 for the fixed-size shot mode.
    const cssH = (gl.canvas as HTMLCanvasElement).clientHeight || h;
    const ratio = h / cssH;
    const cssThickness = 1.4; // half-width in CSS pixels
    const cssFeather = 1.5; // AA falloff in CSS pixels
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.draw(this.axesPi, {
      uCamPos: camera.camPos,
      uCamRight: camera.camRight,
      uCamUp: camera.camUp,
      uCamFwd: camera.camFwd,
      uTanHalfFov: Math.tan((camera.fovYDeg * Math.PI) / 360),
      uAspect: w / h,
      uResolution: [w, h],
      uAxisLen: axisLen,
      uAxisThickness: cssThickness * ratio,
      uAxisFeather: cssFeather * ratio,
      uAxisNear: near,
      uAxisAlpha: 1.0,
    });
    gl.disable(gl.BLEND);
  }

  renderEikonal(p: EikonalParams) {
    const gl = this.gl;
    this.draw(this.eikonalPi, {
      ...this.commonUniforms(p.common),
      ...this.cameraUniforms(p.camera, gl.drawingBufferWidth / gl.drawingBufferHeight),
      uSteps: p.steps,
      uIorScale: p.iorScale,
      uEikMap: p.eikMap,
      uEikPow: p.eikPow,
      uEikLogK: p.eikLogK,
      uEikAbsorb: p.absorb,
      uEikEmission: p.emission,
      uDispersion: p.dispersion,
      uEnvMode: p.envMode,
      uEnvGain: p.envGain,
      uGradDelta: p.gradDelta,
    });
  }

  // ------------------------------------------------------------------ path
  // tracing: progressive accumulation. Call pathtraceSample once per animation
  // frame; it adds p.sppFrame samples and presents the running mean. The host
  // calls resetAccum whenever anything the image depends on changes.

  /** Samples per pixel accumulated since the last reset. */
  get pathtraceSamples(): number {
    return this.accumSamples;
  }

  resetAccum() {
    this.accumFrames = 0;
    this.accumSamples = 0;
  }

  private ensureAccum(w: number, h: number) {
    if (this.accumFbi && this.accumW === w && this.accumH === h) return;
    const gl = this.gl;
    const attach = [
      {
        internalFormat: gl.RGBA32F,
        format: gl.RGBA,
        type: gl.FLOAT,
        min: gl.NEAREST,
        mag: gl.NEAREST,
        wrap: gl.CLAMP_TO_EDGE,
      },
    ];
    this.accumFbi = [
      twgl.createFramebufferInfo(gl, attach, w, h),
      twgl.createFramebufferInfo(gl, attach, w, h),
    ];
    this.accumW = w;
    this.accumH = h;
    this.resetAccum();
  }

  pathtraceSample(p: PathtraceParams) {
    const gl = this.gl;
    if (!this.floatRenderable)
      throw new Error("path tracing needs EXT_color_buffer_float");
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    this.ensureAccum(w, h);
    const [a, b] = this.accumFbi!;
    const read = this.accumRead === 0 ? a : b;
    const write = this.accumRead === 0 ? b : a;

    this.draw(
      this.pathtracePi,
      {
        ...this.commonUniforms({ ...p.common, dither: false }),
        ...this.cameraUniforms(p.camera, w / h),
        uPrevAccum: read.attachments[0],
        uFrameIndex: this.accumFrames,
        uSppFrame: p.sppFrame,
        uResolution: [w, h],
        uDensityScale: p.densityScale,
        uOpacityPow: p.opacityPow,
        uEmissionGain: p.emissionGain,
        uLightDir: lightDirOf(p.light),
        uLightGain: p.light.lightGain,
        uHgG: p.light.hgG,
        uMaxBounces: p.maxBounces,
        uAlbedo: p.albedo,
        uScatterTint: p.scatterTint,
        uAperture: p.aperture,
        uFocusDist: p.focusDist,
        uEnvMode: p.envMode,
        uEnvGain: p.envGain,
      },
      write,
    );
    this.accumRead = 1 - this.accumRead;
    this.accumFrames += 1;
    this.accumSamples += p.sppFrame;

    // Resolve the running mean to the canvas (exposure + tonemap + dither).
    this.draw(this.displayPi, {
      ...this.commonUniforms(p.common),
      uAccum: write.attachments[0],
      uTonemap: p.camera.tonemap,
      uExposure: p.camera.exposureEv,
    });
  }
}
