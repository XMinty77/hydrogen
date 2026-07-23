// ============================================================================
// flow_update.frag — persistent probability-flow particle advection.
// (no #version: see prelude.glsl; library: common.glsl)
//
// Each texel is one tracer (world position + age). The other ping-pong target
// retains its previous position, so rendering can measure actual displacement
// without a second float attachment. Tracers move with the regularized
// transport velocity
//
//     v = j / (rho + epsilon),    j = Im(conj(psi) grad psi),
//
// never with raw flux magnitude. Midpoint integration and optional substeps
// make the visible trajectories genuine pathlines of that field. The speed
// multiplier and cap only choose how quickly atomic time is shown on screen.
// ============================================================================

uniform sampler2D uFlowPositionAge;
uniform bool  uFlowReset;
uniform int   uFlowFrame;
uniform float uFlowDt;
uniform float uFlowTimeScale;
uniform float uFlowMaxSpeed;
uniform float uFlowLifetime;
uniform bool  uFlowReverse;
uniform int   uFlowIntegrator;       // 0 Euler, 1 midpoint/RK2
uniform int   uFlowSubsteps;         // 1..4
uniform int   uFlowSeedMode;         // 0 density, 1 |j|, 2 uniform volume
uniform int   uFlowSpawnTries;       // rejection candidates, 1..12
uniform float uFlowSeedPower;
uniform bool  uFlowSeedInsideClips;
uniform float uFlowResetNonce;

out vec4 outPositionAge;

float flowHash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}

vec3 flowRandomBall(float id, float attempt, float epoch) {
    vec3 key = vec3(id + 19.0 * attempt, epoch + 7.0 * attempt,
                    uFlowResetNonce + 0.37 * attempt);
    float z = 1.0 - 2.0 * flowHash(key + vec3(1.7, 8.2, 2.9));
    float phi = 2.0 * PI * flowHash(key + vec3(6.1, 3.4, 9.8));
    // Uniform mode samples volume exactly (r = u^(1/3)). Density/flux modes
    // use a center-biased proposal so a small rejection budget still reaches
    // the compact bound-state support instead of spending every try near the
    // outer domain boundary; the field weight below performs the final bias.
    float radialPower = uFlowSeedMode == 2 ? 1.0 / 3.0 : 1.65;
    float r = pow(flowHash(key + vec3(4.4, 7.3, 1.2)), radialPower);
    float q = sqrt(max(1.0 - z * z, 0.0));
    return (0.997 * uRMax * r) * vec3(q * cos(phi), q * sin(phi), z);
}

float flowSeedWeight(vec3 p) {
    if (uFlowSeedInsideClips && !insideClips(p)) return 0.0;
    if (uFlowSeedMode == 2) return 1.0;
    if (uFlowSeedMode == 0) {
        vec2 psi = evalPsi(p);
        return pow(clamp(dot(psi, psi) / max(uQ999, 1e-30), 0.0, 1.0),
                   max(uFlowSeedPower, 0.01));
    }
    CurrentSample s = evalCurrent(p);
    float flux = length(s.j) * uRMax / max(uQ999, 1e-30);
    return pow(1.0 - exp(-flux), max(uFlowSeedPower, 0.01));
}

vec3 flowSpawn(float id, float epoch) {
    vec3 best = flowRandomBall(id, 0.0, epoch);
    float bestWeight = -1.0;
    bool accepted = false;
    for (int i = 0; i < 12; i++) {
        if (i >= max(uFlowSpawnTries, 1)) break;
        vec3 p = flowRandomBall(id, float(i), epoch);
        float w = flowSeedWeight(p);
        if (w > bestWeight) { best = p; bestWeight = w; }
        float coin = flowHash(vec3(id + 11.0, float(i) + 41.0, epoch + 73.0));
        if (!accepted && coin <= w) { best = p; accepted = true; }
    }
    return best;
}

vec3 flowWallVelocity(CurrentSample s) {
    float epsRho = max(uCurrentNodeEps * uQ999, 1e-30);
    vec3 v = s.j / (s.rho + epsRho);
    v *= uFlowTimeScale * (uFlowReverse ? -1.0 : 1.0);
    float cap = max(uFlowMaxSpeed, 0.0) * uRMax;
    float speed = length(v);
    if (speed > cap && cap > 0.0) v *= cap / speed;
    return cap > 0.0 ? v : vec3(0.0);
}

void main() {
    ivec2 tc = ivec2(gl_FragCoord.xy);
    ivec2 sz = textureSize(uFlowPositionAge, 0);
    float id = float(tc.x + tc.y * sz.x);
    vec4 pa = texelFetch(uFlowPositionAge, tc, 0);
    vec3 p = pa.xyz;
    float age = pa.w;
    float life = max(uFlowLifetime, 0.05);

    bool invalid = any(isnan(p)) || any(isinf(p)) || length(p) >= uRMax;
    bool respawn = uFlowReset || invalid || age >= life;
    if (respawn) {
        float epoch = uFlowReset
            ? 0.0
            : float(uFlowFrame) + floor(age / life) * 131.0;
        p = flowSpawn(id, epoch);
        age = uFlowReset
            ? life * flowHash(vec3(id, 17.0, uFlowResetNonce + 5.0))
            : 0.0;
    }

    float dt = respawn ? 0.0 : max(uFlowDt, 0.0);
    int substeps = clamp(uFlowSubsteps, 1, 4);
    float h = dt / float(substeps);
    vec3 velocity = vec3(0.0);
    if (dt > 0.0) {
        for (int k = 0; k < 4; k++) {
            if (k >= substeps) break;
            if (uFlowIntegrator == 1) {
                vec3 v0 = flowWallVelocity(evalCurrent(p));
                velocity = flowWallVelocity(evalCurrent(p + 0.5 * h * v0));
            } else {
                velocity = flowWallVelocity(evalCurrent(p));
            }
            p += h * velocity;
        }
    }
    age += dt;

    // Do not let a numerical overshoot write a poisoned state for a frame.
    // It respawns immediately; the next frame will advect the new sample.
    if (length(p) >= uRMax || any(isnan(p)) || any(isinf(p))) {
        p = flowSpawn(id, float(uFlowFrame) + 911.0);
        age = 0.0;
    }

    outPositionAge = vec4(p, age);
}
