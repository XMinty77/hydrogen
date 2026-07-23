// ============================================================================
// slice.frag — 2D planar cross-section of ψ.  (no #version: see prelude.glsl)
//
// The cutting plane is fully general: a world-space origin plus two in-plane
// half-extent axis vectors. Axis-aligned cuts, rotated cuts, offset cuts, and
// the web demo's interactively dragged plane are all just different uniform
// values — this shader never changes.
//
//   world(uv) = uOrigin + (2·uv.x − 1)·uAxisU + (2·uv.y − 1)·uAxisV
//
// Color modes (uColorMode; the shared colorLDR in common.glsl decodes them):
//   0  ramp    — brightness through the palette ramp (the classic look)
//   1  signed  — real mode only: ramp for ψ > 0, hue-reflected for ψ < 0
//   2  phase   — complex mode: hue = arg ψ (OKLCH wheel), brightness = |ψ|
//   3  okphase — the ramp's own color, hue-rotated in OKLCH by arg ψ
// ============================================================================

uniform vec3 uOrigin;      // plane center, world (a₀)
uniform vec3 uAxisU;       // world vector spanning uv.x ∈ [0,1] → [−1,1]·uAxisU
uniform vec3 uAxisV;       // world vector spanning uv.y likewise
                           // (uColorMode is declared in common.glsl)

in vec2 vUv;
out vec4 fragColor;

void main() {
    vec3 p = uOrigin + (2.0 * vUv.x - 1.0) * uAxisU + (2.0 * vUv.y - 1.0) * uAxisV;
    vec2 psi = evalPsi(p);
    float bright = brightnessOf(psi);

    vec3 color = flowBaseColor(colorLDR(psi, bright));
    fragColor = vec4(dither(color, gl_FragCoord.xy), 1.0);
}
