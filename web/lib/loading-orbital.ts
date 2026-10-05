/** Live specialization of the archived loading-scene.ts reference.
 * ψ = (exp(-r)/sqrt(π) exp(it/2) + z exp(-r/2)/(4sqrt(2π)) exp(it/8))/sqrt(2).
 * Camera, density surfaces, signed OKLab ramp, lighting and bloom match the
 * reference; the backdrop matches the black page. Direct basis formulas replace
 * the reference's radial/angular lookup tables.
 * At 4 au/s, density repeats after 4π/3 seconds; the signed color+geometry
 * cycle needs 4π seconds. Do not reduce this to a density-only breathing loop.
 * A fixed 256² pixel budget limits work, independently of display resolution.
 * Runs on an HTML canvas for immediate first draw or an OffscreenCanvas worker.
 */
import { srgbToOklab, type Rgb } from "./color";
import {
  LOADING_EXTENT,
  LOADING_Q999,
  LOADING_RMAX,
  LOADING_TERMS,
} from "./loading-asset";

const SCENE = {
  timeScale: 4,

  camAzDeg: 90,
  camElDeg: 89,
  camDist: 1.65,
  fovYDeg: 40,

  gamma: 0.71,
  compressK: 18,
  compressWhite: 5,

  steps: 64,
  isoLevel: 0.5,
  isoCount: 3,
  isoSpacing: 0.46,
  isoAlpha: 0.31,
  isoEmission: 2.5,
  isoRim: 0.6,
  isoAmbient: 0.06,

  lightAzDeg: 0,
  lightElDeg: 0,
  lightGain: 1,
  shadowSteps: 24,
  shadowDensity: 120,
  octaves: 3,
  octaveGain: 0.5,
  octaveExt: 0.4,
  opacityPow: 2.15,

  shadeSpec: 1.5,
  shadeRough: 0.59,
  shadeF0: 0.075,
  gradDelta: 0.007,

  bloomThreshold: 0.24,
  bloomKnee: 0.36,
  bloomIntensity: 0.89,
  bloomRadius: 5,
  bloomIterations: 6,
  bloomSaturation: 2,
  postSaturation: 1.1,
  postVibrance: 0.4,
} as const;

/** The confirmed reference ramp; hue reflection is applied by sign of Re ψ. */
const RAMP_STOPS: [string, number][] = [
  ["#0b0513", 0],
  ["#310b4d", 0.143],
  ["#67186b", 0.286],
  ["#a42e6c", 0.429],
  ["#e14d38", 0.504],
  ["#f98b28", 0.534],
  ["#ffc952", 0.607],
  ["#fffbe0", 0.664],
];

const energyOf = (n: number) => -0.5 / (n * n);

const RMAX = Math.max(...LOADING_RMAX);

const Q999 = LOADING_Q999.reduce((s, q) => s + q / LOADING_Q999.length, 0);

const FRAMING = Math.max(
  ...LOADING_TERMS.map((t) => LOADING_EXTENT.factor * t.n * t.n + LOADING_EXTENT.pad),
);

const f = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));

const VERT = `#version 300 es
out vec2 vUv;
void main() {
    vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
    vUv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
}`;

const PRECISION = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const sceneConstants = () => {
  const stops = RAMP_STOPS.map(([hex]) => srgbToOklab(hexOf(hex)));
  return `
const float PI = 3.14159265358979;

const float RMAX  = ${f(RMAX)};
const float RMAX0 = ${f(LOADING_RMAX[0])};
const float RMAX1 = ${f(LOADING_RMAX[1])};
const float Q999  = ${f(Q999)};

const float GAMMA          = ${f(SCENE.gamma)};
const float COMPRESS_K     = ${f(SCENE.compressK)};
const float COMPRESS_WHITE = ${f(SCENE.compressWhite)};
const float DITHER_AMP     = 1.0 / 255.0;

const int RAMP_N = ${stops.length};
const vec3 RAMP_COLOR[${stops.length}] = vec3[${stops.length}](
${stops.map((c) => `    vec3(${c.map(f).join(", ")})`).join(",\n")});
const float RAMP_POS[${stops.length}] = float[${stops.length}](
${RAMP_STOPS.map(([, p]) => `    ${f(p)}`).join(",\n")});

const int   STEPS        = ${SCENE.steps};
const int   ISO_COUNT    = ${SCENE.isoCount};
const float ISO_LEVEL    = ${f(SCENE.isoLevel)};
const float ISO_SPACING  = ${f(SCENE.isoSpacing)};
const float ISO_ALPHA    = ${f(SCENE.isoAlpha)};
const float ISO_EMISSION = ${f(SCENE.isoEmission)};
const float ISO_RIM      = ${f(SCENE.isoRim)};
const float ISO_AMBIENT  = ${f(SCENE.isoAmbient)};

const vec3  LIGHT_DIR      = vec3(${lightDir().map(f).join(", ")});
const float LIGHT_GAIN     = ${f(SCENE.lightGain)};
const int   SHADOW_STEPS   = ${SCENE.shadowSteps};
const float SHADOW_DENSITY = ${f(SCENE.shadowDensity)};
const int   OCTAVES        = ${SCENE.octaves};
const float OCTAVE_GAIN    = ${f(SCENE.octaveGain)};
const float OCTAVE_EXT     = ${f(SCENE.octaveExt)};
const float OPACITY_POW    = ${f(SCENE.opacityPow)};

const float SHADE_SPEC  = ${f(SCENE.shadeSpec)};
const float SHADE_ROUGH = ${f(SCENE.shadeRough)};
const float SHADE_F0    = ${f(SCENE.shadeF0)};
const float GRAD_DELTA  = ${f(SCENE.gradDelta)};
`;
};

const sceneFragment = () =>
  PRECISION +
  sceneConstants() +
  `
uniform vec2 uCoef0;
uniform vec2 uCoef1;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;

in vec2 vUv;
out vec4 fragColor;

// Normalized hydrogenic 1s and 2p0 basis functions (Bohr radii).
// Retain the reference domain truncations at each term's baked RMAX.
vec2 evalPsi(vec3 p) {
    float r = length(p);
    if (r > RMAX) return vec2(0.0);
    float e = exp(-0.5 * r);
    float a = r <= RMAX0 ? 0.5641895835477563 * e * e : 0.0;
    float b = r <= RMAX1 ? 0.09973557010035818 * p.z * e : 0.0;
    return uCoef0 * a + uCoef1 * b;
}

float brightnessOf(vec2 psi) {
    float v = dot(psi, psi) / Q999;
    v = asinh(COMPRESS_K * v) / asinh(COMPRESS_K * COMPRESS_WHITE);
    return pow(clamp(v, 0.0, 1.0), GAMMA);
}

float fieldBright(vec3 p) { return brightnessOf(evalPsi(p)); }
float fieldDensity(vec3 p) { vec2 z = evalPsi(p); return dot(z, z); }

vec3 fieldDensityGradient(vec3 p, float h) {
    vec2 e = vec2(h, 0.0);
    return vec3(fieldDensity(p + e.xyy) - fieldDensity(p - e.xyy),
                fieldDensity(p + e.yxy) - fieldDensity(p - e.yxy),
                fieldDensity(p + e.yyx) - fieldDensity(p - e.yyx)) / (2.0 * h);
}

vec3 oklabToLinearSrgb(vec3 lab) {
    vec3 lms_ = vec3(lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z,
                     lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z,
                     lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z);
    vec3 lms = lms_ * lms_ * lms_;
    return vec3( 4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
                -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
                -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.7076147010 * lms.z);
}

vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
               step(0.0031308, c));
}

vec3 srgbToLinear(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 rampStops(float t) {
    t = clamp(t, 0.0, 1.0);
    if (t <= RAMP_POS[0]) return RAMP_COLOR[0];
    for (int i = 1; i < RAMP_N; i++) {
        if (t <= RAMP_POS[i]) {
            float s = (t - RAMP_POS[i - 1]) /
                      max(RAMP_POS[i] - RAMP_POS[i - 1], 1e-6);
            return mix(RAMP_COLOR[i - 1], RAMP_COLOR[i], s);
        }
    }
    return RAMP_COLOR[RAMP_N - 1];
}

vec3 rampColorSigned(float t, float sgn) {
    vec3 lab = rampStops(t);
    if (sgn < 0.0)
        lab.yz = vec2(-0.3420201433 * lab.y - 0.9396926208 * lab.z,
                      -0.9396926208 * lab.y + 0.3420201433 * lab.z);
    return linearToSrgb(oklabToLinearSrgb(lab));
}

vec3 emitColorLinear(vec2 psi, float bri) {
    return srgbToLinear(rampColorSigned(bri, psi.x));
}

vec3 rampColorLinear(float t) { return max(oklabToLinearSrgb(rampStops(t)), 0.0); }

float lightOpticalDepth(vec3 p, float jitter) {
    float b = dot(p, LIGHT_DIR);
    float disc = b * b - (dot(p, p) - RMAX * RMAX);
    if (disc <= 0.0) return 0.0;
    float tExit = -b + sqrt(disc);
    if (tExit <= 0.0) return 0.0;
    float ds = tExit / float(SHADOW_STEPS);
    float tau = 0.0;
    for (int i = 0; i < SHADOW_STEPS; i++) {
        vec3 q = p + (float(i) + jitter) * ds * LIGHT_DIR;
        tau += pow(fieldBright(q), OPACITY_POW) * ds;
    }
    return SHADOW_DENSITY * tau / RMAX;
}

float multiScatterShadow(float tau) {
    float sum = 0.0, norm = 0.0, a = 1.0, b = 1.0;
    for (int k = 0; k < OCTAVES; k++) {
        sum += a * exp(-b * tau);
        norm += a;
        a *= OCTAVE_GAIN;
        b *= OCTAVE_EXT;
    }
    return sum / norm;
}

float fresnelSchlick(float cosT, float F0) {
    return F0 + (1.0 - F0) * pow(clamp(1.0 - cosT, 0.0, 1.0), 5.0);
}

vec3 shadeSpecular(vec3 N, vec3 V, vec3 L) {
    float ndl = max(dot(N, L), 0.0);
    vec3 H = normalize(V + L);
    float ndh = max(dot(N, H), 0.0);
    float fr = fresnelSchlick(max(dot(H, V), 0.0), SHADE_F0);
    float a = max(SHADE_ROUGH * SHADE_ROUGH, 1e-3);
    float a2 = a * a;
    float den = ndh * ndh * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * den * den);
    float ndv = max(dot(N, V), 1e-3);
    float k = a * 0.5;
    float G = (ndv / (ndv * (1.0 - k) + k)) * (ndl / (ndl * (1.0 - k) + k));
    return vec3(SHADE_SPEC * fr * D * G / max(4.0 * ndv, 1e-3));
}

float refineHit(vec3 ro, vec3 rd, float ta, float tb, float level) {
    float fa = fieldBright(ro + ta * rd) - level;
    for (int i = 0; i < 8; i++) {
        float tm = 0.5 * (ta + tb);
        float fm = fieldBright(ro + tm * rd) - level;
        if ((fm < 0.0) == (fa < 0.0)) { ta = tm; fa = fm; }
        else tb = tm;
    }
    return 0.5 * (ta + tb);
}

void shadeIsoHit(vec3 p, vec3 rd, float level, float jitter,
                 inout vec3 accum, inout float transmit) {
    vec2 psi = evalPsi(p);
    vec3 g = fieldDensityGradient(p, max(GRAD_DELTA, 1e-4) * RMAX);
    vec3 N = -normalize(g + 1e-12);
    vec3 V = -rd;
    if (dot(N, V) < 0.0) N = -N;
    float ndv = max(dot(N, V), 0.0);
    float ndl = max(dot(N, LIGHT_DIR), 0.0);
    float sh = multiScatterShadow(lightOpticalDepth(p, jitter));
    float rim = ISO_RIM * pow(1.0 - ndv, 3.0);
    float w = clamp(ISO_AMBIENT + ndl * sh + rim, 0.0, 1.0);
    vec3 emit = emitColorLinear(psi, mix(level, 1.0, w));
    vec3 c = ISO_EMISSION * emit + LIGHT_GAIN * sh * shadeSpecular(N, V, LIGHT_DIR);
    accum += transmit * ISO_ALPHA * c;
    transmit *= 1.0 - ISO_ALPHA;
}

vec3 dither(vec3 color, vec2 fragCoord) {
    float ign = fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
    return color + (ign - 0.5) * DITHER_AMP;
}

void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec3 dir = normalize(uCamFwd + uTanHalfFov * (ndc.x * uAspect * uCamRight
                                                  + ndc.y * uCamUp));
    // Match the page backdrop independently of the orbital's signed palette.
    vec3 bgLinear = vec3(0.0);

    float b = dot(uCamPos, dir);
    float disc = b * b - (dot(uCamPos, uCamPos) - RMAX * RMAX);
    float sq = sqrt(max(disc, 0.0));
    float t0 = max(-b - sq, 0.0);
    float t1 = -b + sq;
    if (disc <= 0.0 || t1 <= t0) {
        fragColor = vec4(dither(linearToSrgb(bgLinear), gl_FragCoord.xy), 1.0);
        return;
    }
    float dt = (t1 - t0) / float(STEPS);
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy,
                                                vec2(0.06711056, 0.00583715))));

    vec3 accum = vec3(0.0);
    float transmit = 1.0;
    float tPrev = t0;
    float fPrev = fieldBright(uCamPos + tPrev * dir);
    for (int i = 1; i <= STEPS; i++) {
        float t = t0 + float(i) * dt;
        float fCur = fieldBright(uCamPos + t * dir);

        float hitT[ISO_COUNT];
        float hitL[ISO_COUNT];
        int nHits = 0;
        float level = ISO_LEVEL;
        for (int k = 0; k < ISO_COUNT; k++) {
            if ((fPrev - level) * (fCur - level) < 0.0) {
                float tEst = tPrev + dt * (level - fPrev) / (fCur - fPrev);
                int j = nHits;
                for (; j > 0 && hitT[j - 1] > tEst; j--) {
                    hitT[j] = hitT[j - 1];
                    hitL[j] = hitL[j - 1];
                }
                hitT[j] = tEst;
                hitL[j] = level;
                nHits++;
            }
            level *= ISO_SPACING;
        }
        for (int j = 0; j < nHits; j++) {
            float th = refineHit(uCamPos, dir, tPrev, t, hitL[j]);
            shadeIsoHit(uCamPos + th * dir, dir, hitL[j], jitter, accum, transmit);
        }
        if (transmit < 0.004) break;
        tPrev = t;
        fPrev = fCur;
    }

    vec3 color = linearToSrgb(accum + transmit * bgLinear);
    fragColor = vec4(dither(color, gl_FragCoord.xy), 1.0);
}`;

const extractFragment = () =>
  PRECISION +
  `
const float THRESHOLD  = ${f(SCENE.bloomThreshold)};
const float KNEE       = ${f(SCENE.bloomKnee)};
const float SATURATION = ${f(SCENE.bloomSaturation)};

uniform sampler2D uScene;
in vec2 vUv;
out vec4 fragColor;

void main() {
    vec3 c = max(texture(uScene, vUv).rgb, 0.0);
    float peak = max(c.r, max(c.g, c.b));
    float knee = max(THRESHOLD * KNEE, 1e-5);
    float soft = clamp(peak - THRESHOLD + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-5);
    float contribution = max(peak - THRESHOLD, soft) / max(peak, 1e-5);
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    fragColor = vec4(mix(vec3(luma), c, SATURATION) * contribution, 1.0);
}`;

const blurFragment = () =>
  PRECISION +
  `
uniform sampler2D uSource;
uniform vec2 uDirection;
in vec2 vUv;
out vec4 fragColor;

void main() {
    vec3 c = texture(uSource, vUv).rgb * 0.2270270270;
    c += texture(uSource, vUv + uDirection * 1.3846153846).rgb * 0.3162162162;
    c += texture(uSource, vUv - uDirection * 1.3846153846).rgb * 0.3162162162;
    c += texture(uSource, vUv + uDirection * 3.2307692308).rgb * 0.0702702703;
    c += texture(uSource, vUv - uDirection * 3.2307692308).rgb * 0.0702702703;
    fragColor = vec4(c, 1.0);
}`;

const compositeFragment = () =>
  PRECISION +
  `
const float BLOOM_INTENSITY = ${f(SCENE.bloomIntensity)};
const float SATURATION      = ${f(SCENE.postSaturation)};
const float VIBRANCE        = ${f(SCENE.postVibrance)};

uniform sampler2D uScene;
uniform sampler2D uBloom;
in vec2 vUv;
out vec4 fragColor;

void main() {
    vec3 scene = texture(uScene, vUv).rgb;
    vec3 bloom = max(texture(uBloom, vUv).rgb, 0.0) * BLOOM_INTENSITY;
    vec3 c = 1.0 - (1.0 - scene) * (1.0 - clamp(bloom, 0.0, 1.0));
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(luma), c, SATURATION);
    float range = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    c = mix(vec3(luma), c, 1.0 + VIBRANCE * (1.0 - clamp(range, 0.0, 1.0)));
    fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function hexOf(hex: string): Rgb {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

function lightDir(): [number, number, number] {
  const az = (SCENE.lightAzDeg * Math.PI) / 180;
  const el = (SCENE.lightElDeg * Math.PI) / 180;
  return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
}

function cameraPose() {
  const az = (SCENE.camAzDeg * Math.PI) / 180;
  const el = (SCENE.camElDeg * Math.PI) / 180;
  const d = SCENE.camDist * FRAMING;
  const pos: [number, number, number] = [
    d * Math.cos(el) * Math.cos(az),
    d * Math.cos(el) * Math.sin(az),
    d * Math.sin(el),
  ];
  const len = Math.hypot(...pos);
  const fwd: [number, number, number] = [-pos[0] / len, -pos[1] / len, -pos[2] / len];

  const rx = fwd[1], ry = -fwd[0];
  const rl = Math.hypot(rx, ry);
  const right: [number, number, number] = [rx / rl, ry / rl, 0];
  const up: [number, number, number] = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  return { pos, right, up, fwd };
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error(`loading shader: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}

function link(gl: WebGL2RenderingContext, vert: WebGLShader, fragSrc: string) {
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram()!;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(`loading program: ${gl.getProgramInfoLog(program)}`);
  return program;
}

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
}

function makeTarget(gl: WebGL2RenderingContext, w: number, h: number): Target {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex };
}

// This is a loader budget, independent of the main viewer and screen DPR.
const MAX_PIXELS = 65_536;
const MIN_SCALE = 0.4;

export interface LoadingScene {
  dispose(): void;
}

export function startLoadingScene(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  epoch: number,
  animate = true,
): LoadingScene | null {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl || gl.isContextLost()) return null;

  let disposed = false;
  const objects: (() => void)[] = [];

  try {
    const vert = compile(gl, gl.VERTEX_SHADER, VERT);
    const scenePi = link(gl, vert, sceneFragment());
    const extractPi = link(gl, vert, extractFragment());
    const blurPi = link(gl, vert, blurFragment());
    const compositePi = link(gl, vert, compositeFragment());
    gl.deleteShader(vert);
    objects.push(() => [scenePi, extractPi, blurPi, compositePi]
      .forEach((p) => gl.deleteProgram(p)));

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    objects.push(() => gl.deleteVertexArray(vao));

    const u = (p: WebGLProgram, name: string) => gl.getUniformLocation(p, name);
    const uni = {
      coef0: u(scenePi, "uCoef0"),
      coef1: u(scenePi, "uCoef1"),
      camPos: u(scenePi, "uCamPos"),
      camRight: u(scenePi, "uCamRight"),
      camUp: u(scenePi, "uCamUp"),
      camFwd: u(scenePi, "uCamFwd"),
      tanHalfFov: u(scenePi, "uTanHalfFov"),
      aspect: u(scenePi, "uAspect"),
      extractScene: u(extractPi, "uScene"),
      blurSource: u(blurPi, "uSource"),
      blurDirection: u(blurPi, "uDirection"),
      compositeScene: u(compositePi, "uScene"),
      compositeBloom: u(compositePi, "uBloom"),
    };

    let targets: [Target, Target, Target] | null = null;
    let width = 0;
    let height = 0;
    const releaseTargets = () => {
      if (!targets) return;
      for (const t of targets) {
        gl.deleteFramebuffer(t.fbo);
        gl.deleteTexture(t.tex);
      }
      targets = null;
    };
    objects.push(releaseTargets);

    const pose = cameraPose();
    const tanHalfFov = Math.tan((SCENE.fovYDeg * Math.PI) / 360);
    const norm = 1 / Math.sqrt(LOADING_TERMS.length);

    const drawTo = (target: Target | null, w: number, h: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // Absolute phase keeps bootstrap and worker synchronized at handoff.
    let simTime = 0;
    let scale = Math.min(globalThis.devicePixelRatio || 1, 2);
    let emaMs = 0;
    let governAge = 0;
    let last = performance.now();

    const frame = (nowMs: number) => {
      if (disposed || gl.isContextLost()) return;
      const dt = Math.min((nowMs - last) / 1000, 0.1);
      last = nowMs;
      simTime = (performance.timeOrigin + nowMs - epoch) * SCENE.timeScale / 1000;

      emaMs = emaMs === 0 ? dt * 1000 : emaMs * 0.9 + dt * 1000 * 0.1;
      if ((governAge += dt) > 0.4) {
        governAge = 0;
        if (emaMs > 45 && scale > MIN_SCALE) scale = Math.max(MIN_SCALE, scale * 0.8);
      }

      const cssW = ("clientWidth" in canvas ? canvas.clientWidth : 0) || 256;
      const cssH = ("clientHeight" in canvas ? canvas.clientHeight : 0) || 256;
      let w = Math.max(16, Math.round(cssW * scale));
      let h = Math.max(16, Math.round(cssH * scale));
      const over = Math.sqrt(MAX_PIXELS / (w * h));
      if (over < 1) {
        w = Math.max(16, Math.round(w * over));
        h = Math.max(16, Math.round(h * over));
      }
      if (w !== width || h !== height) {
        canvas.width = w;
        canvas.height = h;
        width = w;
        height = h;
        releaseTargets();
        targets = [makeTarget(gl, w, h), makeTarget(gl, w, h), makeTarget(gl, w, h)];
      }
      const [sceneT, bloomA, bloomB] = targets!;

      const coef = LOADING_TERMS.map((t) => {
        const phase = -energyOf(t.n) * simTime;
        return [norm * Math.cos(phase), norm * Math.sin(phase)];
      });

      gl.useProgram(scenePi);
      gl.uniform2f(uni.coef0, coef[0][0], coef[0][1]);
      gl.uniform2f(uni.coef1, coef[1][0], coef[1][1]);
      gl.uniform3fv(uni.camPos, pose.pos);
      gl.uniform3fv(uni.camRight, pose.right);
      gl.uniform3fv(uni.camUp, pose.up);
      gl.uniform3fv(uni.camFwd, pose.fwd);
      gl.uniform1f(uni.tanHalfFov, tanHalfFov);
      gl.uniform1f(uni.aspect, w / h);
      drawTo(sceneT, w, h);

      gl.useProgram(extractPi);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneT.tex);
      gl.uniform1i(uni.extractScene, 0);
      drawTo(bloomA, w, h);

      gl.useProgram(blurPi);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(uni.blurSource, 0);
      for (let i = 0; i < SCENE.bloomIterations; i++) {
        gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
        gl.uniform2f(uni.blurDirection, SCENE.bloomRadius / w, 0);
        drawTo(bloomB, w, h);
        gl.bindTexture(gl.TEXTURE_2D, bloomB.tex);
        gl.uniform2f(uni.blurDirection, 0, SCENE.bloomRadius / h);
        drawTo(bloomA, w, h);
      }

      gl.useProgram(compositePi);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneT.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
      gl.uniform1i(uni.compositeScene, 0);
      gl.uniform1i(uni.compositeBloom, 1);
      drawTo(null, w, h);

      raf = animate ? requestAnimationFrame(frame) : 0;
    };

    let raf = 0; frame(performance.now());
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        cancelAnimationFrame(raf);
        objects.forEach((release) => release());
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      },
    };
  } catch (err) {
    console.warn("loading scene unavailable:", err);
    objects.forEach((release) => release());
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  }
}
