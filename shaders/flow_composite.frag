// ============================================================================
// flow_composite.frag — HDR trail resolve over the completed base render.
// (no #version: see prelude.glsl; library: common.glsl)
// ============================================================================

uniform sampler2D uFlowTrail;
uniform float uFlowEmission;
uniform float uFlowCompositeOpacity;
uniform int   uFlowCompositeMode;  // 0 additive, 1 screen, 2 premult alpha

in vec2 vUv;
out vec4 fragColor;

void main() {
    vec4 t = texture(uFlowTrail, vUv);
    if (any(isnan(t)) || any(isinf(t))) {
        fragColor = vec4(0.0);
        return;
    }
    float a = 1.0 - exp(-max(uFlowCompositeOpacity, 0.0) * t.a);
    vec3 c = displayTransform(max(t.rgb, 0.0) * max(uFlowEmission, 0.0));
    if (uFlowCompositeMode == 2) c *= a;
    else c *= max(uFlowCompositeOpacity, 0.0);
    fragColor = vec4(c, a);
}
