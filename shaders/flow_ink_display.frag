// ============================================================================
// flow_ink_display.frag — palette resolve for the advected slice dye.
// (no #version: see prelude.glsl; library: common.glsl)
// ============================================================================

uniform sampler2D uFlowInk;
uniform vec3  uOrigin;
uniform vec3  uAxisU;
uniform vec3  uAxisV;
uniform int   uFlowColorMode;      // 0 palette-speed, 1 palette-dye, 2 phase
uniform float uFlowColorGain;
uniform float uFlowColorFloor;
uniform float uFlowDensityGate;
uniform float uFlowInkContrast;
uniform float uFlowInkOpacity;

in vec2 vUv;
out vec4 fragColor;

void main() {
    float dye = texture(uFlowInk, vUv).r;
    vec3 p = uOrigin + (2.0 * vUv.x - 1.0) * uAxisU
                      + (2.0 * vUv.y - 1.0) * uAxisV;
    CurrentSample s = evalCurrent(p);
    float epsRho = max(uCurrentNodeEps * uQ999, 1e-30);
    float speed = length(s.j) * uRMax / (s.rho + epsRho);
    float speedMapped = 1.0 - exp(-max(uFlowColorGain, 0.0) * speed);
    float signal = 1.0 - exp(-pow(max(dye, 0.0), max(uFlowInkContrast, 0.05)));
    float value = uFlowColorMode == 1 ? signal : speedMapped;
    value = mix(clamp(uFlowColorFloor, 0.0, 1.0), 1.0, clamp(value, 0.0, 1.0));
    vec3 c = uFlowColorMode == 2
        ? phaseColor(atan(s.psi.y, s.psi.x), value)
        : rampColor(value);
    float densityGate = uFlowDensityGate > 0.0
        ? pow(clamp(s.rho / max(uQ999, 1e-30), 0.0, 1.0), uFlowDensityGate)
        : 1.0;
    float a = clamp(uFlowInkOpacity * signal * s.confidence * densityGate, 0.0, 1.0);
    fragColor = vec4(c * a, a);
}
