// ============================================================================
// flow_volume_correct.frag — bounded MacCormack correction for 3-D dye.
// (no #version: see prelude.glsl; library: common.glsl)
//
// First-order semi-Lagrangian advection is robust but numerically diffusive.
// We reverse-advect the predictor, estimate its truncation error, and add that
// error back. Clamping to the original field around the departure point keeps
// the correction monotone: it sharpens transported structure without creating
// new extrema/ringing. This is the standard BFECC/MacCormack fluid-graphics
// tradeoff, with a user strength control from plain SL (0) to full correction
// (1).
// ============================================================================

uniform sampler2D uFlowVolumeOriginal;
uniform sampler2D uFlowVolumePredictor;
uniform int   uFlowVolumeGrid;
uniform int   uFlowVolumeTilesX;
uniform int   uFlowVolumeTilesY;
uniform float uFlowDt;
uniform float uFlowTimeScale;
uniform float uFlowMaxSpeed;
uniform bool  uFlowReverse;
uniform int   uFlowIntegrator;
uniform int   uFlowSubsteps;
uniform float uFlowVolumeCorrection;

out vec4 fragColor;

vec4 atlasSlice(sampler2D tex, vec2 xy, int z) {
    int n = uFlowVolumeGrid;
    z = clamp(z, 0, n - 1);
    ivec2 tile = ivec2(z % uFlowVolumeTilesX, z / uFlowVolumeTilesX);
    vec2 q = clamp(xy, vec2(0.0), vec2(float(n - 1)));
    vec2 pixel = vec2(tile * n) + q + 0.5;
    vec2 atlasSize = vec2(n * uFlowVolumeTilesX, n * uFlowVolumeTilesY);
    return texture(tex, pixel / atlasSize);
}

vec4 sampleAtlas(sampler2D tex, vec3 p) {
    vec3 q = (p / uRMax * 0.5 + 0.5) * float(uFlowVolumeGrid) - 0.5;
    if (any(lessThan(q, vec3(-0.5))) ||
        any(greaterThan(q, vec3(float(uFlowVolumeGrid) - 0.5)))) return vec4(0.0);
    float z = clamp(q.z, 0.0, float(uFlowVolumeGrid - 1));
    int z0 = int(floor(z));
    return mix(atlasSlice(tex, q.xy, z0), atlasSlice(tex, q.xy, z0 + 1), fract(z));
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

vec3 tracedPoint(vec3 p, float direction) {
    int substeps = clamp(uFlowSubsteps, 1, 4);
    float h = max(uFlowDt, 0.0) / float(substeps);
    for (int k = 0; k < 4; k++) {
        if (k >= substeps) break;
        vec3 v0 = flowWallVelocity(evalCurrent(p));
        vec3 velocity = v0;
        if (uFlowIntegrator == 1)
            velocity = flowWallVelocity(evalCurrent(p + direction * 0.5 * h * v0));
        p += direction * h * velocity;
    }
    return p;
}

void main() {
    ivec2 tc = ivec2(gl_FragCoord.xy);
    int n = uFlowVolumeGrid;
    ivec2 tile = tc / n;
    ivec2 local = tc - tile * n;
    int z = tile.y * uFlowVolumeTilesX + tile.x;
    if (tile.x >= uFlowVolumeTilesX || tile.y >= uFlowVolumeTilesY || z >= n) {
        fragColor = vec4(0.0);
        return;
    }

    vec3 voxel = vec3(local, z) + 0.5;
    vec3 p = (voxel / float(n) * 2.0 - 1.0) * uRMax;
    if (dot(p, p) >= uRMax * uRMax) {
        fragColor = vec4(0.0);
        return;
    }

    vec4 predictor = sampleAtlas(uFlowVolumePredictor, p);
    if (uFlowVolumeCorrection <= 0.0 || uFlowDt <= 0.0) {
        fragColor = predictor;
        return;
    }

    vec3 departure = tracedPoint(p, -1.0);
    vec3 forward = tracedPoint(p, 1.0);
    vec3 original = sampleAtlas(uFlowVolumeOriginal, p).rgb;
    vec3 reversed = sampleAtlas(uFlowVolumePredictor, forward).rgb;
    vec3 corrected = predictor.rgb + 0.5 * (original - reversed);

    // Monotonicity clamp around the departure point. The uncorrected
    // semi-Lagrangian predictor is always inside this source stencil; forcing
    // MacCormack back into it prevents overshoot and negative dye.
    float cell = 2.0 * uRMax / float(n);
    vec3 lo = sampleAtlas(uFlowVolumeOriginal, departure).rgb;
    vec3 hi = lo;
    vec3 sx = sampleAtlas(uFlowVolumeOriginal, departure + vec3(cell, 0, 0)).rgb;
    vec3 nx = sampleAtlas(uFlowVolumeOriginal, departure - vec3(cell, 0, 0)).rgb;
    vec3 sy = sampleAtlas(uFlowVolumeOriginal, departure + vec3(0, cell, 0)).rgb;
    vec3 ny = sampleAtlas(uFlowVolumeOriginal, departure - vec3(0, cell, 0)).rgb;
    vec3 sz = sampleAtlas(uFlowVolumeOriginal, departure + vec3(0, 0, cell)).rgb;
    vec3 nz = sampleAtlas(uFlowVolumeOriginal, departure - vec3(0, 0, cell)).rgb;
    lo = min(lo, min(min(sx, nx), min(min(sy, ny), min(sz, nz))));
    hi = max(hi, max(max(sx, nx), max(max(sy, ny), max(sz, nz))));
    corrected = clamp(corrected, lo, hi);

    fragColor = vec4(mix(predictor.rgb, corrected,
                         clamp(uFlowVolumeCorrection, 0.0, 1.0)), predictor.a);
}
