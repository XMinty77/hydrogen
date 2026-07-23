#version 300 es
// ============================================================================
// flow_particles.vert — instanced camera-facing ribbons for advected tracers.
//
// One six-vertex quad per state-texture texel. The ribbon runs backward from
// the current particle position along its integrated velocity. This is a
// presentation of recent local motion; temporal persistence in flow_decay.frag
// turns successive positions into the longer, genuinely advected trails.
// ============================================================================
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uFlowPositionAge;
uniform sampler2D uFlowPreviousPositionAge;
uniform int   uFlowParticleSide;
uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform vec2  uResolution;
uniform float uRMax;
uniform float uFlowLifetime;
uniform float uFlowDt;
uniform float uFlowMaxSpeed;
uniform float uFlowStreakLength;
uniform float uFlowSpeedStretch;
uniform float uFlowWidthPx;
uniform float uFlowHalo;

out float vAlong;
out float vSide;
out float vSpeed01;
out float vAge01;
out vec3  vWorld;

vec2 projectNdc(vec3 p, out float depth) {
    vec3 q = p - uCamPos;
    depth = dot(q, uCamFwd);
    return vec2(dot(q, uCamRight) / (max(depth, 1e-6) * uTanHalfFov * uAspect),
                dot(q, uCamUp)    / (max(depth, 1e-6) * uTanHalfFov));
}

void main() {
    int id = gl_InstanceID;
    ivec2 tc = ivec2(id % uFlowParticleSide, id / uFlowParticleSide);
    vec4 pa = texelFetch(uFlowPositionAge, tc, 0);
    vec4 previous = texelFetch(uFlowPreviousPositionAge, tc, 0);
    vec3 velocity = uFlowDt > 1e-7 ? (pa.xyz - previous.xyz) / uFlowDt : vec3(0.0);
    // A just-respawned tracer has no valid historical segment yet.
    if (pa.w <= 1.5 * uFlowDt) velocity = vec3(0.0);
    float speed = length(velocity);
    float speed01 = clamp(speed / max(uFlowMaxSpeed * uRMax, 1e-8), 0.0, 1.0);
    vec3 tangent = speed > 1e-10 ? velocity / speed : vec3(1.0, 0.0, 0.0);
    float stretch = mix(1.0, max(speed01, 0.04), clamp(uFlowSpeedStretch, 0.0, 1.0));
    float worldLen = max(uFlowStreakLength * stretch * uRMax, 1e-6 * uRMax);
    vec3 tailWorld = pa.xyz - tangent * worldLen;
    vec3 headWorld = pa.xyz;

    float tailDepth, headDepth;
    vec2 tail = projectNdc(tailWorld, tailDepth);
    vec2 head = projectNdc(headWorld, headDepth);
    bool hidden = tailDepth <= 1e-5 || headDepth <= 1e-5 || pa.w < 0.0
               || any(isnan(pa)) || any(isinf(pa))
               || any(isnan(previous)) || any(isinf(previous));

    vec2 d = head - tail;
    vec2 dPx = d * 0.5 * uResolution;
    if (dot(dPx, dPx) < 0.25) dPx = vec2(1.0, 0.0);
    vec2 perpPx = normalize(vec2(-dPx.y, dPx.x));
    vec2 sideNdc = perpPx * (2.0 * uFlowWidthPx * max(uFlowHalo, 1.0) / uResolution);

    // Two triangles: (tail-, tail+, head-) (head-, tail+, head+).
    const float alongs[6] = float[6](0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    const float sides[6]  = float[6](-1.0, 1.0, -1.0, -1.0, 1.0, 1.0);
    float along = alongs[gl_VertexID];
    float side = sides[gl_VertexID];
    vec2 ndc = mix(tail, head, along) + sideNdc * side;
    if (hidden) ndc = vec2(3.0);
    gl_Position = vec4(ndc, 0.0, 1.0);

    vAlong = along;
    vSide = side;
    vSpeed01 = speed01;
    vAge01 = clamp(pa.w / max(uFlowLifetime, 0.05), 0.0, 1.0);
    vWorld = mix(tailWorld, headWorld, along);
}
