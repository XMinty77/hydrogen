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
uniform bool uPhaseVivid;            // true: per-hue max chroma (uPhaseCmaxTab)
                                     // instead of the constant uPhaseC
uniform sampler2D uPhaseCmaxTab;     // R32F 257×1: max sRGB chroma per hue at
                                     // uPhaseL; last texel repeats the first
                                     // so clamped lookup acts cyclic
uniform float uPhaseChromaPow;       // chroma fades as brightᵖᵒʷ (1 = with the
                                     // lightness — exactly gamut-safe; < 1 =
                                     // saturation persists into dark regions,
                                     // relying on the final gamut clamp)
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

// Inverse transfer, for compositing gamma-encoded palette colors in linear RGB.
vec3 srgbToLinear(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c / 12.92,
               pow((c + 0.055) / 1.055, vec3(2.4)),
               step(0.04045, c));
}

// ---------------------------------------------------------------------------
// AgX display transform (Troy Sobotka's AgX; the minimal-fit port after
// Benjamin Wrensch/iolite). Maps linear-sRGB HDR to display-referred sRGB
// with filmic highlight rolloff — the optional alternative (uTonemap = 1 in
// volume.frag) to linearToSrgb's hard clamp, which flattens bright volumetric
// cores into edged white discs. The sigmoid runs in a log2 encoding spanning
// [-12.47, +4.03] EV, so multi-stop HDR accumulations compress gracefully.
// ---------------------------------------------------------------------------

// 6th-order fit of the default AgX contrast sigmoid.
vec3 agxContrast(vec3 x) {
    vec3 x2 = x * x;
    vec3 x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
         - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agxDisplay(vec3 lin) {
    const mat3 inset = mat3(       // "inset" gamut compression (column-major)
        0.842479062253094, 0.0423282422610123, 0.0423756549057051,
        0.0784335999999992, 0.878468636469772, 0.0784336,
        0.0792237451477643, 0.0791661274605434, 0.879142973793104);
    const mat3 outset = mat3(      // inverse inset, applied post-sigmoid
        1.19687900512017, -0.0528968517574562, -0.0529716355144438,
        -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
        -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
    const float minEv = -12.47393;
    const float maxEv = 4.026069;
    vec3 v = inset * max(lin, 1e-10);
    v = (clamp(log2(v), minEv, maxEv) - minEv) / (maxEv - minEv);
    // The sigmoid's output approximates 2.2-encoded display values, so after
    // the outset no further sRGB encode is applied (we write to a plain RGBA8
    // target, not an sRGB framebuffer).
    return clamp(outset * agxContrast(v), 0.0, 1.0);
}

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

// Signed variant for real mode: positive lobes take the ramp as-is; negative
// lobes reflect its hue across the 125° OKLab axis. That axis is chosen so
// the ramp's dark-purple base (305°) is a fixed point — both signs share one
// background — while the bright structure maps red→blue and gold→green, the
// intuitive "cool inverse of hot" pairing (user-tuned 2026-07-19). Lightness
// is untouched, so perceptual weight stays identical; reflected chroma can
// exceed the sRGB gamut in the cyan-blue region and relies on the final RGB
// clamp, exactly as (and measurably less than) the previous complement did.
// Matrix is [cos 2α, sin 2α; sin 2α, −cos 2α] with 2α = 250°.
// REVERT to the previous chroma complement (180° rotation) by replacing the
// reflection with:  lab.yz = -lab.yz;   (mirror lab/scripts/render_reference.jl!)
vec3 rampColorSigned(float t, float sgn) {
    vec3 lab = uRampSpaceSrgb ? vec3(0.0) : rampStops(t);   // sRGB space: no
    if (uRampSpaceSrgb) return rampColor(t);                // signed variant
    if (sgn < 0.0)
        lab.yz = vec2(-0.3420201433 * lab.y - 0.9396926208 * lab.z,
                      -0.9396926208 * lab.y + 0.3420201433 * lab.z);
    return oklabToSrgb(lab);
}

// Phase (radians) + brightness → sRGB: a constant-lightness OKLCH hue wheel.
// Lightness scales with brightness; chroma scales with brightᵘᴾʰᵃˢᵉᶜʰʳᵒᵐᵃᴾᵒʷ.
// At pow = 1 the whole Lab vector scales together, which is *exactly*
// gamut-preserving (linear RGB scales by the cube); at pow < 1 saturation
// lingers in dark regions and the final clamp absorbs mild excursions.
vec3 phaseColor(float phase, float bright) {
    float hue = phase + uPhaseH0;
    float C = uPhaseVivid
        ? lookupTable(uPhaseCmaxTab, fract(hue / (2.0 * PI)))
        : uPhaseC;
    C *= pow(bright, uPhaseChromaPow);
    vec3 lab = vec3(uPhaseL * bright, C * cos(hue), C * sin(hue));
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
