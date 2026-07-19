// =============================================================================
// renderer.ts — the WebGL2 host for the shared GLSL ES renderer.
//
// TypeScript twin of export/Render/OrbitalRenderer.cs (+ its Slice/Volume
// subclasses): same shader-assembly contract (prelude.glsl + common.glsl +
// <view>.frag concatenated as one fragment source), same table textures
// (R32F width×1, NEAREST — lookups are texelFetch + explicit mix, so results
// are bit-comparable with the offline C# host), same uniform semantics
// (documented once, in shaders/common.glsl).
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
import type { PaletteSet } from "./palettes";
import type { Vec3 } from "./vec3";

/** Parameters shared by every render pass — mirror of CommonParams in
 * OrbitalRenderer.cs. View-specific geometry rides in SliceParams /
 * VolumeParams below. */
export interface CommonParams {
  n: number;
  l: number;
  m: number;
  realMode: boolean;
  /** 0 ramp, 1 signed (real mode), 2 phase (complex mode). */
  colorMode: number;
  rampName: string;
  rampSpaceSrgb: boolean;
  gamma: number;
  /** 0: brightness from |ψ|² (density), 1: from |ψ| (amplitude). */
  valueMode: number;
  dither: boolean;
  phaseVivid: boolean;
  phaseChromaPow: number;
}

export interface SliceParams {
  common: CommonParams;
  origin: Vec3;
  axisU: Vec3;
  axisV: Vec3;
}

export interface VolumeParams {
  common: CommonParams;
  camPos: Vec3;
  camRight: Vec3;
  camUp: Vec3;
  camFwd: Vec3;
  fovYDeg: number;
  /** 0 MIP, 1 emission–absorption, 2 shadowed scattering (EA + key light). */
  integrator: number;
  steps: number;
  densityScale: number;
  opacityPow: number;
  emissionGain: number;
  /** 0 linearToSrgb clamp, 1 AgX filmic — EA/scatter output only. */
  tonemap: number;
  /** EV shift (2^EV) on the HDR accumulation before the tonemap. */
  exposureEv: number;
  /** Key-light direction, orbit-camera spherical convention (degrees). */
  lightAzDeg: number;
  lightElDeg: number;
  lightGain: number;
  shadowSteps: number;
  /** Shadow-ray extinction scale, decoupled from densityScale (see shader). */
  shadowDensity: number;
  /** Up to two half-space planes (nx, ny, nz, w): keep n·p + w ≥ 0. */
  clipPlanes: [number, number, number, number][];
}

const MAX_STOPS = 8;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

export class OrbitalRenderer {
  private readonly radialTex = new Map<string, WebGLTexture>();
  private readonly angularTex = new Map<string, WebGLTexture>();
  private readonly phaseCmaxTex: WebGLTexture;

  private constructor(
    readonly gl: WebGL2RenderingContext,
    readonly asset: HorbAsset,
    readonly palettes: PaletteSet,
    private readonly slicePi: twgl.ProgramInfo,
    private readonly volumePi: twgl.ProgramInfo,
  ) {
    this.phaseCmaxTex = this.createTableTexture(palettes.phaseCmax);
  }

  /** Fetch the shared shader sources and compile both view programs. */
  static async create(
    gl: WebGL2RenderingContext,
    asset: HorbAsset,
    palettes: PaletteSet,
    shaderBase: string,
  ): Promise<OrbitalRenderer> {
    const [vert, prelude, common, slice, volume] = await Promise.all(
      ["fullscreen.vert", "prelude.glsl", "common.glsl", "slice.frag", "volume.frag"].map(
        (f) => fetchText(`${shaderBase}/${f}`),
      ),
    );
    const compile = (viewFrag: string) => {
      const pi = twgl.createProgramInfo(gl, [vert, prelude + common + viewFrag]);
      if (!pi) throw new Error("shader compile/link failed (see console)");
      return pi;
    };
    return new OrbitalRenderer(gl, asset, palettes, compile(slice), compile(volume));
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

  /** Everything shared between the two passes — mirror of UploadCommon. */
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

    const ramp = this.palettes.ramps[p.rampName];
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
      uRMax: radial.rMax,
      uM: p.m,
      uRealMode: p.realMode ? 1 : 0,
      uQ999: stats.q999,
      uGamma: p.gamma,
      uValueMode: p.valueMode,
      uRampColor: rampColor,
      uRampPos: rampPos,
      uRampN: ramp.positions.length,
      uRampSpaceSrgb: p.rampSpaceSrgb ? 1 : 0,
      uPhaseL: this.palettes.phaseL,
      uPhaseC: this.palettes.phaseC,
      uPhaseH0: this.palettes.phaseH0,
      uPhaseVivid: p.phaseVivid ? 1 : 0,
      uPhaseChromaPow: p.phaseChromaPow,
      uDitherAmp: p.dither ? 1 / 255 : 0,
      uColorMode: p.colorMode,
    };
  }

  private draw(pi: twgl.ProgramInfo, uniforms: Record<string, unknown>) {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
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
    const clip = new Float32Array(8);
    p.clipPlanes.forEach((c, i) => clip.set(c, 4 * i));
    this.draw(this.volumePi, {
      ...this.commonUniforms(p.common),
      uCamPos: p.camPos,
      uCamRight: p.camRight,
      uCamUp: p.camUp,
      uCamFwd: p.camFwd,
      uTanHalfFov: Math.tan((p.fovYDeg * Math.PI) / 360),
      uAspect: gl.drawingBufferWidth / gl.drawingBufferHeight,
      uIntegrator: p.integrator,
      uSteps: p.steps,
      uDensityScale: p.densityScale,
      uOpacityPow: p.opacityPow,
      uEmissionGain: p.emissionGain,
      uTonemap: p.tonemap,
      uExposure: p.exposureEv,
      uLightDir: (() => {
        const az = (p.lightAzDeg * Math.PI) / 180;
        const el = (p.lightElDeg * Math.PI) / 180;
        return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
      })(),
      uLightGain: p.lightGain,
      uShadowSteps: p.shadowSteps,
      uShadowDensity: p.shadowDensity,
      uClipPlane: clip,
      uClipCount: Math.min(p.clipPlanes.length, 2),
    });
  }
}
