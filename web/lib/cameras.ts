// =============================================================================
// cameras.ts — the two interactive 3D cameras.
//
// Conventions match the offline CLI (export/Program.cs) exactly, so a camera
// preset found pleasing in the web demo transfers verbatim to a still render:
// azimuth is measured around +z from +x, elevation above the xy-plane,
// distance in multiples of the state's framing radius, world-up is +z.
//
//   • Orbit: drag to rotate about the origin, wheel to dolly. The default
//     view (az 35°, el 25°, 2.6×) is the gallery's ¾ view.
//   • Fly (FPS explorer): pointer-lock mouse look + WASD / E,Q flying, with
//     speed in framing radii per second (Shift ×3). Entering fly mode seeds
//     the pose from the current orbit view, so the transition is seamless.
//
// The rig only produces a position + orthonormal basis each frame; projection
// (FOV/aspect) lives in the volume shader's uniforms.
// =============================================================================

import { cross, norm, scale, type Vec3 } from "./vec3";

export interface CameraPose {
  pos: Vec3;
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
}

const DEG = Math.PI / 180;

/** Orthonormal look-along basis with world-up +z (elevation is clamped below
 * ±90°, so the up-reference never degenerates). */
function lookBasis(pos: Vec3, fwd: Vec3): CameraPose {
  const right = norm(cross(fwd, [0, 0, 1]));
  return { pos, right, up: cross(right, fwd), fwd };
}

export class CameraRig {
  mode: "orbit" | "fly" = "orbit";

  // Orbit state (CLI defaults: the gallery ¾ view).
  azDeg = 35;
  elDeg = 25;
  /** Distance in framing radii. */
  dist = 2.6;

  // Fly state (seeded from the orbit pose on mode switch).
  flyPos: Vec3 = [0, 0, 0];
  yawDeg = 0;
  pitchDeg = 0;
  /** Framing radii per second. */
  flySpeed = 0.6;

  private keys = new Set<string>();

  /** Current pose; `framing` converts radius-relative distances to a₀. */
  pose(framing: number): CameraPose {
    if (this.mode === "orbit") {
      const az = this.azDeg * DEG;
      const el = this.elDeg * DEG;
      const d = this.dist * framing;
      const pos: Vec3 = [
        d * Math.cos(el) * Math.cos(az),
        d * Math.cos(el) * Math.sin(az),
        d * Math.sin(el),
      ];
      return lookBasis(pos, norm(scale(pos, -1)));
    }
    const yaw = this.yawDeg * DEG;
    const pitch = this.pitchDeg * DEG;
    const fwd: Vec3 = [
      Math.cos(pitch) * Math.cos(yaw),
      Math.cos(pitch) * Math.sin(yaw),
      Math.sin(pitch),
    ];
    return lookBasis(this.flyPos, fwd);
  }

  /** Switch modes; entering fly continues from the orbit view's pose. */
  setMode(mode: "orbit" | "fly", framing: number) {
    if (mode === "fly" && this.mode === "orbit") {
      const { pos } = this.pose(framing);
      this.flyPos = pos;
      // Looking at the origin: yaw/pitch of −pos.
      this.yawDeg = Math.atan2(-pos[1], -pos[0]) / DEG;
      this.pitchDeg = Math.asin(-pos[2] / Math.hypot(...pos)) / DEG;
    }
    this.mode = mode;
  }

  drag(dx: number, dy: number) {
    if (this.mode === "orbit") {
      this.azDeg -= dx * 0.3;
      this.elDeg = Math.min(89, Math.max(-89, this.elDeg + dy * 0.3));
    }
  }

  /** Pointer-lock mouse look (fly mode). */
  look(dx: number, dy: number) {
    this.yawDeg -= dx * 0.12;
    this.pitchDeg = Math.min(89, Math.max(-89, this.pitchDeg - dy * 0.12));
  }

  wheel(deltaY: number) {
    if (this.mode === "orbit")
      this.dist = Math.min(12, Math.max(1.05, this.dist * Math.exp(deltaY * 0.001)));
  }

  keyDown(code: string) {
    this.keys.add(code);
  }
  keyUp(code: string) {
    this.keys.delete(code);
  }
  clearKeys() {
    this.keys.clear();
  }

  /** Integrate fly-mode motion over dt seconds. */
  update(dt: number, framing: number) {
    if (this.mode !== "fly") return;
    const { right, fwd } = this.pose(framing);
    const v = this.flySpeed * framing * (this.keys.has("ShiftLeft") ? 3 : 1) * dt;
    const move = (dir: Vec3, s: number) => {
      this.flyPos = [
        this.flyPos[0] + dir[0] * s,
        this.flyPos[1] + dir[1] * s,
        this.flyPos[2] + dir[2] * s,
      ];
    };
    if (this.keys.has("KeyW")) move(fwd, v);
    if (this.keys.has("KeyS")) move(fwd, -v);
    if (this.keys.has("KeyD")) move(right, v);
    if (this.keys.has("KeyA")) move(right, -v);
    if (this.keys.has("KeyE")) move([0, 0, 1], v);
    if (this.keys.has("KeyQ")) move([0, 0, 1], -v);
  }
}
