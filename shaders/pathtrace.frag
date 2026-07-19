// ============================================================================
// pathtrace.frag — progressive volumetric path tracing of ψ as a participating
// medium.  (no #version: see prelude.glsl; library: common.glsl)
//
// The full unbiased treatment of what the EA integrator approximates: the
// medium both *emits* (the palette glow, matched statistically to EA — the
// expected emission of the collision estimator equals EA's integral) and
// *scatters*, with multiple bounces, so dense cores cast soft colored light
// into neighboring lobes, shells shade each other, and the "glowing fog"
// gains real texture.
//
//   • Extinction σ_t(p) = (uDensityScale/uRMax) · brightᵘᴼᵖᵃᶜⁱᵗʸᴾᵒʷ — the same
//     transfer as EA, so the density/opacity sliders keep their meaning.
//   • Free flights are sampled by delta tracking (Woodcock) against the exact
//     majorant σ̄ = uDensityScale/uRMax (bright ≤ 1 makes it exact) — no grid,
//     no bias, the analytic field is queried only at tentative collisions.
//   • Real collisions: emit uEmissionGain · palette color; then scatter with
//     single-scattering albedo uAlbedo, direction from Henyey–Greenstein
//     (uHgG; sampling pdf = phase, so the throughput math cancels), tinted
//     toward the local palette color by uScatterTint (colored multiple
//     scattering — the nebula look).
//   • Next-event estimation toward the directional key light at every
//     collision, with transmittance by ratio tracking. The 4π-normalized HG
//     factor keeps uLightGain on the same scale as the scatter integrator.
//   • Escaped rays collect the procedural environment (uEnvMode/uEnvGain).
//   • Thin-lens camera: uAperture > 0 adds depth of field focused at
//     uFocusDist (both in world a₀; the host converts from framing units).
//
// Progressive accumulation: each pass renders uSppFrame fresh samples per
// pixel and ADDS them to the running sum read from uPrevAccum (RGB = radiance
// sum, A = sample count). The display pass (display.frag) divides, applies
// exposure + tonemap, and dithers. The host resets the accumulation whenever
// any parameter or the camera changes.
// ============================================================================

uniform sampler2D uPrevAccum;  // running (sum, count); ignored when uFrameIndex=0
uniform int   uFrameIndex;     // pass number since the last reset (RNG stream)
uniform int   uSppFrame;       // samples per pixel added by this pass
uniform vec2  uResolution;     // accumulation-buffer size in pixels
uniform int   uMaxBounces;     // scattering events per path before termination
uniform float uAlbedo;         // single-scattering albedo ∈ [0, 1]
uniform float uScatterTint;    // 0 white scattering … 1 palette-colored
uniform float uAperture;       // thin-lens radius, world (a₀); 0 = pinhole
uniform float uFocusDist;      // focal-plane distance along uCamFwd, world (a₀)

in vec2 vUv;
out vec4 fragColor;

const int MAX_MARCH = 4096;    // hard guards against degenerate parameters
const int MAX_SHADOW = 1024;

float maxComp(vec3 v) { return max(v.x, max(v.y, v.z)); }

// Beer–Lambert transmittance toward the key light by ratio tracking: at each
// tentative collision the ray survives with 1 − σ/σ̄. Unbiased in expectation,
// cheap, and it converges over the accumulation like everything else.
float lightTransmittance(vec3 p) {
    float maj = uDensityScale / uRMax;
    float t0, t1;
    if (!domainSegment(p, uLightDir, t0, t1)) return 1.0;
    float t = t0;
    float T = 1.0;
    for (int i = 0; i < MAX_SHADOW; i++) {
        t -= log(max(1.0 - rnd(), 1e-7)) / maj;
        if (t >= t1) break;
        T *= 1.0 - pow(fieldBrightClipped(p + t * uLightDir), uOpacityPow);
        if (T < 1e-3) return 0.0;
    }
    return T;
}

// One full light path from the camera. Collision estimator for emission,
// NEE for the key light, phase-sampled bounces, env light on escape.
vec3 radiance(vec3 ro, vec3 rd) {
    vec3 L = vec3(0.0);
    vec3 tp = vec3(1.0);       // path throughput
    float maj = uDensityScale / uRMax;
    int bounces = 0;

    float t0, t1;
    if (!domainSegment(ro, rd, t0, t1)) return uEnvGain * envRadiance(rd);
    float t = t0;

    for (int it = 0; it < MAX_MARCH; it++) {
        t -= log(max(1.0 - rnd(), 1e-7)) / maj;
        if (t >= t1) {                       // escaped the medium
            L += tp * uEnvGain * envRadiance(rd);
            break;
        }
        vec3 p = ro + t * rd;
        vec2 psi = evalPsi(p);
        float bri = insideClips(p) ? brightnessOf(psi) : 0.0;
        if (rnd() >= pow(bri, uOpacityPow)) continue;   // null collision

        // ---- real collision -------------------------------------------------
        vec3 emit = emitColorLinear(psi, bri);
        L += tp * uEmissionGain * emit;

        if (bounces >= uMaxBounces) break;
        bounces++;

        vec3 tint = mix(vec3(1.0), emit / max(maxComp(emit), 1e-4), uScatterTint);
        tp *= uAlbedo * tint;

        if (uLightGain > 0.0)
            L += tp * uLightGain * hgPhase4Pi(dot(rd, uLightDir), uHgG)
                 * lightTransmittance(p);

        rd = sampleHg(rd, uHgG);             // pdf = phase ⇒ weight already in tp
        ro = p;
        if (!domainSegment(ro, rd, t0, t1)) {   // numerically at the boundary
            L += tp * uEnvGain * envRadiance(rd);
            break;
        }
        t = t0;

        // Russian roulette once paths are deep: unbiased termination.
        if (bounces > 3) {
            float q = clamp(maxComp(tp), 0.05, 0.95);
            if (rnd() >= q) break;
            tp /= q;
        }
    }
    return L;
}

void main() {
    rngSeed(uvec2(gl_FragCoord.xy), uint(uFrameIndex));

    vec3 sum = vec3(0.0);
    for (int s = 0; s < uSppFrame; s++) {
        // Subpixel box jitter: the accumulation converges to an antialiased
        // image for free.
        vec2 uv = (gl_FragCoord.xy - vec2(0.5) + vec2(rnd(), rnd())) / uResolution;
        vec3 ro = uCamPos;
        vec3 rd = primaryRay(uv);
        if (uAperture > 0.0) {
            // Thin lens: keep the point on the focal plane fixed, jitter the
            // ray origin across the aperture disk.
            float ft = uFocusDist / max(dot(rd, uCamFwd), 1e-4);
            vec3 focus = ro + ft * rd;
            float ang = 2.0 * PI * rnd();
            float rad = uAperture * sqrt(rnd());
            ro += rad * (cos(ang) * uCamRight + sin(ang) * uCamUp);
            rd = normalize(focus - ro);
        }
        sum += radiance(ro, rd);
    }

    vec4 prev = uFrameIndex == 0 ? vec4(0.0)
              : texelFetch(uPrevAccum, ivec2(gl_FragCoord.xy), 0);
    fragColor = prev + vec4(sum, float(uSppFrame));
}
