// =============================================================================
// scene.ts — slice-plane and clip-plane geometry derived from the UI params.
// =============================================================================

import type { CameraPose } from "./cameras";
import type { ClipParams, Params } from "./params";
import { cross, norm, scale, type Vec3 } from "./vec3";

const DEG = Math.PI / 180;

/** Slice-plane geometry. Presets replicate export/Program.cs verbatim (so web
 * and CLI slices are directly comparable); "custom" builds the plane from an
 * (azimuth, elevation) normal, an in-plane roll, and a normal offset. */
export function slicePlaneVectors(p: Params, framing: number) {
  const ext = framing / p.sliceZoom;
  const off = p.sliceOffset * framing;
  switch (p.slicePlane) {
    case "xz":
      return { origin: [0, off, 0], axisU: [ext, 0, 0], axisV: [0, 0, ext] } as
        { origin: Vec3; axisU: Vec3; axisV: Vec3 };
    case "xy":
      return { origin: [0, 0, off] as Vec3, axisU: [ext, 0, 0] as Vec3, axisV: [0, ext, 0] as Vec3 };
    case "yz":
      return { origin: [off, 0, 0] as Vec3, axisU: [0, ext, 0] as Vec3, axisV: [0, 0, ext] as Vec3 };
    case "custom": {
      const az = p.sliceAz * DEG;
      const el = p.sliceEl * DEG;
      const n: Vec3 = [
        Math.cos(el) * Math.cos(az),
        Math.cos(el) * Math.sin(az),
        Math.sin(el),
      ];
      // In-plane frame: reference-projected axes (z-reference, x fallback near
      // the poles), chosen so custom(az=90°, el=0°, roll=0°) ≡ the xz preset.
      const ref: Vec3 = Math.abs(n[2]) > 0.99 ? [1, 0, 0] : [0, 0, 1];
      const u0 = norm(cross(n, ref));
      const v0 = cross(u0, n);
      const cr = Math.cos(p.sliceRoll * DEG);
      const sr = Math.sin(p.sliceRoll * DEG);
      return {
        origin: scale(n, off),
        axisU: scale(
          [u0[0] * cr + v0[0] * sr, u0[1] * cr + v0[1] * sr, u0[2] * cr + v0[2] * sr],
          ext,
        ) as Vec3,
        axisV: scale(
          [v0[0] * cr - u0[0] * sr, v0[1] * cr - u0[1] * sr, v0[2] * cr - u0[2] * sr],
          ext,
        ) as Vec3,
      };
    }
  }
}

/** Clip planes: each active clip keeps the half-space dot(axis, p) ≥
 * offset·framing (or ≤, when flipped), where axis is a basis vector of a
 * camera pose — the *initial* camera's by default (a world-fixed cut you can
 * orbit around to inspect), or the live camera's when camLock is on (the cut
 * rides with the view, carving a viewer-facing cutaway). */
export function clipPlaneVectors(
  clips: [ClipParams, ClipParams],
  livePose: CameraPose,
  basePose: CameraPose,
  framing: number,
): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const c of clips) {
    if (!c.enabled) continue;
    const pose = c.camLock ? livePose : basePose;
    const axis = c.axis === "forward" ? pose.fwd : c.axis === "right" ? pose.right : pose.up;
    const s = c.flip ? -1 : 1;
    out.push([s * axis[0], s * axis[1], s * axis[2], -s * c.offset * framing]);
  }
  return out;
}

/** Seed the custom-plane orientation from a preset (used when a drag begins
 * on a preset slice: the drag continues from the preset's orientation). */
export function seedCustomFromPreset(p: Params) {
  if (p.slicePlane === "custom") return;
  [p.sliceAz, p.sliceEl] =
    p.slicePlane === "xz" ? [90, 0] : p.slicePlane === "yz" ? [0, 0] : [0, 89];
  p.sliceRoll = 0;
  p.slicePlane = "custom";
}
