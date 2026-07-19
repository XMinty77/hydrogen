// ============================================================================
// eikonal.frag — refraction-based rendering: ψ as a gradient-index medium.
// (no #version: see prelude.glsl; library: common.glsl)
//
// The wavefunction is mapped to a refractive-index field
//
//     n(p) = 1 + uIorScale · map(bright(p)),   map = powᵘᴱⁱᵏᴾᵒʷ  or
//                                              log(1 + k·v)/log(1 + k)
//
// (a normalized compressive map — uEikMap selects power or logarithmic,
// per the design request) and rays are bent by the eikonal equation of
// geometric optics. With unit direction d and arc length s:
//
//     dd/ds = (∇n − d·(d·∇n)) / n        (only the transverse part turns d)
//
// integrated with fixed steps; ∇n by central differences of the analytic
// field (no grid). Rays enter the domain ball straight, curve through the
// orbital's density structure like light through shaped glass, and exit to a
// procedural spherical environment (uEnvMode — the iso-luminant hue sphere is
// the intended default: direction becomes hue, so refraction is visible while
// NO direction is brighter than any other, favoring none).
//
// Two optional volumetric terms ride along the curved ray:
//   • absorption  — τ accumulates ∝ brightness, darkening sight lines through
//     dense cores (uEikAbsorb);
//   • emission    — a faint EA-style palette glow (uEikEmission), so the
//     orbital's own structure shimmers inside the "lens".
//
// Chromatic dispersion (uDispersion > 0): three marches with the index scale
// split per RGB channel (blue bends most), giving prismatic fringes — the
// full glassy look. Costs 3×.
//
// Clip planes carve the medium itself (fieldBrightClipped): a cut region has
// n = 1 and neither bends nor absorbs.
// ============================================================================

uniform int   uSteps;          // integration steps across the domain diameter
uniform float uIorScale;       // peak Δn: n ranges over [1, 1 + uIorScale]
uniform int   uEikMap;         // 0 power map, 1 logarithmic map
uniform float uEikPow;         // power-map exponent (< 1 lifts faint density)
uniform float uEikLogK;        // log-map strength k
uniform float uEikAbsorb;      // absorption optical depth per uRMax at bright=1
uniform float uEikEmission;    // palette glow gain along the curved ray
uniform float uDispersion;     // relative RGB index-scale split (0 = off)

in vec2 vUv;
out vec4 fragColor;

float indexMap(float v) {
    return uEikMap == 1 ? log(1.0 + uEikLogK * v) / log(1.0 + uEikLogK)
                        : pow(v, uEikPow);
}

float iorAt(vec3 p, float scale) {
    return 1.0 + scale * indexMap(fieldBrightClipped(p));
}

vec3 iorGradient(vec3 p, float scale, float h) {
    vec2 e = vec2(h, 0.0);
    return vec3(iorAt(p + e.xyy, scale) - iorAt(p - e.xyy, scale),
                iorAt(p + e.yxy, scale) - iorAt(p - e.yxy, scale),
                iorAt(p + e.yyx, scale) - iorAt(p - e.yyx, scale)) / (2.0 * h);
}

// March one curved ray at the given index scale; returns HDR linear radiance.
vec3 traceEikonal(vec3 ro, vec3 rd, float scale, float jitter) {
    float t0, t1;
    if (!domainSegment(ro, rd, t0, t1))
        return uEnvGain * envRadiance(rd);

    float ds = 2.0 * uRMax / float(uSteps);
    float h = max(uGradDelta, 1e-4) * uRMax;
    vec3 p = ro + (t0 + jitter * ds) * rd;
    vec3 d = rd;
    vec3 glow = vec3(0.0);
    float tau = 0.0;

    // Curved paths can exceed the straight chord; cap generously.
    for (int i = 0; i < 2 * uSteps; i++) {
        if (dot(p, p) > uRMax * uRMax && dot(p, d) > 0.0) break;  // exited

        vec2 psi = evalPsi(p);
        float bri = insideClips(p) ? brightnessOf(psi) : 0.0;
        float n = 1.0 + scale * indexMap(bri);
        vec3 g = iorGradient(p, scale, h);
        d = normalize(d + (g - d * dot(d, g)) * ds / n);
        p += d * ds;

        if (uEikAbsorb > 0.0) tau += uEikAbsorb * bri * ds / uRMax;
        if (uEikEmission > 0.0)
            glow += exp(-tau) * uEikEmission * emitColorLinear(psi, bri) * (ds / uRMax);
        if (tau > 5.5) break;             // T < 0.004: fully absorbed
    }
    return glow + exp(-tau) * uEnvGain * envRadiance(d);
}

void main() {
    vec3 rd = primaryRay(vUv);
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy,
                                                vec2(0.06711056, 0.00583715))));
    vec3 hdr;
    if (uDispersion > 0.0005) {
        // Blue bends most: scale the index per channel around the base value.
        hdr = vec3(traceEikonal(uCamPos, rd, uIorScale * (1.0 - uDispersion), jitter).r,
                   traceEikonal(uCamPos, rd, uIorScale, jitter).g,
                   traceEikonal(uCamPos, rd, uIorScale * (1.0 + uDispersion), jitter).b);
    } else {
        hdr = traceEikonal(uCamPos, rd, uIorScale, jitter);
    }
    fragColor = vec4(dither(displayTransform(hdr), gl_FragCoord.xy), 1.0);
}
