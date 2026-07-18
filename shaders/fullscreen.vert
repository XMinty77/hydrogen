#version 300 es
// ============================================================================
// fullscreen.vert — one triangle covering the viewport, no vertex buffers.
//
// gl_VertexID ∈ {0,1,2} → (−1,−1), (3,−1), (−1,3): a triangle whose clipped
// area is exactly the viewport. vUv ∈ [0,1]² inside the visible region.
// Shared by every render pass in the project.
// ============================================================================
out vec2 vUv;

void main() {
    vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0,
                  gl_VertexID == 2 ? 3.0 : -1.0);
    vUv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
}
