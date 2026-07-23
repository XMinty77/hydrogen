// ============================================================================
// flow_volume_update.frag — persistent 3-D passive-tracer advection.
// (no #version: see prelude.glsl; library: common.glsl)
//
// A cubic scalar volume is packed into a tiled 2-D RGBA8 atlas. RGB hold three
// correlated procedural tracer scales and A stores a compact local speed.
// Every material channel is semi-Lagrangian backtraced through
//
//     v = j / (rho + epsilon),    j = Im(conj(psi) grad psi).
//
// The orbital density itself is never displaced or noised. It remains analytic
// and is evaluated afresh in the resolve pass; this atlas is passive material
// whose motion makes that exact probability transport visible.
// ============================================================================

uniform sampler2D uFlowVolumePrevious;
uniform int   uFlowVolumeGrid;
uniform int   uFlowVolumeTilesX;
uniform int   uFlowVolumeTilesY;
uniform bool  uFlowReset;
uniform float uFlowDt;
uniform float uFlowTimeScale;
uniform float uFlowMaxSpeed;
uniform bool  uFlowReverse;
uniform int   uFlowIntegrator;
uniform int   uFlowSubsteps;
uniform int   uFlowSeedMode;
uniform float uFlowSeedPower;
uniform bool  uFlowSeedInsideClips;
uniform float uFlowResetNonce;

uniform float uFlowVolumeNoiseScale;
uniform int   uFlowVolumeNoiseOctaves;
uniform float uFlowVolumeLacunarity;
uniform float uFlowVolumePersistence;
uniform float uFlowVolumeNoiseContrast;
uniform float uFlowVolumeDecay;
uniform float uFlowVolumeInjection;
uniform float uFlowVolumeDiffusion;

out vec4 fragColor;

float volumeHash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}

float volumeValueNoise(vec3 p, float salt) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a000 = volumeHash(i + vec3(0, 0, 0) + salt);
    float a100 = volumeHash(i + vec3(1, 0, 0) + salt);
    float a010 = volumeHash(i + vec3(0, 1, 0) + salt);
    float a110 = volumeHash(i + vec3(1, 1, 0) + salt);
    float a001 = volumeHash(i + vec3(0, 0, 1) + salt);
    float a101 = volumeHash(i + vec3(1, 0, 1) + salt);
    float a011 = volumeHash(i + vec3(0, 1, 1) + salt);
    float a111 = volumeHash(i + vec3(1, 1, 1) + salt);
    float z0 = mix(mix(a000, a100, f.x), mix(a010, a110, f.x), f.y);
    float z1 = mix(mix(a001, a101, f.x), mix(a011, a111, f.x), f.y);
    return mix(z0, z1, f.z);
}

float volumeFbm(vec3 p, float salt, bool lowPass) {
    float sum = 0.0, norm = 0.0, amp = 1.0;
    float lac = max(uFlowVolumeLacunarity, 1.01);
    for (int i = 0; i < 5; i++) {
        if (i >= clamp(uFlowVolumeNoiseOctaves, 1, 5)) break;
        sum += amp * volumeValueNoise(p, salt + float(i) * 19.17);
        norm += amp;
        if (lowPass && i >= 1) break;
        p = p * lac + vec3(11.7, -7.3, 5.9);
        amp *= clamp(uFlowVolumePersistence, 0.0, 1.0);
    }
    return sum / max(norm, 1e-5);
}

vec4 atlasSlice(vec2 xy, int z) {
    int n = uFlowVolumeGrid;
    z = clamp(z, 0, n - 1);
    ivec2 tile = ivec2(z % uFlowVolumeTilesX, z / uFlowVolumeTilesX);
    // Clamp interpolation to texel centres inside one tile. Hardware bilinear
    // then handles x/y, while the caller explicitly interpolates z; adjacent
    // atlas tiles can never bleed into one another.
    vec2 q = clamp(xy, vec2(0.0), vec2(float(n - 1)));
    vec2 pixel = vec2(tile * n) + q + 0.5;
    vec2 atlasSize = vec2(n * uFlowVolumeTilesX, n * uFlowVolumeTilesY);
    return texture(uFlowVolumePrevious, pixel / atlasSize);
}

vec4 sampleAtlas(vec3 p) {
    vec3 q = (p / uRMax * 0.5 + 0.5) * float(uFlowVolumeGrid) - 0.5;
    if (any(lessThan(q, vec3(-0.5))) ||
        any(greaterThan(q, vec3(float(uFlowVolumeGrid) - 0.5)))) return vec4(0.0);
    float z = clamp(q.z, 0.0, float(uFlowVolumeGrid - 1));
    int z0 = int(floor(z));
    return mix(atlasSlice(q.xy, z0), atlasSlice(q.xy, z0 + 1), fract(z));
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

float volumeSeedMask(vec3 p, CurrentSample s) {
    if (uFlowSeedInsideClips && !insideClips(p)) return 0.0;
    if (uFlowSeedMode == 2) return 1.0;
    float x = uFlowSeedMode == 0
        ? clamp(s.rho / max(uQ999, 1e-30), 0.0, 1.0)
        : 1.0 - exp(-length(s.j) * uRMax / max(uQ999, 1e-30));
    return pow(x, max(uFlowSeedPower, 0.01));
}

vec3 volumeSource(vec3 p, CurrentSample s) {
    vec3 unitP = p / max(uRMax, 1e-20);
    // The source is fixed in world space. Coherent motion can therefore come
    // only from probability-current advection.
    vec3 q = unitP * max(uFlowVolumeNoiseScale, 0.1);
    float salt = uFlowResetNonce * 7.13;
    float fine = volumeFbm(q, salt + 2.3, false);
    float coarse = volumeFbm(q * 0.57 + vec3(17.1, 3.7, -9.2), salt + 41.9, true);
    float detail = volumeFbm(q * 1.31 + vec3(-8.4, 13.2, 4.6), salt + 83.1, false);
    vec3 dye = vec3(fine, coarse, detail);
    dye = pow(clamp(dye, 0.0, 1.0), vec3(max(uFlowVolumeNoiseContrast, 0.05)));
    return dye * volumeSeedMask(p, s);
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

    CurrentSample here = evalCurrent(p);
    vec3 source = volumeSource(p, here);
    float epsRho = max(uCurrentNodeEps * uQ999, 1e-30);
    float rawSpeed = length(here.j) * uRMax / (here.rho + epsRho);
    float compactSpeed = 1.0 - exp(-max(rawSpeed, 0.0));

    if (uFlowReset) {
        fragColor = vec4(source, compactSpeed);
        return;
    }

    float dt = max(uFlowDt, 0.0);
    vec3 back = p;
    int substeps = clamp(uFlowSubsteps, 1, 4);
    float h = dt / float(substeps);
    for (int k = 0; k < 4; k++) {
        if (k >= substeps) break;
        vec3 v0 = flowWallVelocity(evalCurrent(back));
        vec3 velocity = v0;
        if (uFlowIntegrator == 1)
            velocity = flowWallVelocity(evalCurrent(back - 0.5 * h * v0));
        back -= h * velocity;
    }

    vec3 dye;
    if (dot(back, back) >= uRMax * uRMax) {
        dye = source;
    } else {
        dye = sampleAtlas(back).rgb;
        float cell = 2.0 * uRMax / float(n);
        vec3 neighbors = (
            sampleAtlas(back + vec3(cell, 0, 0)).rgb +
            sampleAtlas(back - vec3(cell, 0, 0)).rgb +
            sampleAtlas(back + vec3(0, cell, 0)).rgb +
            sampleAtlas(back - vec3(0, cell, 0)).rgb +
            sampleAtlas(back + vec3(0, 0, cell)).rgb +
            sampleAtlas(back - vec3(0, 0, cell)).rgb) / 6.0;
        // Bounded relaxation toward the six-neighbour mean avoids the
        // stability restriction of an explicit Laplacian step.
        dye = mix(dye, neighbors, clamp(uFlowVolumeDiffusion * dt, 0.0, 1.0));
        dye *= exp(-max(uFlowVolumeDecay, 0.0) * dt);
        dye += (1.0 - exp(-max(uFlowVolumeInjection, 0.0) * dt)) * source;
    }

    fragColor = vec4(clamp(dye, 0.0, 1.0), compactSpeed);
}
