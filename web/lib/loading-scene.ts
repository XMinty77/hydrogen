// =============================================================================
// loading-scene.ts — the loading screen: one scene, one hard-coded shader.
//
// The app cannot draw anything until assets/orbitals.bin (16 MB) has arrived,
// been parsed, and the shared GLSL sources have been fetched and linked. On a
// slow connection that is a long stretch of black. This module fills it with
// the renderer's own picture rather than a spinner: the |1,0,0⟩ + |2,1,0⟩
// superposition under time evolution, isosurface-integrated, pole-on — the URL
//
//   ?state=1,0,0&terms=1,0,0;2,1,0&time=1&mode=real&color=signed&compress=asinh
//   &ramp=custom&rampStops=…&post=1&integrator=iso&shadeModel=ggx&camera=90,89,1.65
//
// rendered from ~7 KB of baked tables (lib/loading-asset.ts) and the shaders
// below — no fetch, no twgl, no palette file, nothing shared with the main
// renderer's load path. It is on screen within the app's first JS chunk.
//
// The shaders are a *specialization*, not a copy, of shaders/common.glsl +
// shaders/volume.frag + shaders/post_*.frag: every parameter of that URL is
// folded in as a GLSL constant (see SCENE below, which names the URL key each
// value came from), and every branch the scene does not take — the other four
// integrators, clip planes, phase/okphase color, the flow layers, MIP/MIDA,
// tonemapping, vignette, grain, aberration — is gone. Two simplifications are
// worth stating because they are exact rather than approximate:
//
//   • Both terms have m = 0, so the azimuthal factor of basisPsi is identically
//     1 and ψ is a pure function of (r, θ): no atan(y, x), no cos/sin(mφ).
//     ψ = Σₖ cₖ · R_{nₖlₖ}(r) · P̄_{lₖ0}(θ), with the cₖ carrying e^{−iEₙt}.
//   • The composite pass drops exposure (0 EV) and contrast (1.0), which are
//     identities for this URL; saturation and vibrance are kept.
//
// Everything else — the √-spaced radial lookup, asinh range compression, the
// signed OKLab ramp with its 250° hue reflection, bisection-refined shells,
// the shadow-ray octave sum, GGX glints, the soft-knee bloom — is the shared
// renderer's arithmetic, line for line, so the loading frame and the loaded
// app show the same image.
// =============================================================================

import { srgbToOklab, type Rgb } from "./color";
import {
  LOADING_ANGULAR_B64,
  LOADING_ANGULAR_WIDTH,
  LOADING_EXTENT,
  LOADING_Q999,
  LOADING_RADIAL_B64,
  LOADING_RADIAL_WIDTH,
  LOADING_RMAX,
  LOADING_TERMS,
} from "./loading-asset";

// ---------------------------------------------------------------------------
// The scene. Each entry names the URL parameter it stands for; values not
// listed here are the app's defaults for that parameter (params.ts).
// ---------------------------------------------------------------------------
const SCENE = {
  // ?time=1&timeScale=4 — atomic units of simulated time per wall-clock
  // second. E₁ − E₂ = 0.375 hartree, so the beat period 2π/ΔE ≈ 16.8 au
  // completes in ≈ 4.2 s: one full breath of the superposition.
  timeScale: 4,
  // ?camera=90,89,1.65 — azimuth, elevation (degrees), distance in framing
  // radii; ?fov=40 (default).
  camAzDeg: 90,
  camElDeg: 89,
  camDist: 1.65,
  fovYDeg: 40,
  // display mapping: ?compress=asinh&compressK=18&compressWhite=5, gamma
  // default 0.71, value = density.
  gamma: 0.71,
  compressK: 18,
  compressWhite: 5,
  // ?integrator=iso — steps default 64; isoLevel/isoCount default 0.5/3.
  steps: 64,
  isoLevel: 0.5,
  isoCount: 3,
  isoSpacing: 0.46,
  isoAlpha: 0.31,
  isoEmission: 2.5,
  isoRim: 0.6,
  isoAmbient: 0.06,
  // ?lightAz=0&lightEl=0&lightGain=1 and the shadow ray the shells cast
  // through the medium (defaults: 24 steps, density 120, 3 octaves).
  lightAzDeg: 0,
  lightElDeg: 0,
  lightGain: 1,
  shadowSteps: 24,
  shadowDensity: 120,
  octaves: 3,
  octaveGain: 0.5,
  octaveExt: 0.4,
  opacityPow: 2.15,
  // ?shadeModel=ggx&shadeSpec=1.5&shadeRough=0.59&shadeF0=0.075&gradDelta=0.007
  shadeSpec: 1.5,
  shadeRough: 0.59,
  shadeF0: 0.075,
  gradDelta: 0.007,
  // ?post=1 — bloom, then grade. Radius/iterations/scale as in the URL.
  bloomThreshold: 0.24,
  bloomKnee: 0.36,
  bloomIntensity: 0.89,
  bloomRadius: 5,
  bloomIterations: 6,
  bloomSaturation: 2,
  postSaturation: 1.1,
  postVibrance: 0.4,
} as const;

/** ?ramp=custom&rampStops=… — sRGB hex at ascending positions. */
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

/** Bound-state energy, hartree — the twin of superposition.ts's energyOf. */
const energyOf = (n: number) => -0.5 / (n * n);

/** Domain ball: the ray marcher stops here, and every term vanishes beyond it. */
const RMAX = Math.max(...LOADING_RMAX);

/** |cₖ|²-weighted display quantile for the normalized (equal-amplitude) sum —
 * superposition.ts's effectiveQ999 with every ampₖ = 1. */
const Q999 = LOADING_Q999.reduce((s, q) => s + q / LOADING_Q999.length, 0);

/** Framing half-extent covering every term (horb.ts's framingRadius, maximized
 * over the terms) — the unit the camera distance is measured in. */
const FRAMING = Math.max(
  ...LOADING_TERMS.map((t) => LOADING_EXTENT.factor * t.n * t.n + LOADING_EXTENT.pad),
);

// ---------------------------------------------------------------------------
// GLSL.
// ---------------------------------------------------------------------------

/** A GLSL float literal (an integer-valued JS number needs the decimal point). */
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

/** The scene's constants, as the shader sees them. */
const sceneConstants = () => {
  const stops = RAMP_STOPS.map(([hex]) => srgbToOklab(hexOf(hex)));
  return `
const float PI = 3.14159265358979;

// --- baked state ---------------------------------------------------------
const float RMAX  = ${f(RMAX)};              // domain ball radius (a₀)
const float RMAX0 = ${f(LOADING_RMAX[0])};   // per-term radial extent
const float RMAX1 = ${f(LOADING_RMAX[1])};
const float Q999  = ${f(Q999)};              // |ψ|² normalization quantile

// --- display mapping -----------------------------------------------------
const float GAMMA          = ${f(SCENE.gamma)};
const float COMPRESS_K     = ${f(SCENE.compressK)};
const float COMPRESS_WHITE = ${f(SCENE.compressWhite)};
const float DITHER_AMP     = 1.0 / 255.0;

// --- the custom ramp, in OKLab (its interpolation space) ------------------
const int RAMP_N = ${stops.length};
const vec3 RAMP_COLOR[${stops.length}] = vec3[${stops.length}](
${stops.map((c) => `    vec3(${c.map(f).join(", ")})`).join(",\n")});
const float RAMP_POS[${stops.length}] = float[${stops.length}](
${RAMP_STOPS.map(([, p]) => `    ${f(p)}`).join(",\n")});

// --- isosurfaces ---------------------------------------------------------
const int   STEPS        = ${SCENE.steps};
const int   ISO_COUNT    = ${SCENE.isoCount};
const float ISO_LEVEL    = ${f(SCENE.isoLevel)};
const float ISO_SPACING  = ${f(SCENE.isoSpacing)};
const float ISO_ALPHA    = ${f(SCENE.isoAlpha)};
const float ISO_EMISSION = ${f(SCENE.isoEmission)};
const float ISO_RIM      = ${f(SCENE.isoRim)};
const float ISO_AMBIENT  = ${f(SCENE.isoAmbient)};

// --- key light + the shadow ray the shells cast --------------------------
const vec3  LIGHT_DIR      = vec3(${lightDir().map(f).join(", ")});
const float LIGHT_GAIN     = ${f(SCENE.lightGain)};
const int   SHADOW_STEPS   = ${SCENE.shadowSteps};
const float SHADOW_DENSITY = ${f(SCENE.shadowDensity)};
const int   OCTAVES        = ${SCENE.octaves};
const float OCTAVE_GAIN    = ${f(SCENE.octaveGain)};
const float OCTAVE_EXT     = ${f(SCENE.octaveExt)};
const float OPACITY_POW    = ${f(SCENE.opacityPow)};

// --- GGX surface response ------------------------------------------------
const float SHADE_SPEC  = ${f(SCENE.shadeSpec)};
const float SHADE_ROUGH = ${f(SCENE.shadeRough)};
const float SHADE_F0    = ${f(SCENE.shadeF0)};
const float GRAD_DELTA  = ${f(SCENE.gradDelta)};
`;
};

/** Isosurface raymarch of the superposition — the scene pass. */
const sceneFragment = () =>
  PRECISION +
  sceneConstants() +
  `
uniform sampler2D uRadialTab;   // R32F ${LOADING_RADIAL_WIDTH}×2: row k = R_{nₖlₖ} in √(r/rMaxₖ)
uniform sampler2D uAngularTab;  // R32F ${LOADING_ANGULAR_WIDTH}×2: row k = P̄_{lₖ0} in θ/π
uniform vec2 uCoef0;            // complex cₖ = e^{−iEₙt}/√2, folded on the CPU
uniform vec2 uCoef1;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;

in vec2 vUv;
out vec4 fragColor;

// Linear interpolation of one table row, texelFetch + explicit mix — the
// lookup contract of shaders/common.glsl.
float lookupRow(sampler2D tab, int row, float t) {
    int n = textureSize(tab, 0).x;
    float x = clamp(t, 0.0, 1.0) * float(n - 1);
    int i0 = min(int(x), n - 2);
    float s = x - float(i0);
    return mix(texelFetch(tab, ivec2(i0, row), 0).r,
               texelFetch(tab, ivec2(i0 + 1, row), 0).r, s);
}

// ψ(p) as (re, im). Both terms have m = 0, so each basis state is the real
// product R·P̄ and the complex coefficient carries the whole time dependence.
vec2 evalPsi(vec3 p) {
    float rc = length(p.xy);
    float r = length(vec2(rc, p.z));
    if (r > RMAX) return vec2(0.0);
    float theta = atan(rc, p.z) / PI;   // two-argument: well-conditioned at the poles
    vec2 acc = vec2(0.0);
    if (r <= RMAX0)
        acc += uCoef0 * (lookupRow(uRadialTab, 0, sqrt(r / RMAX0))
                         * lookupRow(uAngularTab, 0, theta));
    if (r <= RMAX1)
        acc += uCoef1 * (lookupRow(uRadialTab, 1, sqrt(r / RMAX1))
                         * lookupRow(uAngularTab, 1, theta));
    return acc;
}

// |ψ|² → normalized brightness, asinh-compressed with a 5×q999 white point.
float brightnessOf(vec2 psi) {
    float v = dot(psi, psi) / Q999;
    v = asinh(COMPRESS_K * v) / asinh(COMPRESS_K * COMPRESS_WHITE);
    return pow(clamp(v, 0.0, 1.0), GAMMA);
}

float fieldBright(vec3 p) { return brightnessOf(evalPsi(p)); }
float fieldDensity(vec3 p) { vec2 z = evalPsi(p); return dot(z, z); }

// |ψ|² gradient, not the brightness gradient: the level set is the same
// (brightness is monotone in |ψ|²) but the normal comes out clean.
vec3 fieldDensityGradient(vec3 p, float h) {
    vec2 e = vec2(h, 0.0);
    return vec3(fieldDensity(p + e.xyy) - fieldDensity(p - e.xyy),
                fieldDensity(p + e.yxy) - fieldDensity(p - e.yxy),
                fieldDensity(p + e.yyx) - fieldDensity(p - e.yyx)) / (2.0 * h);
}

// --- color: OKLab ramp, signed variant -------------------------------------
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

// Negative lobes reflect the ramp's hue across the 125° OKLab axis (matrix
// [cos 2α, sin 2α; sin 2α, −cos 2α] with 2α = 250°): the dark base is a fixed
// point, so both signs share one background while the structure pairs
// red↔blue and gold↔green.
vec3 rampColorSigned(float t, float sgn) {
    vec3 lab = rampStops(t);
    if (sgn < 0.0)
        lab.yz = vec2(-0.3420201433 * lab.y - 0.9396926208 * lab.z,
                      -0.9396926208 * lab.y + 0.3420201433 * lab.z);
    return linearToSrgb(oklabToLinearSrgb(lab));
}

// The signed mode's emission color in linear RGB. The sRGB round trip is not
// redundant: it applies the gamut clamp the reflected chroma can need.
vec3 emitColorLinear(vec2 psi, float bri) {
    return srgbToLinear(rampColorSigned(bri, psi.x));
}

vec3 rampColorLinear(float t) { return max(oklabToLinearSrgb(rampStops(t)), 0.0); }

// --- key light -------------------------------------------------------------

// Optical depth from p toward the light, over the chord to the domain
// boundary — the shells' self-shadowing through their own medium.
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

// Σ aᵏ exp(−bᵏτ): higher scattering orders as the same light through
// progressively less extinction, normalized so an unshadowed sample returns 1.
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

// GGX + Smith (k = α/2) + Schlick, white — the albedo term of shadeSurface is
// zero for palette-mapped shells, leaving only the glint.
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

// --- isosurfaces -----------------------------------------------------------

// Bisection refinement of a bracketed crossing: 8 halvings on top of the
// marching step, so the shell sits where the analytic field puts it.
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

// Palette-mapped shading: an unlit face sits ISO_AMBIENT up from its shell's
// own level (the cool base color); the key light and the Fresnel rim walk it
// toward the ramp's hot end, so one shell shows the full gradient in the
// palette's own hues instead of washing out under white light.
void shadeIsoHit(vec3 p, vec3 rd, float level, float jitter,
                 inout vec3 accum, inout float transmit) {
    vec2 psi = evalPsi(p);
    vec3 g = fieldDensityGradient(p, max(GRAD_DELTA, 1e-4) * RMAX);
    vec3 N = -normalize(g + 1e-12);   // outward: density falls outward
    vec3 V = -rd;
    if (dot(N, V) < 0.0) N = -N;      // two-sided shells
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

// Interleaved gradient noise (Jimenez), ±half an 8-bit LSB.
vec3 dither(vec3 color, vec2 fragCoord) {
    float ign = fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
    return color + (ign - 0.5) * DITHER_AMP;
}

void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec3 dir = normalize(uCamFwd + uTanHalfFov * (ndc.x * uAspect * uCamRight
                                                  + ndc.y * uCamUp));
    vec3 bgLinear = rampColorLinear(0.0);

    // Ray ∩ domain ball (no clip planes in this scene).
    float b = dot(uCamPos, dir);
    float disc = b * b - (dot(uCamPos, uCamPos) - RMAX * RMAX);
    float sq = sqrt(max(disc, 0.0));
    float t0 = max(-b - sq, 0.0);
    float t1 = -b + sq;
    if (disc <= 0.0 || t1 <= t0) {          // empty ray
        fragColor = vec4(dither(linearToSrgb(bgLinear), gl_FragCoord.xy), 1.0);
        return;
    }
    float dt = (t1 - t0) / float(STEPS);
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy,
                                                vec2(0.06711056, 0.00583715))));

    // Detect every level crossing in each step, refine each by bisection, and
    // shade them in ray order.
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

    // Display transform: 0 EV, no tonemap — the linear clamp.
    vec3 color = linearToSrgb(accum + transmit * bgLinear);
    fragColor = vec4(dither(color, gl_FragCoord.xy), 1.0);
}`;

/** Bright-pass with a quadratic soft knee (post_bloom_extract.frag). */
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

/** Separable nine-tap Gaussian (post_bloom_blur.frag). */
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

/** Screen-composite the bloom, then grade (post_composite.frag, minus the
 * effects this URL leaves at their identity). */
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

// ---------------------------------------------------------------------------
// Host.
// ---------------------------------------------------------------------------

function hexOf(hex: string): Rgb {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

/** Light direction in the camera's spherical convention (renderer.ts's
 * lightDirOf). */
function lightDir(): [number, number, number] {
  const az = (SCENE.lightAzDeg * Math.PI) / 180;
  const el = (SCENE.lightElDeg * Math.PI) / 180;
  return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
}

/** base64 → Float32Array. The tables are little-endian, as is every platform
 * that runs WebGL2. */
function decodeFloats(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** The orbit camera pose (cameras.ts's spherical branch), which is fixed here. */
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
  // right = normalize(fwd × ẑ), up = right × fwd.
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

/** R32F table texture, NEAREST — filtering happens in lookupRow. */
function tableTexture(
  gl: WebGL2RenderingContext,
  values: Float32Array,
  width: number,
  rows: number,
): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, rows, 0, gl.RED, gl.FLOAT, values);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
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

/** Backing-store budget. The loading screen shares the machine with a 16 MB
 * parse and whatever else the page is doing, and the isosurface march is the
 * app's most expensive direct integrator — so cap the pixel count and let the
 * governor below give ground on weak GPUs rather than stuttering. */
const MAX_PIXELS = 1_600_000;
const MIN_SCALE = 0.4;

export interface LoadingScene {
  /** Stop the render loop and release every GL object and the context. */
  dispose(): void;
}

/**
 * Start the loading scene on `canvas`, which must be freshly created: dispose()
 * releases the WebGL2 context, and a canvas whose context has been released
 * cannot get another one. Returns null when WebGL2 (or the shader) is
 * unavailable — the caller should simply show its text fallback; a loading
 * screen must never be the thing that breaks the page.
 */
export function startLoadingScene(canvas: HTMLCanvasElement): LoadingScene | null {
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

    const radialTex = tableTexture(
      gl, decodeFloats(LOADING_RADIAL_B64), LOADING_RADIAL_WIDTH, LOADING_TERMS.length);
    const angularTex = tableTexture(
      gl, decodeFloats(LOADING_ANGULAR_B64), LOADING_ANGULAR_WIDTH, LOADING_TERMS.length);
    objects.push(() => [radialTex, angularTex].forEach((t) => gl.deleteTexture(t)));

    // A vertex array must be bound even though fullscreen.vert reads no
    // attributes (the default VAO is not valid in a core-profile-like context).
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    objects.push(() => gl.deleteVertexArray(vao));

    const u = (p: WebGLProgram, name: string) => gl.getUniformLocation(p, name);
    const uni = {
      radial: u(scenePi, "uRadialTab"),
      angular: u(scenePi, "uAngularTab"),
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

    let targets: [Target, Target, Target] | null = null; // scene, bloom A, bloom B
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
    const norm = 1 / Math.sqrt(LOADING_TERMS.length); // equal amplitudes

    const drawTo = (target: Target | null, w: number, h: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    let simTime = 0;
    let scale = Math.min(devicePixelRatio || 1, 2);
    let emaMs = 0;
    let governAge = 0;
    let last = performance.now();

    const frame = (nowMs: number) => {
      if (disposed) return;
      const dt = Math.min((nowMs - last) / 1000, 0.1);
      last = nowMs;
      simTime += dt * SCENE.timeScale;

      // Quality governor: the same policy as the app's, on a shorter leash.
      emaMs = emaMs === 0 ? dt * 1000 : emaMs * 0.9 + dt * 1000 * 0.1;
      if ((governAge += dt) > 0.4) {
        governAge = 0;
        if (emaMs > 45 && scale > MIN_SCALE) scale = Math.max(MIN_SCALE, scale * 0.8);
      }

      const cssW = canvas.clientWidth || 1;
      const cssH = canvas.clientHeight || 1;
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

      // cₖ(t) = e^{−iEₙt}/√2 — the whole time dependence of the superposition.
      const coef = LOADING_TERMS.map((t) => {
        const phase = -energyOf(t.n) * simTime;
        return [norm * Math.cos(phase), norm * Math.sin(phase)];
      });

      gl.useProgram(scenePi);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, radialTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, angularTex);
      gl.uniform1i(uni.radial, 0);
      gl.uniform1i(uni.angular, 1);
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

      raf = requestAnimationFrame(frame);
    };

    let raf = requestAnimationFrame(frame);
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
