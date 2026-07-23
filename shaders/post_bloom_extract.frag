// ============================================================================
// post_bloom_extract.frag — threshold and downsample the finished scene.
//
// Bloom is deliberately screen-space and display-referred: it can finish any
// analytic technique or probability-flow composite without changing their
// physical integration. The quadratic soft knee avoids a hard halo boundary.
// ============================================================================

uniform sampler2D uScene;
uniform float uThreshold;
uniform float uKnee;
uniform float uSaturation;
uniform vec3  uTint;

in vec2 vUv;
out vec4 fragColor;

void main() {
    vec3 c = max(texture(uScene, vUv).rgb, 0.0);
    float peak = max(c.r, max(c.g, c.b));
    float knee = max(uThreshold * uKnee, 1e-5);
    float soft = clamp(peak - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-5);
    float contribution = max(peak - uThreshold, soft) / max(peak, 1e-5);
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(luma), c, max(uSaturation, 0.0));
    fragColor = vec4(c * max(uTint, 0.0) * contribution, 1.0);
}
