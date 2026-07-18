// ============================================================================
// common.glsl — shared renderer core: ψ evaluation, display mapping, color.
//
// Included (by source concatenation, after prelude.glsl) into every view
// shader — the 2D slice, and later the 3D raymarcher. This file IS the
// renderer's physics and color engine; view shaders only decide which world
// positions to evaluate and how to composite the results.
//
// Numerical contracts (established and certified in lab/, do not break):
//   • ψ is reconstructed from two baked 1D tables + azimuthal trig:
//       ψ = R_nl(r) · P̄_lm(θ) · azimuthal(mφ)
//     worst-case reconstruction error 4.25e-6 of state peak (validation report).
//   • The radial table is indexed by √(r/r_max) — constant oscillation-phase
//     error per texel. The angular table is indexed by θ/π, with θ from
//     two-argument atan — NEVER acos(z/r), whose 1/sinθ error amplification
//     near the poles costs up to 3e-4 of peak (measured).
//   • Table lookups use texelFetch + explicit mix: bit-identical results on
//     desktop GL and WebGL2, no dependence on unspecified filtering precision.
//   • OKLab conversion constants are duplicated in lab/src/color.jl (reference
//     renderer). Any edit here must be mirrored there.
// ============================================================================

const float PI = 3.14159265358979;
const float SQRT2 = 1.41421356237310;

// ---------------------------------------------------------------------------
// State + tables (uploaded by the host from the HORB asset).
// ---------------------------------------------------------------------------
uniform sampler2D uRadialTab;    // R32F, width × 1: R_nl at √-spaced radii
uniform sampler2D uAngularTab;   // R32F, width × 1: P̄_lm at θ-uniform angles
uniform float uRMax;             // radial table extent (a₀); ψ ≡ 0 beyond
uniform int uM;                  // signed magnetic quantum number
uniform bool uRealMode;          // real (textbook) vs complex (CS) harmonics

// ---------------------------------------------------------------------------
// Display mapping (values from the asset's per-state stats + user config).
// ---------------------------------------------------------------------------
uniform float uQ999;             // |ψ|² display-normalization quantile
uniform float uGamma;            // brightening exponent (< 1 lifts faint tails)
uniform int uValueMode;          // 0: density |ψ|², 1: amplitude |ψ|

// ---------------------------------------------------------------------------
// Color (assets/palettes.json → uniforms).
// ---------------------------------------------------------------------------
const int MAX_STOPS = 8;
uniform vec3 uRampColor[MAX_STOPS];  // stop colors: OKLab, or sRGB if uRampSpaceSrgb
uniform float uRampPos[MAX_STOPS];   // stop positions, ascending, in [0,1]
uniform int uRampN;                  // number of active stops
uniform bool uRampSpaceSrgb;         // true: lerp in gamma sRGB (prototype
                                     // reproduction); false: lerp in OKLab
uniform float uPhaseL;               // phase wheel: OKLCH lightness…
uniform float uPhaseC;               // …chroma (inside gamut at every hue)…
uniform float uPhaseH0;              // …and hue of phase 0 (radians)
uniform float uDitherAmp;            // output dither amplitude (1/255 for 8-bit
                                     // targets, 0 for float/16-bit targets)

// ---------------------------------------------------------------------------
// ψ evaluation.
// ---------------------------------------------------------------------------

// Linear interpolation of a 1×N table at normalized coordinate f ∈ [0,1],
// via texelFetch + explicit mix (see contract above).
float lookupTable(sampler2D tab, float f) {
    int n = textureSize(tab, 0).x;
    float x = clamp(f, 0.0, 1.0) * float(n - 1);
    int i0 = min(int(x), n - 2);
    float t = x - float(i0);
    return mix(texelFetch(tab, ivec2(i0, 0), 0).r,
               texelFetch(tab, ivec2(i0 + 1, 0), 0).r, t);
}

// ψ at a world position (Bohr radii), as (re, im). Real mode keeps im = 0.
// This is the Float32 pipeline the validation study certified.
vec2 evalPsi(vec3 p) {
    float rc = length(p.xy);              // cylindrical radius
    float r = length(vec2(rc, p.z));
    if (r > uRMax) return vec2(0.0);

    float R = lookupTable(uRadialTab, sqrt(r / uRMax));
    float theta = atan(rc, p.z);          // polar angle ∈ [0, π], well-conditioned
    float P = lookupTable(uAngularTab, theta / PI);
    float phi = atan(p.y, p.x);           // azimuth ∈ (−π, π]

    int am = uM < 0 ? -uM : uM;
    // (−1)^|m|: cancels the Condon–Shortley phase in real mode (textbook lobe
    // signs); implements Y_{l,−m} = (−1)^m conj(Y_{l,m}) in complex mode.
    float flip = (am % 2 == 1) ? -1.0 : 1.0;

    if (uRealMode) {
        float azim = uM == 0 ? 1.0
                   : uM > 0  ? SQRT2 * flip * cos(float(am) * phi)
                             : SQRT2 * flip * sin(float(am) * phi);
        return vec2(R * P * azim, 0.0);
    } else {
        float sgn = uM < 0 ? flip : 1.0;
        float ang = float(uM) * phi;
        return sgn * R * P * vec2(cos(ang), sin(ang));
    }
}

// ---------------------------------------------------------------------------
// Display mapping: ψ → normalized brightness ∈ [0, 1].
// ---------------------------------------------------------------------------
float brightnessOf(vec2 psi) {
    float d = dot(psi, psi);                      // |ψ|²
    float v = uValueMode == 0 ? d / uQ999 : sqrt(d / uQ999);
    return pow(clamp(v, 0.0, 1.0), uGamma);
}

// ---------------------------------------------------------------------------
// OKLab → sRGB (Björn Ottosson's constants; mirror of lab/src/color.jl).
// ---------------------------------------------------------------------------
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
    return mix(12.92 * c,
               1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
               step(0.0031308, c));
}

vec3 oklabToSrgb(vec3 lab) { return linearToSrgb(oklabToLinearSrgb(lab)); }

// ---------------------------------------------------------------------------
// Palettes.
// ---------------------------------------------------------------------------

// Piecewise-linear ramp lookup in the stops' storage space (OKLab or sRGB).
vec3 rampStops(float t) {
    t = clamp(t, 0.0, 1.0);
    if (t <= uRampPos[0]) return uRampColor[0];
    for (int i = 1; i < uRampN; i++) {
        if (t <= uRampPos[i]) {
            float s = (t - uRampPos[i - 1]) /
                      max(uRampPos[i] - uRampPos[i - 1], 1e-6);
            return mix(uRampColor[i - 1], uRampColor[i], s);
        }
    }
    return uRampColor[uRampN - 1];
}

// Brightness → display sRGB through the ramp.
vec3 rampColor(float t) {
    vec3 c = rampStops(t);
    return uRampSpaceSrgb ? clamp(c, 0.0, 1.0) : oklabToSrgb(c);
}

// Signed variant for real mode: positive lobes take the ramp as-is, negative
// lobes take its chroma complement (a, b negated = 180° hue rotation at
// identical lightness — same perceptual weight, unmistakably distinct).
vec3 rampColorSigned(float t, float sgn) {
    vec3 lab = uRampSpaceSrgb ? vec3(0.0) : rampStops(t);   // sRGB space: no
    if (uRampSpaceSrgb) return rampColor(t);                // signed variant
    if (sgn < 0.0) lab.yz = -lab.yz;
    return oklabToSrgb(lab);
}

// Phase (radians) + brightness → sRGB: a constant-lightness OKLCH hue wheel,
// with the whole Lab vector scaled by brightness so magnitude fades colors to
// the background uniformly (chroma dies with lightness — no garish dark hues).
vec3 phaseColor(float phase, float bright) {
    vec3 lab = vec3(uPhaseL,
                    uPhaseC * cos(phase + uPhaseH0),
                    uPhaseC * sin(phase + uPhaseH0)) * bright;
    return oklabToSrgb(lab);
}

// ---------------------------------------------------------------------------
// Output dithering: interleaved gradient noise (Jimenez), ±half an output LSB.
// Decorrelates quantization error into imperceptible grain, eliminating the
// banding that smooth astronomical gradients otherwise show on 8-bit targets.
// ---------------------------------------------------------------------------
vec3 dither(vec3 color, vec2 fragCoord) {
    float ign = fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
    return color + (ign - 0.5) * uDitherAmp;
}
