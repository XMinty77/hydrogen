// ============================================================================
// post_bloom_blur.frag — separable nine-tap Gaussian bloom blur.
//
// Linear texture filtering folds neighboring taps together. Repeating the
// horizontal/vertical pair broadens the point-spread function without a large
// fixed shader kernel; uRadius controls each pair's footprint independently.
// ============================================================================

uniform sampler2D uSource;
uniform vec2 uDirection;

in vec2 vUv;
out vec4 fragColor;

void main() {
    vec3 c = texture(uSource, vUv).rgb * 0.2270270270;
    c += texture(uSource, vUv + uDirection * 1.3846153846).rgb * 0.3162162162;
    c += texture(uSource, vUv - uDirection * 1.3846153846).rgb * 0.3162162162;
    c += texture(uSource, vUv + uDirection * 3.2307692308).rgb * 0.0702702703;
    c += texture(uSource, vUv - uDirection * 3.2307692308).rgb * 0.0702702703;
    fragColor = vec4(c, 1.0);
}
