// ============================================================================
// flow_particles.frag — emissive tracer-ribbon deposition.
// (no #version: see prelude.glsl; library: common.glsl)
//
// Output is premultiplied linear RGB into an HDR trail buffer. A narrow core
// plus a broad analytic halo gives the accretion treatment its hot filaments
// without a separate blur pass. All color comes from the active editable ramp
// or phase wheel.
// ============================================================================

uniform int   uFlowColorMode;      // 0 palette-speed, 1 palette-age/material, 2 phase
uniform float uFlowColorGain;
uniform float uFlowColorFloor;
uniform float uFlowDensityGate;
uniform float uFlowOpacity;
uniform float uFlowHalo;
uniform float uFlowHaloGain;
uniform float uFlowTailPower;
uniform float uFlowHeadBoost;
uniform bool  uFlowClipVisible;

in float vAlong;
in float vSide;
in float vSpeed01;
in float vAge01;
in vec3  vWorld;
out vec4 fragColor;

void main() {
    if (uFlowClipVisible && !insideClips(vWorld)) discard;

    float halo = max(uFlowHalo, 1.0);
    float radialPx = abs(vSide) * halo;
    float core = exp(-2.2 * radialPx * radialPx);
    float aura = exp(-2.2 * vSide * vSide) * max(uFlowHaloGain, 0.0);
    float tail = mix(max(uFlowColorFloor, 0.0), 1.0,
                     pow(clamp(vAlong, 0.0, 1.0), max(uFlowTailPower, 0.05)));
    float head = 1.0 + max(uFlowHeadBoost, 0.0)
               * exp(-pow((1.0 - vAlong) * 7.0, 2.0));
    float shape = (core + aura) * tail * head;

    float value = uFlowColorMode == 1
        ? fract(vAge01 + 0.12)
        : 1.0 - exp(-max(uFlowColorGain, 0.0) * vSpeed01);
    value = mix(clamp(uFlowColorFloor, 0.0, 1.0), 1.0, clamp(value, 0.0, 1.0));
    vec2 psi = vec2(0.0);
    bool needPsi = uFlowColorMode == 2 || uFlowDensityGate > 0.0;
    if (needPsi) psi = evalPsi(vWorld);
    vec3 color;
    if (uFlowColorMode == 2) {
        color = phaseColorLinear(atan(psi.y, psi.x), value);
    } else {
        color = rampColorLinear(value);
    }
    float densityGate = uFlowDensityGate > 0.0
        ? pow(clamp(dot(psi, psi) / max(uQ999, 1e-30), 0.0, 1.0), uFlowDensityGate)
        : 1.0;
    float a = max(uFlowOpacity, 0.0) * shape * densityGate;
    fragColor = vec4(color * a, a);
}
