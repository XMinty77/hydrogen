// ============================================================================
// axes.frag — analytic 3-D orientation axes, drawn as a blended overlay.
// (no #version: see prelude.glsl. This shader is compiled WITHOUT common.glsl —
// it needs none of the ψ machinery, only the camera basis — so it declares its
// own small uniform set.)
//
// The rest of the pipeline is a fullscreen raymarcher with no vertex/geometry
// stage, so the axes are drawn the same way: a fullscreen pass that, for each
// pixel, measures its screen-space distance to each projected axis segment and
// paints an anti-aliased colored line. X → red, Y → green, Z → blue (the
// conventional mapping). Positive arms are bright, negative arms are dim, so the
// handedness and the current rotation are both legible. uAxisLen sets the arm
// length: a small value clusters a compact gizmo around the origin, a huge one
// makes each arm read as an infinite line through the scene (the host picks).
//
// Segments are clipped to a near plane in view space before projection, so an
// arm whose far tip passes behind the camera (when dollied in close) still
// draws correctly instead of wrapping. Output is straight-alpha sRGB, composited
// over the finished frame with normal SRC_ALPHA / ONE_MINUS_SRC_ALPHA blending.
// ============================================================================

uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uTanHalfFov;     // tan(vertical FOV / 2)
uniform float uAspect;         // width / height
uniform vec2  uResolution;     // framebuffer size, pixels
uniform float uAxisLen;        // arm half-length, world (a₀); huge ⇒ "infinite"
uniform float uAxisThickness;  // line half-width, framebuffer pixels (the host
                               // scales it by the render-scale so the apparent
                               // thickness is constant on screen)
uniform float uAxisFeather;    // anti-alias falloff width, framebuffer pixels
                               // (scaled the same way as the thickness)
uniform float uAxisNear;       // view-space near plane, world (a₀) — decoupled
                               // from uAxisLen so an infinite arm keeps a small
                               // near clip instead of hiding the whole origin
uniform float uAxisAlpha;      // overall overlay opacity

in vec2 vUv;
out vec4 fragColor;

// World → camera (view) space: z is depth along the forward axis.
vec3 toView(vec3 w) {
    vec3 rel = w - uCamPos;
    return vec3(dot(rel, uCamRight), dot(rel, uCamUp), dot(rel, uCamFwd));
}

// Perspective view point → pixel coordinates (GL lower-left origin, matching
// gl_FragCoord). Caller guarantees v.z > 0.
vec2 viewToPixel(vec3 v) {
    vec2 ndc = vec2(v.x / (v.z * uTanHalfFov * uAspect), v.y / (v.z * uTanHalfFov));
    return (ndc * 0.5 + 0.5) * uResolution;
}

// Clip a view-space segment against z ≥ near. Returns false if fully behind.
bool clipNear(inout vec3 a, inout vec3 b, float near) {
    bool ain = a.z >= near, bin = b.z >= near;
    if (!ain && !bin) return false;
    if (ain != bin) {
        vec3 hit = mix(a, b, (near - a.z) / (b.z - a.z));
        if (ain) b = hit; else a = hit;
    }
    return true;
}

// Distance from point p to the segment [a, b], all in pixels.
float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
}

// One arm: origin → dir·len in world. Accumulates its colored contribution.
void arm(vec2 frag, float near, vec3 dir, float len, vec3 col, float alpha,
         inout vec3 rgb, inout float cov) {
    vec3 a = toView(vec3(0.0));
    vec3 b = toView(dir * len);
    if (!clipNear(a, b, near)) return;
    float d = segDist(frag, viewToPixel(a), viewToPixel(b));
    float c = alpha * (1.0 - smoothstep(uAxisThickness, uAxisThickness + uAxisFeather, d));
    if (c <= cov) return;                     // keep the nearest/strongest line
    rgb = col;
    cov = c;
}

void main() {
    vec2 frag = gl_FragCoord.xy;
    float near = max(uAxisNear, 1e-4);

    vec3 rgb = vec3(0.0);
    float cov = 0.0;
    // Negative arms first (dim), then positive (bright) so ties favor positive.
    arm(frag, near, vec3(-1, 0, 0), uAxisLen, vec3(0.90, 0.25, 0.25), 0.30, rgb, cov);
    arm(frag, near, vec3(0, -1, 0), uAxisLen, vec3(0.35, 0.85, 0.35), 0.30, rgb, cov);
    arm(frag, near, vec3(0, 0, -1), uAxisLen, vec3(0.40, 0.55, 1.00), 0.30, rgb, cov);
    arm(frag, near, vec3(1, 0, 0), uAxisLen, vec3(0.95, 0.30, 0.30), 0.95, rgb, cov);
    arm(frag, near, vec3(0, 1, 0), uAxisLen, vec3(0.40, 0.95, 0.40), 0.95, rgb, cov);
    arm(frag, near, vec3(0, 0, 1), uAxisLen, vec3(0.45, 0.62, 1.00), 0.95, rgb, cov);

    fragColor = vec4(rgb, cov * uAxisAlpha);
}
