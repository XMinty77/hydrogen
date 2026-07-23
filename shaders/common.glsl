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
uniform float uRMax;             // radial table extent (a₀); ψ ≡ 0 beyond.
                                 // Superpositions: max over the terms' extents
                                 // (the domain ball must cover every term).
uniform int uM;                  // signed magnetic quantum number
uniform bool uRealMode;          // real (textbook) vs complex (CS) harmonics

// ---------------------------------------------------------------------------
// Superposition: ψ = Σₖ cₖ · ψ_{nₖlₖmₖ}, up to MAX_TERMS terms.
//
// Each term's radial/angular table occupies one ROW of a 2D texture (all
// radial tables share one width, likewise angular — fixed by the HORB format),
// so a term lookup is the same texelFetch+mix as the single-state path, just
// with a row index. The complex coefficients cₖ carry everything per-frame:
// user amplitude·e^{iφ₀}, the optional time factor e^{−iEₙt} (folded in on the
// CPU — time evolution costs the shader nothing), and normalization.
//
// uSupCount = 0 selects the certified single-state path below. It is also the
// safe default for hosts that omit these uniforms because GL initializes them
// to zero.
// ---------------------------------------------------------------------------
const int MAX_TERMS = 8;
uniform int uSupCount;                 // 0: single state; 1..MAX_TERMS: superpose
uniform sampler2D uSupRadialTab;       // R32F, width × MAX_TERMS: row k = R_{nₖlₖ}
uniform sampler2D uSupAngularTab;      // R32F, width × MAX_TERMS: row k = P̄_{lₖmₖ}
uniform float uSupRMax[MAX_TERMS];     // per-term radial extent (ψₖ ≡ 0 beyond)
uniform int   uSupM[MAX_TERMS];        // per-term signed m
uniform vec2  uSupCoef[MAX_TERMS];     // per-term complex coefficient (re, im)

// ---------------------------------------------------------------------------
// Display mapping (values from the asset's per-state stats + user config).
// ---------------------------------------------------------------------------
uniform float uQ999;             // |ψ|² display-normalization quantile
uniform float uGamma;            // brightening exponent (< 1 lifts faint tails)
uniform int uValueMode;          // 0: density |ψ|², 1: amplitude |ψ|
uniform int uCompressMode;       // extra range compression applied to the
                                 // normalized value BEFORE the gamma pow —
                                 // 0 off (the certified default), 1 log:
                                 // log(1+k·v)/log(1+k), 2 asinh:
                                 // asinh(k·v)/asinh(k). Both are exact
                                 // identities at k→0 and approach a hard
                                 // logarithmic lift as k grows; designed for
                                 // integrators that key on *value ordering*
                                 // (MIDA) or need faint-tail structure
                                 // without the gamma pow's slope blowup at 0.
uniform float uCompressK;        // compression strength k (≈1 subtle, ≫1 hard)
uniform float uCompressWhite;    // HDR white point, in multiples of q999: the
                                 // value that maps to full brightness. The
                                 // inner cores of the lobes overshoot q999 by
                                 // large factors (|ψ|² there is many times the
                                 // 99.9th percentile), so with the default
                                 // white point they all clamp to 1.0 and
                                 // collapse to a single ramp color. Raising the
                                 // white point (best paired with a log/asinh
                                 // compressMode) maps that HDR core back into
                                 // the ramp so the interior reveals its
                                 // gradient. 0 ⇒ 1 (disabled): the value hosts
                                 // that never set this uniform get, so the
                                 // certified single-state pipeline is unchanged.

// ---------------------------------------------------------------------------
// Color (assets/palettes.json → uniforms).
// ---------------------------------------------------------------------------
const int MAX_STOPS = 8;
uniform vec3 uRampColor[MAX_STOPS];  // stop colors: OKLab, or sRGB if uRampSpaceSrgb
uniform float uRampPos[MAX_STOPS];   // stop positions, ascending, in [0,1]
uniform int uRampN;                  // number of active stops
uniform bool uRampSpaceSrgb;         // true: lerp in gamma sRGB; false: OKLab
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

// Linear interpolation of row `row` of a table texture at normalized
// coordinate f ∈ [0,1], via texelFetch + explicit mix (see contract above).
float lookupTableRow(sampler2D tab, int row, float f) {
    int n = textureSize(tab, 0).x;
    float x = clamp(f, 0.0, 1.0) * float(n - 1);
    int i0 = min(int(x), n - 2);
    float t = x - float(i0);
    return mix(texelFetch(tab, ivec2(i0, row), 0).r,
               texelFetch(tab, ivec2(i0 + 1, row), 0).r, t);
}

// Single-row (width × 1) tables — the certified single-state lookup.
float lookupTable(sampler2D tab, float f) { return lookupTableRow(tab, 0, f); }

// One basis state ψ_{nlm} at (r-dependent lookups already done): the azimuthal
// factor applied per mode. Shared by the single-state and superposition paths
// so their per-term arithmetic is literally the same code.
//   real mode:    ψ = R·P̄·{1, √2(−1)^m cos(mφ), √2(−1)^m sin(|m|φ)},  im = 0
//   complex mode: ψ = (−1)^m-adjusted R·P̄·e^{imφ}  (Y_{l,−m} = (−1)^m Y*_{l,m})
vec2 basisPsi(float R, float P, int m, float phi) {
    int am = m < 0 ? -m : m;
    // (−1)^|m|: cancels the Condon–Shortley phase in real mode (textbook lobe
    // signs); implements Y_{l,−m} = (−1)^m conj(Y_{l,m}) in complex mode.
    float flip = (am % 2 == 1) ? -1.0 : 1.0;
    if (uRealMode) {
        float azim = m == 0 ? 1.0
                   : m > 0  ? SQRT2 * flip * cos(float(am) * phi)
                            : SQRT2 * flip * sin(float(am) * phi);
        return vec2(R * P * azim, 0.0);
    } else {
        float sgn = m < 0 ? flip : 1.0;
        float ang = float(m) * phi;
        return sgn * R * P * vec2(cos(ang), sin(ang));
    }
}

// ψ at a world position (Bohr radii), as (re, im). Real mode keeps im = 0
// (until a complex coefficient — e.g. time evolution — rotates it).
// The uSupCount == 0 path is the Float32 pipeline certified by the validation
// study.
vec2 evalPsi(vec3 p) {
    float rc = length(p.xy);              // cylindrical radius
    float r = length(vec2(rc, p.z));
    if (r > uRMax) return vec2(0.0);

    float theta = atan(rc, p.z);          // polar angle ∈ [0, π], well-conditioned
    float phi = atan(p.y, p.x);           // azimuth ∈ (−π, π]

    if (uSupCount > 0) {
        vec2 acc = vec2(0.0);
        for (int k = 0; k < uSupCount; k++) {
            if (r > uSupRMax[k]) continue;   // this term's tables end earlier
            float R = lookupTableRow(uSupRadialTab, k, sqrt(r / uSupRMax[k]));
            float P = lookupTableRow(uSupAngularTab, k, theta / PI);
            vec2 t = basisPsi(R, P, uSupM[k], phi);
            vec2 c = uSupCoef[k];
            acc += vec2(c.x * t.x - c.y * t.y,   // complex c·ψ
                        c.x * t.y + c.y * t.x);
        }
        return acc;
    }

    float R = lookupTable(uRadialTab, sqrt(r / uRMax));
    float P = lookupTable(uAngularTab, theta / PI);
    return basisPsi(R, P, uM, phi);
}

// ---------------------------------------------------------------------------
// Display mapping: ψ → normalized brightness ∈ [0, 1].
// ---------------------------------------------------------------------------
float brightnessOf(vec2 psi) {
    float d = dot(psi, psi);                       // |ψ|²
    float v = uValueMode == 0 ? d / uQ999 : sqrt(d / uQ999);   // ≥ 0, may exceed 1
    float W = uCompressWhite > 0.0 ? uCompressWhite : 1.0;      // 0 ⇒ disabled
    // Range compression runs on the raw value BEFORE the clamp, so the core
    // above q999 (v > 1) is shaped by the curve instead of being discarded by
    // an early clamp. W sets which multiple of q999 becomes white. All three
    // forms are exact identities to the previous clamp-then-lift behavior when
    // W = 1 (the default), so parity is preserved; W > 1 pulls the saturated
    // interior back into range to expose its gradient.
    if (uCompressMode == 1)      v = log(1.0 + uCompressK * v) / log(1.0 + uCompressK * W);
    else if (uCompressMode == 2) v = asinh(uCompressK * v) / asinh(uCompressK * W);
    else                         v = v / W;
    v = clamp(v, 0.0, 1.0);
    return pow(v, uGamma);
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

// Forward transform: linear sRGB → OKLab (mirror of lab/src/color.jl and
// web/lib/color.ts). Used by okphase, which needs the ramp's own OKLCH so it
// can rotate hue by the wavefunction phase. Inputs are non-negative linear RGB,
// so the cube-root reduces to a plain pow.
vec3 linearSrgbToOklab(vec3 c) {
    float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
    float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
    float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
    vec3 lms = pow(max(vec3(l, m, s), 0.0), vec3(1.0 / 3.0));
    return vec3(0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z,
                1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z,
                0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z);
}

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
// intuitive "cool inverse of hot" pairing. Lightness is untouched, so
// perceptual weight stays identical; reflected chroma can exceed the sRGB
// gamut in the cyan-blue region and relies on the final RGB clamp.
// Matrix is [cos 2α, sin 2α; sin 2α, −cos 2α] with 2α = 250°.
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

uniform bool uOkPhaseSigned;   // okphase: also apply the signed mode's hue
                               // reversal on the negative-real half (see below).

// okphase (uColorMode == 3): the RAMP's own color at `bright`, hue-rotated in
// OKLCH by the wavefunction phase. Complex orbitals thus inherit the palette's
// lightness + chroma envelope (the accretion look) while their hue encodes
// arg ψ — a richer phase coloring than the flat-lightness wheel. Lightness and
// chroma come entirely from the ramp; only uPhaseH0 offsets the hue zero.
//
// With uOkPhaseSigned the negative-real half (cos(phase) < 0 — the sign
// rampColorSigned keys on) additionally reflects a·b across the same 250° OKLab
// axis the signed mode uses. Every hue is still rotated by the phase; the
// reflection layers the signed palette's "cool inverse of hot" pairing on top,
// so ψ and −ψ read as complementary colors rather than a bare 180° spin.
vec3 okPhaseLab(float phase, float bright) {
    vec3 base = rampStops(bright);
    vec3 lab = uRampSpaceSrgb ? linearSrgbToOklab(srgbToLinear(clamp(base, 0.0, 1.0)))
                              : base;
    float C = length(lab.yz);
    float h = atan(lab.z, lab.y) + phase + uPhaseH0;
    vec3 res = vec3(lab.x, C * cos(h), C * sin(h));
    if (uOkPhaseSigned && cos(phase) < 0.0)
        res.yz = vec2(-0.3420201433 * res.y - 0.9396926208 * res.z,
                      -0.9396926208 * res.y + 0.3420201433 * res.z);
    return res;
}

vec3 okPhaseColor(float phase, float bright) { return oklabToSrgb(okPhaseLab(phase, bright)); }

// ---------------------------------------------------------------------------
// Output dithering: interleaved gradient noise (Jimenez), ±half an output LSB.
// Decorrelates quantization error into imperceptible grain, eliminating the
// banding that smooth astronomical gradients otherwise show on 8-bit targets.
// ---------------------------------------------------------------------------
vec3 dither(vec3 color, vec2 fragCoord) {
    float ign = fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
    return color + (ign - 0.5) * uDitherAmp;
}

// ============================================================================
// Volumetric technique library.
//
// Shared by every 3D view shader (volume.frag, pathtrace.frag, eikonal.frag):
// the perspective camera, the clipped domain, field gradients, the stochastic
// toolkit (RNG, Henyey–Greenstein), procedural environment light, linear-RGB
// emission colors, and the local-illumination models. slice.frag also includes
// this file (single-concatenation contract) but uses none of it — unused
// uniforms/functions cost nothing after link.
// ============================================================================

// ---------------------------------------------------------------------------
// Shared 3D-view uniforms. (Declared here so all view shaders agree on their
// semantics; hosts keep setting them by name exactly as before.)
// ---------------------------------------------------------------------------
uniform int   uColorMode;      // 0 ramp, 1 signed (real), 2 phase (complex)
uniform vec3  uCamPos;         // camera position, world (a₀)
uniform vec3  uCamRight;       // orthonormal camera basis…
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uTanHalfFov;     // tan(vertical FOV / 2)
uniform float uAspect;         // width / height
uniform vec4  uClipPlane[2];   // half-spaces: keep where dot(n, p) + w ≥ 0
uniform int   uClipCount;      // 0, 1, or 2 active planes
uniform float uDensityScale;   // optical depth per uRMax of unit brightness
uniform float uOpacityPow;     // extinction uses brightᵖᵒʷ (see volume.frag)
uniform float uEmissionGain;   // glow multiplier on the palette emission
uniform int   uTonemap;        // 0 linearToSrgb clamp, 1 AgX filmic
uniform float uExposure;       // EV shift (2^EV) on HDR before the transform
uniform vec3  uLightDir;       // key light: unit vector, scene toward light
uniform float uLightGain;      // key light: scattered-light gain
uniform float uHgG;            // Henyey–Greenstein anisotropy g ∈ (−1, 1)
uniform int   uEnvMode;        // environment: 0 black, 1 uniform white,
                               // 2 studio (soft neutral + two broad tinted
                               // lobes), 3 iso-luminant hue sphere (constant
                               // luminance — refraction is visible with zero
                               // directional bias), 4 lat-long checker
uniform float uEnvGain;        // environment radiance multiplier
uniform float uGradDelta;      // finite-difference half-step for gradients,
                               // as a fraction of uRMax

// ---------------------------------------------------------------------------
// Spinless Schrödinger probability current (atomic units: ℏ = mₑ = 1).
//
// j = Im(conj(ψ) ∇ψ). We differentiate the complex wavefunction itself rather
// than arg(ψ), so wrapped-phase branch cuts can never create fake currents.
// `uCurrentDerivative == 0` is the six-neighbour central estimate; 1 selects
// the more expensive fourth-order stencil for convergence checks and stills.
// The exact j is kept separate from confidence/velocity regularization. The
// latter is used by the advected-flow solvers; it never overwrites the
// conserved flux field.
// ---------------------------------------------------------------------------
uniform int   uCurrentDerivative;  // 0 second-order central, 1 fourth-order
uniform float uCurrentDelta;       // derivative half-step, fraction of uRMax
uniform float uCurrentNodeEps;     // velocity regularizer, multiples of q999
uniform bool  uFlowOverlayEnabled;
uniform float uFlowBase;           // analytic base brightness under flow

// ---------------------------------------------------------------------------
// Field access: brightness, clipping, gradients.
// ---------------------------------------------------------------------------
float fieldBright(vec3 p) { return brightnessOf(evalPsi(p)); }

// True where p is on the kept side of every active clip plane.
bool insideClips(vec3 p) {
    for (int i = 0; i < uClipCount; i++)
        if (dot(uClipPlane[i].xyz, p) + uClipPlane[i].w < 0.0) return false;
    return true;
}

// Brightness with cut-away material removed: the density the stochastic
// integrators (path tracer, eikonal medium) see, so clip planes carve the
// medium itself rather than merely the primary ray.
float fieldBrightClipped(vec3 p) { return insideClips(p) ? fieldBright(p) : 0.0; }

// ∇brightness by central differences (6 ψ evaluations). h in world units.
vec3 fieldGradient(vec3 p, float h) {
    vec2 e = vec2(h, 0.0);
    return vec3(fieldBright(p + e.xyy) - fieldBright(p - e.xyy),
                fieldBright(p + e.yxy) - fieldBright(p - e.yxy),
                fieldBright(p + e.yyx) - fieldBright(p - e.yyx)) / (2.0 * h);
}

// |ψ|² and its gradient. Isosurface normals use THIS rather than fieldGradient:
// the display brightness folds in gamma/compress/clamp, whose slopes vary
// wildly (steep near 0 from the gamma pow, exactly 0 in saturated cores) and
// roughen the finite-difference normal into faceted shading. Brightness is
// monotone in |ψ|², so the level set — and hence the surface — is identical;
// only the normal comes out clean. h in world units.
float fieldDensity(vec3 p) { vec2 z = evalPsi(p); return dot(z, z); }

vec3 fieldDensityGradient(vec3 p, float h) {
    vec2 e = vec2(h, 0.0);
    return vec3(fieldDensity(p + e.xyy) - fieldDensity(p - e.xyy),
                fieldDensity(p + e.yxy) - fieldDensity(p - e.yxy),
                fieldDensity(p + e.yyx) - fieldDensity(p - e.yyx)) / (2.0 * h);
}

vec2 currentDerivativeAt(vec3 p, vec3 axis, float h) {
    if (uCurrentDerivative == 1) {
        return (-evalPsi(p + 2.0 * h * axis)
                + 8.0 * evalPsi(p + h * axis)
                - 8.0 * evalPsi(p - h * axis)
                + evalPsi(p - 2.0 * h * axis)) / (12.0 * h);
    }
    return (evalPsi(p + h * axis) - evalPsi(p - h * axis)) / (2.0 * h);
}

struct CurrentSample {
    vec2 psi;
    float rho;
    vec3 j;
    float confidence;
};

CurrentSample evalCurrent(vec3 p) {
    CurrentSample s;
    s.psi = evalPsi(p);
    s.rho = dot(s.psi, s.psi);
    float h = max(uCurrentDelta, 1e-5) * uRMax;
    vec2 dx = currentDerivativeAt(p, vec3(1.0, 0.0, 0.0), h);
    vec2 dy = currentDerivativeAt(p, vec3(0.0, 1.0, 0.0), h);
    vec2 dz = currentDerivativeAt(p, vec3(0.0, 0.0, 1.0), h);
    // Im(conj(ψ) dψ) = Re(ψ) dIm(ψ) - Im(ψ) dRe(ψ).
    s.j = s.psi.x * vec3(dx.y, dy.y, dz.y)
        - s.psi.y * vec3(dx.x, dy.x, dz.x);

    float epsRho = max(uCurrentNodeEps * uQ999, 1e-30);
    s.confidence = s.rho / (s.rho + epsRho);
    return s;
}

// ---------------------------------------------------------------------------
// Camera + domain geometry.
// ---------------------------------------------------------------------------
vec3 primaryRay(vec2 uv) {
    vec2 ndc = uv * 2.0 - 1.0;
    return normalize(uCamFwd + uTanHalfFov * (ndc.x * uAspect * uCamRight
                                              + ndc.y * uCamUp));
}

// Clip the ray ro + t·rd to the domain: the ball r ≤ uRMax intersected with
// the kept half-spaces (each cut exact — linear in t). False ⇒ empty ray.
bool domainSegment(vec3 ro, vec3 rd, out float t0, out float t1) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - uRMax * uRMax;
    float disc = b * b - c;
    if (disc <= 0.0) return false;
    float sq = sqrt(disc);
    t0 = max(-b - sq, 0.0);               // camera inside the ball ⇒ start at 0
    t1 = -b + sq;
    for (int i = 0; i < uClipCount; i++) {
        vec3 n = uClipPlane[i].xyz;
        float f0 = dot(n, ro) + uClipPlane[i].w;   // signed dist at t = 0
        float df = dot(n, rd);                     // rate along the ray
        if (abs(df) < 1e-8) {
            if (f0 < 0.0) return false;            // parallel and outside
        } else {
            float tc = -f0 / df;
            if (df > 0.0) t0 = max(t0, tc);        // entering the kept side
            else          t1 = min(t1, tc);        // leaving it
        }
    }
    return t1 > t0;
}

// ---------------------------------------------------------------------------
// Stochastic toolkit: PCG hash RNG, Henyey–Greenstein, direction sets.
// ---------------------------------------------------------------------------
uint gRngState;

// PCG-RXS-M-XS output permutation over an LCG — the standard cheap-but-good
// shader RNG. One global stream per fragment, advanced by every rnd() call.
float rnd() {
    gRngState = gRngState * 747796405u + 2891336453u;
    uint w = ((gRngState >> ((gRngState >> 28u) + 4u)) ^ gRngState) * 277803737u;
    return float((w >> 22u) ^ w) * (1.0 / 4294967296.0);
}

void rngSeed(uvec2 pixel, uint frame) {
    gRngState = pixel.x * 1973u + pixel.y * 9277u + frame * 26699u + 1u;
    rnd(); rnd();   // decorrelate the seeds' low-entropy structure
}

// HG phase function, 1/(4π)-normalized (∫ over the sphere = 1).
float hgPhase(float cosT, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosT, 1e-4), 1.5));
}

// Convention used by every lighting term here: multiplying by 4π makes the
// isotropic phase equal 1, so light-gain sliders keep the same scale whether
// anisotropy is on or off (and across integrators).
float hgPhase4Pi(float cosT, float g) { return 4.0 * PI * hgPhase(cosT, g); }

vec3 orthoVec(vec3 v) {
    return abs(v.z) < 0.9 ? normalize(cross(v, vec3(0, 0, 1)))
                          : normalize(cross(v, vec3(1, 0, 0)));
}

// Sample a direction from HG around `dir` (exact inversion; pdf = hgPhase,
// so phase/pdf cancels in the path tracer's throughput).
vec3 sampleHg(vec3 dir, float g) {
    float u1 = rnd(), u2 = rnd();
    float cosT;
    if (abs(g) < 1e-3) cosT = 1.0 - 2.0 * u1;
    else {
        float sq = (1.0 - g * g) / (1.0 - g + 2.0 * g * u1);
        cosT = (1.0 + g * g - sq * sq) / (2.0 * g);
    }
    float sinT = sqrt(max(1.0 - cosT * cosT, 0.0));
    float phi = 2.0 * PI * u2;
    vec3 t = orthoVec(dir);
    vec3 b = cross(dir, t);
    return normalize(sinT * cos(phi) * t + sinT * sin(phi) * b + cosT * dir);
}

// i-th of n roughly-uniform sphere directions (Fibonacci spiral), spun by
// `rot` radians — per-pixel rotation turns the fixed set's structured error
// into noise.
vec3 fibDir(int i, int n, float rot) {
    float z = 1.0 - 2.0 * (float(i) + 0.5) / float(n);
    float r = sqrt(max(1.0 - z * z, 0.0));
    float phi = 2.399963229728653 * float(i) + rot;   // golden angle
    return vec3(r * cos(phi), r * sin(phi), z);
}

// ---------------------------------------------------------------------------
// Procedural spherical environments (linear RGB). Deliberately analytic — no
// textures, no favored axis beyond what each mode states.
// ---------------------------------------------------------------------------
vec3 envRadiance(vec3 d) {
    if (uEnvMode == 1) return vec3(1.0);
    if (uEnvMode == 2) {
        // Studio: neutral base + two broad soft lobes (warm high, cool low)
        // + a faint floor bounce. Gentle luminance variation for glassy
        // gradients without a hard key direction.
        vec3 c = vec3(0.45);
        c += vec3(1.0, 0.9, 0.75) * 0.55
             * pow(max(dot(d, normalize(vec3(0.6, 0.25, 0.75))), 0.0), 3.0);
        c += vec3(0.7, 0.82, 1.0) * 0.45
             * pow(max(dot(d, normalize(vec3(-0.7, -0.2, 0.1))), 0.0), 2.0);
        c += vec3(0.9) * 0.2 * pow(max(-d.z, 0.0), 2.0);
        return c;
    }
    if (uEnvMode == 3) {
        // Iso-luminant hue sphere: hue = azimuth, chroma fades at the poles,
        // OKLab lightness constant — direction is *visible* (hue) but no
        // direction is *brighter* (the "unbiased illumination" request).
        float hue = atan(d.y, d.x);
        float C = 0.13 * sqrt(max(1.0 - d.z * d.z, 0.0));
        return max(oklabToLinearSrgb(vec3(0.72, C * cos(hue), C * sin(hue))), 0.0);
    }
    if (uEnvMode == 4) {
        // Lat-long checker: pure structure probe for refraction distortion.
        float az = atan(d.y, d.x) / (2.0 * PI) + 0.5;
        float el = asin(clamp(d.z, -1.0, 1.0)) / PI + 0.5;
        float k = mod(floor(az * 16.0) + floor(el * 8.0), 2.0);
        return vec3(mix(0.25, 0.85, k));
    }
    return vec3(0.0);
}

// ---------------------------------------------------------------------------
// Linear-RGB palette emission (moved here from volume.frag so the path tracer
// shares it) — physically sensible compositing happens in linear RGB.
// ---------------------------------------------------------------------------
vec3 rampColorLinear(float t) {
    vec3 c = rampStops(t);
    if (uRampSpaceSrgb) return srgbToLinear(clamp(c, 0.0, 1.0));
    return max(oklabToLinearSrgb(c), 0.0);
}

vec3 phaseColorLinear(float phase, float bright) {
    float hue = phase + uPhaseH0;
    float C = (uPhaseVivid ? lookupTable(uPhaseCmaxTab, fract(hue / (2.0 * PI)))
                           : uPhaseC) * pow(bright, uPhaseChromaPow);
    return max(oklabToLinearSrgb(vec3(uPhaseL * bright, C * cos(hue), C * sin(hue))), 0.0);
}

vec3 okPhaseColorLinear(float phase, float bright) {
    return max(oklabToLinearSrgb(okPhaseLab(phase, bright)), 0.0);
}

// The color a medium sample emits/scatters, per the active color mode (linear
// RGB, for the compositing integrators).
vec3 emitColorLinear(vec2 psi, float bri) {
    if (uColorMode == 3) return okPhaseColorLinear(atan(psi.y, psi.x), bri);
    return uColorMode == 2 ? phaseColorLinear(atan(psi.y, psi.x), bri)
         : uColorMode == 1 ? srgbToLinear(rampColorSigned(bri, psi.x))
                           : rampColorLinear(bri);
}

// The LDR display-sRGB color for the active mode — the non-compositing
// integrators (MIP, MIDA's MIP blend) and the 2-D slice all share this.
vec3 colorLDR(vec2 psi, float bri) {
    if (uColorMode == 3) return okPhaseColor(atan(psi.y, psi.x), bri);
    if (uColorMode == 2) return phaseColor(atan(psi.y, psi.x), bri);
    if (uColorMode == 1) return rampColorSigned(bri, psi.x);
    return rampColor(bri);
}

// Dim the analytic density render while an advected layer is active.
vec3 flowBaseColor(vec3 color) {
    return uFlowOverlayEnabled ? color * clamp(uFlowBase, 0.0, 1.0) : color;
}

// ---------------------------------------------------------------------------
// Local illumination models. Applied either on
// isosurface hits or — gated by gradient confidence — inside the volume
// integrators, giving shell-like regions a lit-surface response while flat
// regions stay pure emission (the anti-"furriness" constraint).
// ---------------------------------------------------------------------------
uniform int   uShadeModel;     // 0 off, 1 Lambert, 2 Blinn–Phong, 3 GGX/Fresnel
uniform float uShadeDiffuse;   // diffuse weight
uniform float uShadeSpec;      // specular weight
uniform float uShadeRough;     // roughness ∈ (0, 1]: Blinn shininess and GGX α
uniform float uShadeF0;        // Fresnel normal-incidence reflectance
                               // (0.04 glass/water … 0.1 glossy lacquer)
uniform float uShadeConf;      // gradient-confidence scale: how sharply the
                               // relative gradient must rise before a sample
                               // counts as "surface" (0 disables gating)

float fresnelSchlick(float cosT, float F0) {
    return F0 + (1.0 - F0) * pow(clamp(1.0 - cosT, 0.0, 1.0), 5.0);
}

// Surface-likeness ∈ [0,1] from the relative brightness gradient: |∇b|
// measured over 1% of the domain, normalized by the local value. Nodal shells
// (b swinging over a short distance) score ≈ 1; the smooth outer haze ≈ 0.
float gradientConfidence(float gradMag, float bri) {
    float rel = gradMag * 0.01 * uRMax / max(bri, 0.02);
    return 1.0 - exp(-uShadeConf * rel);
}

// White-light BRDF response for the active model. N must be unit and
// viewer-facing; V points toward the camera, L toward the light.
vec3 shadeSurface(vec3 N, vec3 V, vec3 L, vec3 albedo) {
    float ndl = max(dot(N, L), 0.0);
    vec3 c = albedo * (uShadeDiffuse * ndl);
    if (uShadeModel >= 2) {
        vec3 H = normalize(V + L);
        float ndh = max(dot(N, H), 0.0);
        float f = fresnelSchlick(max(dot(H, V), 0.0), uShadeF0);
        float spec;
        if (uShadeModel == 2) {
            // Normalized Blinn–Phong; roughness → shininess ≈ 2/α².
            float shin = 2.0 / max(uShadeRough * uShadeRough, 1e-3);
            spec = f * pow(ndh, shin) * (shin + 2.0) / 8.0 * ndl;
        } else {
            // GGX + Smith (k = α/2 approximation), Schlick Fresnel.
            float a = max(uShadeRough * uShadeRough, 1e-3);
            float a2 = a * a;
            float den = ndh * ndh * (a2 - 1.0) + 1.0;
            float D = a2 / (PI * den * den);
            float ndv = max(dot(N, V), 1e-3);
            float k = a * 0.5;
            float G = (ndv / (ndv * (1.0 - k) + k)) * (ndl / (ndl * (1.0 - k) + k));
            spec = f * D * G / max(4.0 * ndv, 1e-3);
        }
        c += vec3(uShadeSpec * spec);
    }
    return c;
}

// The shared HDR → display-sRGB transfer (EA-family, path tracer, eikonal).
vec3 displayTransform(vec3 hdr) {
    hdr *= exp2(uExposure);
    return uTonemap == 1 ? agxDisplay(hdr) : linearToSrgb(hdr);
}
