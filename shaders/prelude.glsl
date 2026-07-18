#version 300 es
// ============================================================================
// prelude.glsl — the version/precision header every fragment shader shares.
//
// Hosts assemble each fragment shader as:  prelude.glsl + common.glsl + <view>.frag
// (#version must be the first line of the compiled source, which is why the
// view files themselves carry no version directive.)
//
// highp float is IEEE-754 binary32 on every WebGL2 implementation and on
// desktop GL — the FP32 arithmetic contract that lab/scripts/validate.jl
// certified end-to-end against BigFloat ground truth.
// ============================================================================
precision highp float;
precision highp int;
precision highp sampler2D;
