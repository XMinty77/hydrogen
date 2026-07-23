// ============================================================================
// flow_volume_render.frag — raymarched resolve of an advected 3-D tracer atlas.
// (no #version: see prelude.glsl; library: common.glsl)
//
// The tracer is presented as a sparse stochastic medium with
// expectation-preserving weights. Clip planes trim the analytic ray interval
// via common.glsl's domainSegment.
// ============================================================================

uniform sampler2D uFlowVolume;
uniform int   uFlowVolumeGrid;
uniform int   uFlowVolumeTilesX;
uniform int   uFlowVolumeTilesY;
uniform int   uFlowVolumeSteps;
uniform int   uFlowFrame;
uniform int   uFlowColorMode;
uniform float uFlowColorGain;
uniform float uFlowColorFloor;
uniform float uFlowDensityGate;
uniform float uFlowVolumeSignalGain;
uniform float uFlowVolumeSignalPow;
uniform float uFlowVolumeThreshold;
uniform float uFlowVolumeSoftness;
uniform float uFlowVolumeExtinction;
uniform float uFlowVolumeEmission;
uniform float uFlowVolumeOpacity;
uniform float uFlowVolumeDitherAmount;
uniform float uFlowVolumeDitherScale;
uniform float uFlowVolumeDitherRate;
uniform float uFlowVolumeDitherCoverage;
uniform float uFlowVolumeRayJitter;

in vec2 vUv;
out vec4 fragColor;

float renderHash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}

vec4 atlasSlice(vec2 xy, int z) {
    int n = uFlowVolumeGrid;
    z = clamp(z, 0, n - 1);
    ivec2 tile = ivec2(z % uFlowVolumeTilesX, z / uFlowVolumeTilesX);
    vec2 q = clamp(xy, vec2(0.0), vec2(float(n - 1)));
    vec2 pixel = vec2(tile * n) + q + 0.5;
    vec2 atlasSize = vec2(n * uFlowVolumeTilesX, n * uFlowVolumeTilesY);
    return texture(uFlowVolume, pixel / atlasSize);
}

vec4 sampleAtlas(vec3 p) {
    vec3 q = (p / uRMax * 0.5 + 0.5) * float(uFlowVolumeGrid) - 0.5;
    if (any(lessThan(q, vec3(-0.5))) ||
        any(greaterThan(q, vec3(float(uFlowVolumeGrid) - 0.5)))) return vec4(0.0);
    float z = clamp(q.z, 0.0, float(uFlowVolumeGrid - 1));
    int z0 = int(floor(z));
    return mix(atlasSlice(q.xy, z0), atlasSlice(q.xy, z0 + 1), fract(z));
}

float dyeScalar(vec3 dyes) {
    // R carries full fBm; G is the advected low-pass companion; B is a second
    // full-band realization. Keeping all three transported makes high-pass and
    // variance cues available without inventing post-hoc scrolling texture.
    return dot(dyes, vec3(0.50, 0.30, 0.20));
}

vec3 flowColor(vec2 psi, vec3 dyes, float compactSpeed, float signal) {
    float rawSpeed = -log(max(1.0 - min(compactSpeed, 0.9999), 1e-4));
    float speedMapped = 1.0 - exp(-max(uFlowColorGain, 0.0) * rawSpeed);
    // A transported material coordinate from the three independent dyes.
    float material = fract(dot(dyes, vec3(0.7549, 1.3247, 2.1173)));
    float value = uFlowColorMode == 0 ? speedMapped
                : uFlowColorMode == 1 ? mix(material, signal, 0.28)
                : signal;
    value = mix(clamp(uFlowColorFloor, 0.0, 1.0), 1.0, clamp(value, 0.0, 1.0));
    return uFlowColorMode == 2
        ? phaseColorLinear(atan(psi.y, psi.x), value)
        : rampColorLinear(value);
}

void main() {
    vec3 dir = primaryRay(vUv);
    float t0, t1;
    if (!domainSegment(uCamPos, dir, t0, t1)) {
        fragColor = vec4(0.0);
        return;
    }

    int steps = clamp(uFlowVolumeSteps, 8, 256);
    float dt = (t1 - t0) / float(steps);
    float jitterFrame = floor(float(uFlowFrame)
                              * max(uFlowVolumeDitherRate, 0.0) / 60.0);
    float pixelNoise = renderHash(vec3(gl_FragCoord.xy, jitterFrame * 0.017));
    float jitter = mix(0.5, pixelNoise, clamp(uFlowVolumeRayJitter, 0.0, 1.0));
    vec3 accum = vec3(0.0);
    float transmit = 1.0;

    for (int i = 0; i < 256; i++) {
        if (i >= steps) break;
        vec3 p = uCamPos + (t0 + (float(i) + jitter) * dt) * dir;
        vec4 tracer = sampleAtlas(p);
        float dye = dyeScalar(tracer.rgb);
        float signal = 1.0 - exp(-max(uFlowVolumeSignalGain, 0.0)
                                 * pow(max(dye, 0.0), max(uFlowVolumeSignalPow, 0.05)));

        float lo = uFlowVolumeThreshold - max(uFlowVolumeSoftness, 1e-4);
        float hi = uFlowVolumeThreshold + max(uFlowVolumeSoftness, 1e-4);
        signal *= smoothstep(lo, hi, signal);

        if (signal > 0.0) {
            float frameBucket = floor(float(uFlowFrame) * max(uFlowVolumeDitherRate, 0.0) / 60.0);
            vec3 grainCell = floor((p / uRMax + 1.0)
                                   * max(uFlowVolumeDitherScale, 1.0));
            float grain = renderHash(grainCell + vec3(frameBucket * 17.0,
                                                       frameBucket * 7.0,
                                                       frameBucket * 3.0));
            float sparseProb = clamp(signal * uFlowVolumeDitherCoverage, 0.01, 1.0);
            float keep = grain < sparseProb ? 1.0 / sparseProb : 0.0;
            signal *= mix(1.0, keep, clamp(uFlowVolumeDitherAmount, 0.0, 1.0));
        }

        if (signal > 1e-5) {
            vec2 psi = evalPsi(p);             // exact analytic density/phase
            float rho = dot(psi, psi);
            float densityGate = uFlowDensityGate > 0.0
                ? pow(clamp(rho / max(uQ999, 1e-30), 0.0, 1.0), uFlowDensityGate)
                : 1.0;
            float medium = max(signal * densityGate, 0.0);
            float alpha = 1.0 - exp(-max(uFlowVolumeExtinction, 0.0)
                                    * medium * dt / uRMax);
            vec3 c = flowColor(psi, tracer.rgb, tracer.a, min(signal, 1.0));
            accum += transmit * alpha * max(uFlowVolumeEmission, 0.0) * c;
            transmit *= 1.0 - alpha;
            if (transmit < 0.003) break;
        }
    }

    float alpha = clamp((1.0 - transmit) * uFlowVolumeOpacity, 0.0, 1.0);
    vec3 shown = displayTransform(accum * max(uFlowVolumeOpacity, 0.0));
    fragColor = vec4(shown, alpha);
}
