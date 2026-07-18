// ============================================================================
// volume.frag — 3D volumetric rendering of ψ.  (no #version: see prelude.glsl)
//
// A perspective raymarcher over the analytic field: no 3D texture exists —
// every sample reconstructs ψ exactly via evalPsi (common.glsl), so spatial
// resolution is limited only by step count.
//
// Domain: the ball r ≤ uRMax (beyond it ψ is provably below visibility; see
// lab). Rays clip to it analytically, then to up to two half-space planes —
// each plane cut is exact (linear in the ray parameter), which is what makes
// the web demo's camera-locked cutaways artifact-free.
//
// Integrators:
//   0 MIP — maximum-intensity projection: the colormap sees the brightest
//     sample along the ray. For complex mode the *phase at the brightest
//     sample* drives the hue, giving phase-colored MIP.
//   1 Emission–absorption — front-to-back compositing: each sample emits its
//     palette color (in linear RGB — compositing gamma-encoded values would
//     be photometrically wrong) and occludes what lies behind it via
//     Beer–Lambert extinction. The glowing-gas look.
//
// Sampling: per-pixel IGN jitter of the step offset decorrelates the marching
// grid between neighboring pixels — banding becomes fine noise, which the
// output dither and (for stills) supersampling absorb.
// ============================================================================

uniform vec3 uCamPos;          // camera position, world (a₀)
uniform vec3 uCamRight;        // orthonormal camera basis…
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;     // tan(vertical FOV / 2)
uniform float uAspect;         // width / height
uniform int uIntegrator;       // 0 MIP, 1 emission–absorption
uniform int uSteps;            // samples along each ray inside the domain
uniform float uDensityScale;   // EA: optical depth per uRMax of unit brightness
uniform float uOpacityPow;     // EA: opacity uses brightᵖᵒʷ — emission keeps
                               // the gamma-brightened color (which reads
                               // correctly), but extinction needs a much
                               // steeper curve or the huge dim outer cloud
                               // integrates into uniform fog. pow ≈ 2.2 makes
                               // opacity roughly linear in |ψ|²/q999 again.
uniform float uEmissionGain;   // EA: emission multiplier; > 1 lets dense cores
                               // saturate toward white (accumulation is HDR,
                               // clamped only at the final transfer).
uniform int uColorMode;        // 0 ramp, 1 signed (real), 2 phase (complex)
uniform vec4 uClipPlane[2];    // half-spaces: keep where dot(n, p) + w ≥ 0
uniform int uClipCount;        // 0, 1, or 2 active planes

in vec2 vUv;
out vec4 fragColor;

// Linear-RGB palette variants for physically sensible EA compositing.
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

void main() {
    // --- primary ray ---------------------------------------------------------
    vec2 ndc = vUv * 2.0 - 1.0;
    vec3 dir = normalize(uCamFwd
                         + uTanHalfFov * (ndc.x * uAspect * uCamRight
                                          + ndc.y * uCamUp));

    // --- clip the ray to the domain ball r ≤ uRMax ---------------------------
    float b = dot(uCamPos, dir);
    float c = dot(uCamPos, uCamPos) - uRMax * uRMax;
    float disc = b * b - c;

    float t0 = 0.0, t1 = -1.0;
    if (disc > 0.0) {
        float sq = sqrt(disc);
        t0 = max(-b - sq, 0.0);           // camera inside the ball ⇒ start at 0
        t1 = -b + sq;
    }

    // --- clip to the half-space planes (exact: linear in t) ------------------
    for (int i = 0; i < uClipCount; i++) {
        vec3 n = uClipPlane[i].xyz;
        float f0 = dot(n, uCamPos) + uClipPlane[i].w;   // signed dist at t = 0
        float df = dot(n, dir);                          // rate along the ray
        if (abs(df) < 1e-8) {
            if (f0 < 0.0) t1 = t0 - 1.0;   // parallel and outside: empty ray
        } else {
            float tc = -f0 / df;           // crossing parameter
            if (df > 0.0) t0 = max(t0, tc);   // entering the kept side
            else          t1 = min(t1, tc);   // leaving it
        }
    }

    // --- march ---------------------------------------------------------------
    vec3 bgLinear = uColorMode == 2 ? vec3(0.0) : rampColorLinear(0.0);
    vec3 color;

    if (t1 <= t0) {
        color = linearToSrgb(bgLinear);                  // empty ray
    } else {
        float dt = (t1 - t0) / float(uSteps);
        float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy,
                                                    vec2(0.06711056, 0.00583715))));

        if (uIntegrator == 0) {
            // ---- MIP: track the brightest sample and its phase/sign. --------
            float maxB = 0.0;
            vec2 psiAtMax = vec2(0.0);
            for (int i = 0; i < uSteps; i++) {
                vec3 p = uCamPos + (t0 + (float(i) + jitter) * dt) * dir;
                vec2 psi = evalPsi(p);
                float bri = brightnessOf(psi);
                if (bri > maxB) { maxB = bri; psiAtMax = psi; }
            }
            color = uColorMode == 2 ? phaseColor(atan(psiAtMax.y, psiAtMax.x), maxB)
                  : uColorMode == 1 ? rampColorSigned(maxB, psiAtMax.x)
                                    : rampColor(maxB);
        } else {
            // ---- Emission–absorption, front-to-back. ------------------------
            vec3 accum = vec3(0.0);
            float transmit = 1.0;
            float dta = dt / uRMax;        // step length in domain units, so
                                           // uDensityScale is extent-invariant
            for (int i = 0; i < uSteps; i++) {
                vec3 p = uCamPos + (t0 + (float(i) + jitter) * dt) * dir;
                vec2 psi = evalPsi(p);
                float bri = brightnessOf(psi);
                if (bri > 1e-4) {
                    float alpha = 1.0 - exp(-uDensityScale * pow(bri, uOpacityPow) * dta);
                    vec3 emit = uColorMode == 2
                        ? phaseColorLinear(atan(psi.y, psi.x), bri)
                        : uColorMode == 1 ? srgbToLinear(rampColorSigned(bri, psi.x))
                                          : rampColorLinear(bri);
                    accum += transmit * alpha * uEmissionGain * emit;
                    transmit *= 1.0 - alpha;
                    if (transmit < 0.004) break;         // early ray termination
                }
            }
            color = linearToSrgb(accum + transmit * bgLinear);
        }
    }

    fragColor = vec4(dither(color, gl_FragCoord.xy), 1.0);
}
