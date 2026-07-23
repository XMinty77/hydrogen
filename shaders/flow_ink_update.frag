// ============================================================================
// flow_ink_update.frag — semi-Lagrangian dye advection on an arbitrary slice.
// (no #version: see prelude.glsl; library: common.glsl)
//
// The previous dye field is backtraced through the in-plane component of
// v = j/(rho+epsilon). Unlike a scrolling noise shader, every visible feature
// is transported by the evaluated quantum flow. Normal-through-plane current
// attenuates the dye because that probability leaves the displayed slice.
// ============================================================================

uniform sampler2D uFlowInkPrevious;
uniform vec2  uFlowInkTexel;
uniform vec3  uOrigin;
uniform vec3  uAxisU;
uniform vec3  uAxisV;
uniform bool  uFlowReset;
uniform float uFlowDt;
uniform float uFlowTimeScale;
uniform float uFlowMaxSpeed;
uniform bool  uFlowReverse;
uniform int   uFlowIntegrator;
uniform int   uFlowSeedMode;
uniform float uFlowSeedPower;
uniform float uFlowInkScale;
uniform float uFlowInkDecay;
uniform float uFlowInkInjection;
uniform float uFlowInkDiffusion;
uniform float uFlowInkThroughFade;
uniform float uFlowResetNonce;

in vec2 vUv;
out vec4 fragColor;

float inkHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float inkValueNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = inkHash(i + uFlowResetNonce);
    float b = inkHash(i + vec2(1, 0) + uFlowResetNonce);
    float c = inkHash(i + vec2(0, 1) + uFlowResetNonce);
    float d = inkHash(i + vec2(1, 1) + uFlowResetNonce);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float inkNoise(vec2 uv) {
    vec2 p = uv * max(uFlowInkScale, 1.0);
    // Three incommensurate octaves avoid the visible square cells of a single
    // value-noise grid while remaining band-limited enough to advect cleanly.
    return 0.52 * inkValueNoise(p)
         + 0.31 * inkValueNoise(p * 2.071 + 13.4)
         + 0.17 * inkValueNoise(p * 4.113 - 7.8);
}

vec3 inkPoint(vec2 uv) {
    return uOrigin + (2.0 * uv.x - 1.0) * uAxisU
                   + (2.0 * uv.y - 1.0) * uAxisV;
}

vec2 inkVelocityUv(vec3 p, out CurrentSample s, out float planar) {
    s = evalCurrent(p);
    float epsRho = max(uCurrentNodeEps * uQ999, 1e-30);
    vec3 v = s.j / (s.rho + epsRho);
    v *= uFlowTimeScale * (uFlowReverse ? -1.0 : 1.0);
    float cap = max(uFlowMaxSpeed, 0.0) * uRMax;
    float speed = length(v);
    if (speed > cap && cap > 0.0) v *= cap / speed;
    vec3 uh = normalize(uAxisU), vh = normalize(uAxisV);
    vec3 n = normalize(cross(uh, vh));
    float tangentSpeed = length(vec2(dot(v, uh), dot(v, vh)));
    planar = tangentSpeed / max(length(v), 1e-20);
    return vec2(dot(v, uh) / max(2.0 * length(uAxisU), 1e-20),
                dot(v, vh) / max(2.0 * length(uAxisV), 1e-20));
}

float inkSeedMask(CurrentSample s) {
    if (uFlowSeedMode == 2) return 1.0;
    float x = uFlowSeedMode == 0
        ? clamp(s.rho / max(uQ999, 1e-30), 0.0, 1.0)
        : 1.0 - exp(-length(s.j) * uRMax / max(uQ999, 1e-30));
    return pow(x, max(uFlowSeedPower, 0.01));
}

void main() {
    vec3 p = inkPoint(vUv);
    CurrentSample s;
    float planar;
    vec2 vel = inkVelocityUv(p, s, planar);
    float dt = max(uFlowDt, 0.0);
    vec2 back = vUv - dt * vel;
    if (uFlowIntegrator == 1) {
        CurrentSample midSample;
        float midPlanar;
        vec2 midVel = inkVelocityUv(inkPoint(vUv - 0.5 * dt * vel), midSample, midPlanar);
        back = vUv - dt * midVel;
        planar = min(planar, midPlanar);
    }

    float seed = inkNoise(vUv) * inkSeedMask(s);
    if (uFlowReset || any(lessThan(back, vec2(0.0))) || any(greaterThan(back, vec2(1.0)))) {
        fragColor = vec4(seed, 0.0, 0.0, 1.0);
        return;
    }

    float dye = texture(uFlowInkPrevious, back).r;
    float neighbors = 0.25 * (
        texture(uFlowInkPrevious, back + vec2(uFlowInkTexel.x, 0)).r +
        texture(uFlowInkPrevious, back - vec2(uFlowInkTexel.x, 0)).r +
        texture(uFlowInkPrevious, back + vec2(0, uFlowInkTexel.y)).r +
        texture(uFlowInkPrevious, back - vec2(0, uFlowInkTexel.y)).r);
    dye = mix(dye, neighbors, clamp(uFlowInkDiffusion * dt, 0.0, 1.0));
    dye *= exp(-max(uFlowInkDecay, 0.0) * dt);
    dye += (1.0 - exp(-max(uFlowInkInjection, 0.0) * dt)) * seed;
    // A slice only retains the tangential component; through-plane flow is a
    // physically meaningful sink rather than a misleading projected streak.
    dye *= mix(1.0 - clamp(uFlowInkThroughFade, 0.0, 1.0), 1.0, planar);
    fragColor = vec4(clamp(dye, 0.0, 4.0), 0.0, 0.0, 1.0);
}
