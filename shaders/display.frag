// ============================================================================
// display.frag — resolve pass for the path tracer's progressive accumulation.
// (no #version: see prelude.glsl; library: common.glsl)
//
// The accumulation texture holds (Σ radiance, sample count) in RGBA32F.
// This pass divides to the mean, applies the shared display transform
// (uExposure EV shift + linear-clamp or AgX tonemap), and dithers — the same
// output stage every other integrator ends with, so path-traced frames are
// directly comparable to EA/scatter frames at identical settings.
// ============================================================================

uniform sampler2D uAccum;

in vec2 vUv;
out vec4 fragColor;

void main() {
    vec4 a = texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0);
    vec3 hdr = a.rgb / max(a.a, 1.0);
    fragColor = vec4(dither(flowBaseColor(displayTransform(hdr)), gl_FragCoord.xy), 1.0);
}
