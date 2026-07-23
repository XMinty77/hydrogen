// ============================================================================
// flow_decay.frag — temporal persistence for advected tracer deposits.
// (no #version: see prelude.glsl)
//
// This buffer contains only past particle observations. Fading and a tiny
// optional screen-space diffusion make continuous silk from a finite ensemble;
// neither operation invents a direction or moves a mark independently of the
// underlying trajectories.
// ============================================================================

uniform sampler2D uFlowTrail;
uniform vec2  uFlowTexel;
uniform float uFlowRetention;
uniform float uFlowTrailDiffusion;

in vec2 vUv;
out vec4 fragColor;

void main() {
    vec4 c = texture(uFlowTrail, vUv);
    vec4 blur = 0.25 * (texture(uFlowTrail, vUv + vec2(uFlowTexel.x, 0.0))
                      + texture(uFlowTrail, vUv - vec2(uFlowTexel.x, 0.0))
                      + texture(uFlowTrail, vUv + vec2(0.0, uFlowTexel.y))
                      + texture(uFlowTrail, vUv - vec2(0.0, uFlowTexel.y)));
    c = mix(c, blur, clamp(uFlowTrailDiffusion, 0.0, 1.0));
    if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0);
    fragColor = c * clamp(uFlowRetention, 0.0, 1.0);
}
