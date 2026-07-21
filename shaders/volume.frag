// ============================================================================
// volume.frag — 3D volumetric rendering of ψ.  (no #version: see prelude.glsl)
//
// A perspective raymarcher over the analytic field: no 3D texture exists —
// every sample reconstructs ψ exactly via evalPsi (common.glsl), so spatial
// resolution is limited only by step count. Rays clip to the ball r ≤ uRMax
// intersected with up to two exact half-space planes (domainSegment).
//
// Integrators (uIntegrator):
//   0 MIP — maximum-intensity projection: the colormap sees the brightest
//     sample along the ray; complex mode hues by the phase at that sample.
//   1 Emission–absorption — front-to-back compositing: each sample emits its
//     palette color in linear RGB and occludes what lies behind it via
//     Beer–Lambert extinction. The glowing-gas look. (The certified default;
//     its output is bit-stable across iterations.)
//   2 Anisotropic ambient multi-scattering (iteration 5; replaces the old
//     single-hard-shadow scatter). EA plus two light terms per sample:
//       • key light: one shadow ray's optical depth τ drives a Wrenninge-style
//         octave sum Σ aᵏ·exp(−bᵏτ) — each octave is a softer, brighter
//         approximation of higher scattering orders, so dense cores glow
//         through their own shadows instead of going flat black — times a
//         Henyey–Greenstein phase factor (uHgG): forward-scattering halos
//         when looking toward the light, silver linings on shell edges.
//       • ambient: mean short-range transmittance over uAmbientDirs Fibonacci
//         directions (per-pixel rotated) — an occlusion field that darkens
//         lobe interiors and creases, the self-shadowed "sitting in space"
//         cue plain EA lacks, with no directional bias at all.
//   3 MIDA — maximum intensity difference accumulation (Bruckner & Gröller,
//     EuroVis 2009): EA compositing, but a sample only *replaces* accumulated
//     color to the extent it raises the running maximum (β = 1 − δ damping).
//     Keeps MIP's structural legibility and EA's occlusion. uMidaGamma
//     interpolates DVR ↔ MIDA ↔ MIP exactly as in the paper. Pairs with the
//     compressed-normalization toggle (uCompressMode), which reshapes the
//     value ordering MIDA keys on.
//   4 Emissive isosurfaces — up to 6 nested shells of constant brightness,
//     found by sign-change detection + bisection refinement (exact analytic
//     field ⇒ crisp surfaces at any zoom). Each shell glows with its palette
//     color, optionally lit by the local-illumination models (gradient
//     normals), with a Fresnel-ish rim glow. Sweeping uIsoLevel pages through
//     the wavefunction's level sets — the "3D slides" exploration.
//
// Surface-shading overlay (uShadeModel > 0, integrators 1–2): samples whose
// *relative* brightness gradient is steep (gradientConfidence) additionally
// respond to the key light through the selected BRDF — Lambert, Blinn–Phong,
// or GGX/Fresnel — so nodal shells pick up glassy speculars while the smooth
// haze between them stays pure emission (no full-volume "fur").
//
// Display transform (all but MIP, which is LDR by construction):
// displayTransform in common.glsl — linear clamp or AgX, after uExposure EV.
//
// Sampling: per-pixel IGN jitter of the step offset decorrelates the marching
// grid between neighboring pixels — banding becomes fine noise, which the
// output dither and (for stills) supersampling absorb.
// ============================================================================

uniform int uIntegrator;       // 0 MIP, 1 EA, 2 scatter, 3 MIDA, 4 isosurfaces
uniform int uSteps;            // samples along each ray inside the domain

// --- key-light shadowing (integrator 2; also shell lighting in 4) ----------
uniform int   uShadowSteps;    // samples along each shadow ray
uniform float uShadowDensity;  // extinction scale for shadow rays, decoupled
                               // from uDensityScale — the tuned viewing
                               // density leaves the medium optically thin
                               // (glow-dominated); shadows need their own.
uniform int   uOctaves;        // multi-scatter octaves (1 = single scattering)
uniform float uOctaveGain;     // a: per-octave gain falloff
uniform float uOctaveExt;      // b: per-octave extinction falloff

// --- ambient occlusion field (integrator 2) --------------------------------
uniform float uAmbientGain;    // ambient in-scatter gain (0 = off)
uniform int   uAmbientDirs;    // directions in the occlusion estimate (≤ 12)
uniform float uAmbientRadius;  // occlusion probe length, fraction of uRMax
uniform float uAmbientDensity; // extinction scale for the ambient probes

// --- MIDA (integrator 3) ----------------------------------------------------
uniform float uMidaGamma;      // −1 → plain DVR/EA, 0 → MIDA, +1 → MIP

// --- isosurfaces (integrator 4) ---------------------------------------------
uniform float uIsoLevel;       // brightness of the outermost shell ∈ (0, 1)
uniform int   uIsoCount;       // number of nested shells (1–6)
uniform float uIsoSpacing;     // geometric ratio between successive levels
uniform float uIsoAlpha;       // opacity of each shell
uniform float uIsoEmission;    // shell self-glow gain (palette-colored)
uniform float uIsoRim;         // Fresnel-style rim-glow gain (pushes hue hotter)
uniform float uIsoAmbient;     // ramp-walk floor: how far up the palette an
                               // UNLIT shell face sits (0 = at the shell's own
                               // level/cool base color, 1 = flat fully-hot). The
                               // key light lifts lit faces from here toward the
                               // ramp's hot end — see shadeIsoHit.
uniform bool  uIsoLegacy;      // true ⇒ the original pre-palette-mapped shading
                               // (self-glow at max(bri,level) + white BRDF
                               // highlight), kept as its own technique.

in vec2 vUv;
out vec4 fragColor;

const int MAX_SHELLS = 6;

// ---------------------------------------------------------------------------
// Key-light machinery.
// ---------------------------------------------------------------------------

// Optical depth (already scaled by uShadowDensity) from p toward the light,
// over the chord to the domain boundary, uShadowSteps jittered samples.
// p is always on the kept side of the clip planes; where the shadow ray
// leaves a kept half-space the material ends (cut-away gas casts no shadow),
// so only the leaving intersection clips the chord.
float lightOpticalDepth(vec3 p, float jitter) {
    float b = dot(p, uLightDir);
    float disc = b * b - (dot(p, p) - uRMax * uRMax);
    if (disc <= 0.0) return 0.0;
    float tExit = -b + sqrt(disc);
    for (int i = 0; i < uClipCount; i++) {
        float df = dot(uClipPlane[i].xyz, uLightDir);
        if (df < -1e-8)
            tExit = min(tExit, -(dot(uClipPlane[i].xyz, p) + uClipPlane[i].w) / df);
    }
    if (tExit <= 0.0) return 0.0;
    float ds = tExit / float(uShadowSteps);
    float tau = 0.0;
    for (int i = 0; i < uShadowSteps; i++) {
        vec3 q = p + (float(i) + jitter) * ds * uLightDir;
        tau += pow(brightnessOf(evalPsi(q)), uOpacityPow) * ds;
    }
    return uShadowDensity * tau / uRMax;
}

// Wrenninge/Hillaire octave trick: higher scattering orders behave like the
// same light seen through progressively *less* extinction with progressively
// less energy — Σ aᵏ exp(−bᵏ τ), one τ for all octaves. Normalized so a fully
// unshadowed sample returns 1 regardless of octave count.
float multiScatterShadow(float tau) {
    int n = max(uOctaves, 1);
    float sum = 0.0, norm = 0.0, a = 1.0, b = 1.0;
    for (int k = 0; k < n; k++) {
        sum += a * exp(-b * tau);
        norm += a;
        a *= uOctaveGain;
        b *= uOctaveExt;
    }
    return sum / norm;
}

// Mean short-range transmittance over a rotated Fibonacci direction set:
// ≈ the fraction of the sky each point can see through the nearby medium.
float ambientOcclusion(vec3 p, float rot) {
    int nd = clamp(uAmbientDirs, 1, 12);
    float R = uAmbientRadius * uRMax;
    float sum = 0.0;
    for (int i = 0; i < nd; i++) {
        vec3 d = fibDir(i, nd, rot);
        float tau = 0.0;
        for (int s = 0; s < 4; s++) {
            vec3 q = p + d * ((float(s) + 0.5) * 0.25) * R;
            tau += pow(fieldBrightClipped(q), uOpacityPow) * (R * 0.25);
        }
        sum += exp(-uAmbientDensity * tau / uRMax);
    }
    return sum / float(nd);
}

// ---------------------------------------------------------------------------
// Isosurface helpers.
// ---------------------------------------------------------------------------

// Bisection refinement of a bracketed level crossing (8 halvings on top of
// the marching step ⇒ sub-1/256-step surface placement).
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

// Shade one shell hit and composite it front-to-back into (accum, transmit).
//
// Coloring is PALETTE-MAPPED SHADING: rather than adding white light (which
// desaturates the accretion palette into a washed-out mid-ramp grey — the
// "ugly iso" the flat previous version produced), the surface illumination
// walks the ramp. An unlit face sits at uIsoAmbient up from its shell's own
// `level` (the cool base color); the key light lifts lit faces toward the hot
// end (gold → white); the Fresnel rim pushes the silhouette hotter still. A
// single shell therefore shows the full accretion gradient with genuine 3-D
// form, in the palette's own hues — for phase/okphase modes the same walk
// drives lightness while hue stays the phase, so complex shells read cleanly
// too. Optional crisp white speculars ride on top when a BRDF model is active.
//
// uIsoLegacy selects the ORIGINAL shading instead: the shell emits its palette
// color at max(bri, level) plus a rim term and (when a BRDF is on) a white
// specular highlight. It desaturates toward a washed mid-ramp under strong
// light, but the glassy shell look it gives on some states is worth keeping —
// it is exposed as the separate "isolegacy" technique.
// `coverage` (∈[0,1]) scales the composited opacity — 1 for a solid crossing,
// < 1 for the feathered grazing sliver at a silhouette (analytic edge AA).
void shadeIsoHit(vec3 p, vec3 rd, float level, float jitter, float coverage,
                 inout vec3 accum, inout float transmit) {
    vec2 psi = evalPsi(p);

    float h = max(uGradDelta, 1e-4) * uRMax;
    vec3 g = fieldDensityGradient(p, h);   // smooth |ψ|² normal, not the
                                           // gamma-compressed brightness normal
    vec3 N = -normalize(g + 1e-12);        // outward: density falls outward
    vec3 V = -rd;
    if (dot(N, V) < 0.0) N = -N;           // two-sided shells
    float ndv = max(dot(N, V), 0.0);

    vec3 c;
    if (uIsoLegacy) {
        float bri = brightnessOf(psi);
        vec3 emit = emitColorLinear(psi, max(bri, level));
        c  = uIsoEmission * emit;                          // self-glow
        c += uIsoRim * pow(1.0 - ndv, 3.0) * emit;         // rim glow
        if (uShadeModel > 0) {
            float sh = multiScatterShadow(lightOpticalDepth(p, jitter));
            c += uLightGain * sh * shadeSurface(N, V, uLightDir, emit);
        }
    } else {
        float ndl = max(dot(N, uLightDir), 0.0);
        // Self-shadow through the medium only when a shade model is on (the
        // shadow ray is the expensive part); else the form comes free from N·L.
        float sh  = uShadeModel > 0 ? multiScatterShadow(lightOpticalDepth(p, jitter)) : 1.0;
        float rim = uIsoRim * pow(1.0 - ndv, 3.0);
        float w = clamp(uIsoAmbient + ndl * sh + rim, 0.0, 1.0);
        float temp = mix(level, 1.0, w);   // ramp position for this pixel
        vec3 emit = emitColorLinear(psi, temp);
        c = uIsoEmission * emit;
        if (uShadeModel >= 2)              // white glints, no desaturating diffuse
            c += uLightGain * sh * shadeSurface(N, V, uLightDir, vec3(0.0));
    }

    float a = uIsoAlpha * coverage;
    accum += transmit * a * c;
    transmit *= 1.0 - a;
}

// ---------------------------------------------------------------------------
void main() {
    vec3 dir = primaryRay(vUv);

    float t0, t1;
    bool hitDomain = domainSegment(uCamPos, dir, t0, t1);

    vec3 bgLinear = uColorMode == 2 ? vec3(0.0) : rampColorLinear(0.0);
    vec3 color;

    if (!hitDomain) {
        color = linearToSrgb(bgLinear);                    // empty ray
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
            color = colorLDR(psiAtMax, maxB);

        } else if (uIntegrator == 4) {
            // ---- Emissive isosurfaces. --------------------------------------
            // Detect all level crossings per step, refine each by bisection
            // (exact surface position, grid-independent), and shade them in ray
            // order. The scan is deterministic (no jitter): a jittered grid
            // turns the silhouette — where a shell's two grazing crossings merge
            // and vanish — into per-pixel stipple that supersampling cannot
            // average into a clean edge. A fixed grid instead leaves a coherent
            // edge that SSAA smooths, and the analytic coverage feather below
            // softens the last grazing sliver the grid would otherwise terrace.
            vec3 accum = vec3(0.0);
            float transmit = 1.0;
            float tPrev = t0;
            float fPrev = fieldBright(uCamPos + tPrev * dir);
            float peakB = fPrev;                   // brightest sample on the ray
            vec3  peakP = uCamPos + tPrev * dir;    // …and where — for edge AA
            for (int i = 1; i <= uSteps; i++) {
                float t = t0 + float(i) * dt;
                vec3 p = uCamPos + t * dir;
                float f = fieldBright(p);
                if (f > peakB) { peakB = f; peakP = p; }

                // Gather crossings of every active level inside this step,
                // sorted by their linear-interpolation position.
                float hitT[MAX_SHELLS];
                float hitL[MAX_SHELLS];
                int nHits = 0;
                float level = uIsoLevel;
                for (int k = 0; k < uIsoCount && k < MAX_SHELLS; k++) {
                    if ((fPrev - level) * (f - level) < 0.0) {
                        float tEst = tPrev + dt * (level - fPrev) / (f - fPrev);
                        int j = nHits;
                        for (; j > 0 && hitT[j - 1] > tEst; j--) {
                            hitT[j] = hitT[j - 1];
                            hitL[j] = hitL[j - 1];
                        }
                        hitT[j] = tEst;
                        hitL[j] = level;
                        nHits++;
                    }
                    level *= uIsoSpacing;
                }
                for (int j = 0; j < nHits; j++) {
                    float th = refineHit(uCamPos, dir, tPrev, t, hitL[j]);
                    shadeIsoHit(uCamPos + th * dir, dir, hitL[j], jitter, 1.0,
                                accum, transmit);
                }
                if (transmit < 0.004) break;
                tPrev = t;
                fPrev = f;
            }
            // Analytic silhouette AA. The outer boundary is the outermost
            // (dimmest) shell; a ray reaches it iff its peak brightness clears
            // that level. Right at the limb the two grazing crossings merge and
            // vanish between samples, so detection stops abruptly and the edge
            // terraces at the marching resolution. Feather it: rays whose peak
            // falls just short of the outer level still deposit a fractional
            // sliver of that shell (shaded at the closest-approach point), so
            // the silhouette fades over a thin brightness window instead of
            // snapping off — smooth without brute-force step counts.
            float outerLevel = uIsoLevel * pow(uIsoSpacing, float(uIsoCount - 1));
            float w = max(outerLevel * 0.2, 1e-4);
            if (transmit > 0.004 && peakB < outerLevel && peakB > outerLevel - w) {
                float cov = smoothstep(outerLevel - w, outerLevel, peakB);
                shadeIsoHit(peakP, dir, outerLevel, jitter, cov, accum, transmit);
            }
            color = displayTransform(accum + transmit * bgLinear);

        } else if (uIntegrator == 3) {
            // ---- MIDA (Bruckner & Gröller). ---------------------------------
            // δ = the amount a sample raises the running maximum; β = 1 − δ
            // damps what was accumulated before it, so each new "most
            // important" structure shows through everything in front of it.
            // uMidaGamma < 0 scales δ toward 0 (plain EA at −1); > 0 blends
            // the result toward the pure MIP picture.
            float vMax = 0.0;
            vec3 accum = vec3(0.0);
            float aAcc = 0.0;
            float maxB = 0.0;
            vec2 psiAtMax = vec2(0.0);
            float dta = dt / uRMax;
            for (int i = 0; i < uSteps; i++) {
                vec3 p = uCamPos + (t0 + (float(i) + jitter) * dt) * dir;
                vec2 psi = evalPsi(p);
                float bri = brightnessOf(psi);
                if (bri > maxB) { maxB = bri; psiAtMax = psi; }
                float delta = max(bri - vMax, 0.0);
                vMax = max(vMax, bri);
                float beta = 1.0 - delta * (uMidaGamma < 0.0 ? 1.0 + uMidaGamma : 1.0);
                float alpha = 1.0 - exp(-uDensityScale * pow(bri, uOpacityPow) * dta);
                vec3 emit = emitColorLinear(psi, bri);
                accum = beta * accum + (1.0 - beta * aAcc) * alpha * uEmissionGain * emit;
                aAcc  = beta * aAcc  + (1.0 - beta * aAcc) * alpha;
            }
            color = displayTransform(accum + (1.0 - aAcc) * bgLinear);
            if (uMidaGamma > 0.0)
                color = mix(color, colorLDR(psiAtMax, maxB), uMidaGamma);

        } else {
            // ---- EA (1) and ambient multi-scattering (2), front-to-back. ----
            vec3 accum = vec3(0.0);
            float transmit = 1.0;
            float dta = dt / uRMax;        // step length in domain units, so
                                           // uDensityScale is extent-invariant
            // View-independent per-ray factor: HG phase for the key light.
            float hgFac = uIntegrator == 2 ? hgPhase4Pi(dot(uLightDir, dir), uHgG) : 1.0;
            for (int i = 0; i < uSteps; i++) {
                vec3 p = uCamPos + (t0 + (float(i) + jitter) * dt) * dir;
                vec2 psi = evalPsi(p);
                float bri = brightnessOf(psi);
                if (bri > 1e-4) {
                    float alpha = 1.0 - exp(-uDensityScale * pow(bri, uOpacityPow) * dta);
                    vec3 emit = emitColorLinear(psi, bri);
                    // Glow, plus (integrator 2) the two scattered-light terms.
                    float w = uEmissionGain;
                    if (uIntegrator == 2) {
                        if (uLightGain > 0.0)
                            w += uLightGain * hgFac
                                 * multiScatterShadow(lightOpticalDepth(p, jitter));
                        if (uAmbientGain > 0.0)
                            w += uAmbientGain * ambientOcclusion(p, jitter * 6.2831853);
                    }
                    vec3 contrib = w * emit;
                    // Surface-shading overlay: lit-surface response where the
                    // field is locally shell-like (see header).
                    if (uShadeModel > 0 && bri > 0.01) {
                        float h = max(uGradDelta, 1e-4) * uRMax;
                        vec3 g = fieldGradient(p, h);
                        float gm = length(g);
                        float conf = gradientConfidence(gm, bri);
                        if (conf > 0.01) {
                            vec3 N = -g / max(gm, 1e-9);
                            vec3 V = -dir;
                            if (dot(N, V) < 0.0) N = -N;
                            float sh = uIntegrator == 2
                                ? multiScatterShadow(lightOpticalDepth(p, jitter))
                                : 1.0;
                            contrib += uLightGain * sh * conf
                                       * shadeSurface(N, V, uLightDir, emit);
                        }
                    }
                    accum += transmit * alpha * contrib;
                    transmit *= 1.0 - alpha;
                    if (transmit < 0.004) break;         // early ray termination
                }
            }
            color = displayTransform(accum + transmit * bgLinear);
        }
    }

    fragColor = vec4(dither(color, gl_FragCoord.xy), 1.0);
}
