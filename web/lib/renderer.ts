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
// Iteration 5 adds two more view programs — pathtrace.frag (progressive
// Monte Carlo, resolved by display.frag from an RGBA32F accumulation
// ping-pong) and eikonal.frag (refractive rendering) — on the same contract.
// The C# host has not grown these yet (web-first prototyping round); nothing
// here changes what it compiles.
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
  /** Isosurfaces only: use the original (pre-palette-mapped) shell shading. */
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
    ];
    const [vert, prelude, common, slice, volume, pathtrace, eikonal, display, axes] =
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
    fb: twgl.FramebufferInfo | null = null,
  ) {
    const gl = this.gl;
    twgl.bindFramebufferInfo(gl, fb); // null ⇒ canvas + full viewport
    gl.useProgram(pi.program);
    twgl.setUniforms(pi, uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3); // fullscreen.vert needs no buffers
  }

  renderSlice(p: SliceParams) {
    this.draw(this.slicePi, {
      ...this.commonUniforms(p.common),
      uOrigin: p.origin,
      uAxisU: p.axisU,
      uAxisV: p.axisV,
    });
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
   * track every rotation; `axisLen` is the arm half-length in world a₀. */
  renderAxes(camera: CameraParams, axisLen: number) {
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
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
      uAxisThickness: 1.4,
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
