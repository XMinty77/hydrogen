// ============================================================================
// post_composite.frag — final scene finishing and canvas resolve.
//
// Bloom, color grade, lens vignette/aberration, and grain are presentation
// controls only. They operate after analytic rendering and genuine advection,
// so they cannot alter density, probability current, clipping, or transport.
// ============================================================================

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2  uResolution;
uniform float uBloomIntensity;
uniform int   uBloomComposite;      // 0 screen, 1 additive
uniform float uPostExposure;
uniform float uPostContrast;
uniform float uPostSaturation;
uniform float uPostVibrance;
uniform float uAberrationPx;
uniform float uAberrationFalloff;
uniform bool  uVignetteEnabled;
uniform float uVignetteAmount;
uniform float uVignetteRadius;
uniform float uVignetteSoftness;
uniform float uVignetteRoundness;
uniform vec2  uVignetteCenter;
uniform bool  uGrainEnabled;
uniform float uGrainAmount;
uniform float uGrainScale;
uniform float uGrainTime;
uniform bool  uGrainColored;

in vec2 vUv;
out vec4 fragColor;

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec3 sceneWithAberration(vec2 uv) {
    vec2 centered = uv - 0.5;
    float radial = pow(clamp(length(centered) * 1.4142, 0.0, 1.0),
                       max(uAberrationFalloff, 0.01));
    vec2 direction = length(centered) > 1e-6 ? normalize(centered) : vec2(0.0);
    vec2 delta = direction * uAberrationPx * radial / max(uResolution, vec2(1.0));
    vec3 mid = texture(uScene, uv).rgb;
    return vec3(texture(uScene, clamp(uv + delta, 0.0, 1.0)).r,
                mid.g,
                texture(uScene, clamp(uv - delta, 0.0, 1.0)).b);
}

void main() {
    vec3 scene = sceneWithAberration(vUv);
    vec3 bloom = max(texture(uBloom, vUv).rgb, 0.0) * max(uBloomIntensity, 0.0);
    vec3 c = uBloomComposite == 1
        ? scene + bloom
        : 1.0 - (1.0 - scene) * (1.0 - clamp(bloom, 0.0, 1.0));

    c *= exp2(uPostExposure);
    c = (c - 0.5) * max(uPostContrast, 0.0) + 0.5;
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(luma), c, max(uPostSaturation, 0.0));
    float range = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    c = mix(vec3(luma), c, 1.0 + uPostVibrance * (1.0 - clamp(range, 0.0, 1.0)));

    if (uVignetteEnabled) {
        vec2 p = vUv - 0.5 - uVignetteCenter;
        float aspect = uResolution.x / max(uResolution.y, 1.0);
        float roundness = clamp(uVignetteRoundness, 0.0, 1.0);
        p.x *= mix(1.0, aspect, roundness);
        float edge = smoothstep(max(uVignetteRadius - uVignetteSoftness, 0.0),
                                max(uVignetteRadius, 1e-4), length(p));
        c *= 1.0 - clamp(uVignetteAmount, 0.0, 1.0) * edge;
    }

    if (uGrainEnabled && uGrainAmount > 0.0) {
        vec2 cell = floor(gl_FragCoord.xy / max(uGrainScale, 0.25));
        vec3 n;
        if (uGrainColored) {
            n = vec3(hash12(cell + uGrainTime * vec2(17.1, 9.2)),
                     hash12(cell + uGrainTime * vec2(5.7, 23.4) + 31.0),
                     hash12(cell + uGrainTime * vec2(13.8, 3.1) + 67.0));
        } else {
            n = vec3(hash12(cell + uGrainTime * vec2(17.1, 9.2)));
        }
        // Grain is strongest in midtones and recedes in black/white.
        float response = 1.0 - abs(2.0 * clamp(luma, 0.0, 1.0) - 1.0);
        c += (n - 0.5) * uGrainAmount * mix(0.35, 1.0, response);
    }

    fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
