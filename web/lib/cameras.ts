// =============================================================================
// cameras.ts — the interactive 3D cameras.
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
//   • Center-locked fly (toggled with C inside fly mode): the view is locked
//     toward the origin; A/D and E/Q slide you around the sphere of the
//     current radius, W/S move you radially in and out — an FPS-feeling
//     orbit for inspecting an orbital from every side without ever losing it.
//
// All angles are canonical: azimuths wrap to (−180°, 180°], elevations clamp
// to ±89° (so the world-up reference never degenerates), distances clamp to
// [0.15, 12] framing radii — the low bound lets you dolly right into the core
// (domainSegment handles a camera inside the domain ball).
//
// The rig only produces a position + orthonormal basis each frame; projection
// (FOV/aspect) lives in the volume shader's uniforms.
// =============================================================================

import { wrapDeg } from "./params";
import { cross, norm, scale, type Vec3 } from "./vec3";

export interface CameraPose {
  pos: Vec3;
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
}

const DEG = Math.PI / 180;
const MIN_DIST = 0.15;
const MAX_DIST = 12;

/** Orthonormal look-along basis with world-up +z (elevation is clamped below
 * ±90°, so the up-reference never degenerates). */
function lookBasis(pos: Vec3, fwd: Vec3): CameraPose {
  const right = norm(cross(fwd, [0, 0, 1]));
  return { pos, right, up: cross(right, fwd), fwd };
}

export class CameraRig {
  mode: "orbit" | "fly" = "orbit";
  /** Fly-mode option: keep looking at the origin and move on spheres. */
  centerLock = false;

  // Orbit / center-locked state (CLI defaults: the gallery ¾ view).
  azDeg = 35;
  elDeg = 25;
  /** Distance in framing radii. */
  dist = 2.6;

  // Free-fly state (seeded from the orbit pose on mode switch).
  flyPos: Vec3 = [0, 0, 0];
  yawDeg = 0;
  pitchDeg = 0;
  /** Framing radii per second. */
  flySpeed = 0.6;

  private keys = new Set<string>();

  /** True when the spherical (az/el/dist) state drives the pose. */
  private get spherical(): boolean {
    return this.mode === "orbit" || this.centerLock;
  }

  /** Current pose; `framing` converts radius-relative distances to a₀. */
  pose(framing: number): CameraPose {
    if (this.spherical) {
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
    if (mode === "fly" && this.mode === "orbit" && !this.centerLock)
      this.seedFreeFly(framing);
    this.mode = mode;
  }

  /** Toggle the center-locked variant of fly mode. Turning it ON converts the
   * current free-fly position to spherical coordinates (the view snaps to the
   * origin, radius preserved); turning it OFF resumes free flight from the
   * center-locked pose, still looking at the origin. */
  setCenterLock(on: boolean, framing: number) {
    if (on === this.centerLock) return;
    if (on) {
      if (this.mode === "fly") {
        const [x, y, z] = this.flyPos;
        const len = Math.hypot(x, y, z);
        if (len > 1e-9) {
          this.azDeg = wrapDeg(Math.atan2(y, x) / DEG);
          this.elDeg = Math.max(-89, Math.min(89, Math.asin(z / len) / DEG));
          this.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, len / framing));
        }
      }
      this.centerLock = true;
    } else {
      this.centerLock = false;
      if (this.mode === "fly") this.seedFreeFly(framing);
    }
  }

  /** Seed the free-fly pose from the current spherical pose (looking at the
   * origin), so transitions are seamless. */
  private seedFreeFly(framing: number) {
    const { pos } = this.pose(framing);
    this.flyPos = pos;
    this.yawDeg = Math.atan2(-pos[1], -pos[0]) / DEG;
    this.pitchDeg = Math.asin(-pos[2] / Math.hypot(...pos)) / DEG;
  }

  drag(dx: number, dy: number) {
    if (this.spherical) {
      this.azDeg = wrapDeg(this.azDeg - dx * 0.3);
      this.elDeg = Math.min(89, Math.max(-89, this.elDeg + dy * 0.3));
    }
  }

  /** Pointer-lock mouse look (fly mode). Center-locked, the mouse orbits. */
  look(dx: number, dy: number) {
    if (this.centerLock) {
      this.drag(dx * 0.4, dy * 0.4);
      return;
    }
    this.yawDeg = wrapDeg(this.yawDeg - dx * 0.12);
    this.pitchDeg = Math.min(89, Math.max(-89, this.pitchDeg - dy * 0.12));
  }

  wheel(deltaY: number) {
    if (this.spherical)
      this.dist = Math.min(MAX_DIST, Math.max(MIN_DIST, this.dist * Math.exp(deltaY * 0.001)));
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
    const boost = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? 3 : 1;
    const axis = (plus: string, minus: string) =>
      (this.keys.has(plus) ? 1 : 0) - (this.keys.has(minus) ? 1 : 0);

    if (this.centerLock) {
      // Tangential keys move along the current sphere at flySpeed·framing per
      // second — converted to an angular rate at the current radius, so the
      // apparent speed matches free flight. W/S move radially.
      const angDeg = ((this.flySpeed * boost) / this.dist) * dt * (180 / Math.PI);
      this.azDeg = wrapDeg(this.azDeg - axis("KeyD", "KeyA") * angDeg);
      this.elDeg = Math.min(89, Math.max(-89, this.elDeg + axis("KeyE", "KeyQ") * angDeg));
      this.dist = Math.min(MAX_DIST, Math.max(MIN_DIST,
        this.dist - axis("KeyW", "KeyS") * this.flySpeed * boost * dt));
      return;
    }

    const { right, fwd } = this.pose(framing);
    const v = this.flySpeed * framing * boost * dt;
    const move = (dir: Vec3, s: number) => {
      this.flyPos = [
        this.flyPos[0] + dir[0] * s,
        this.flyPos[1] + dir[1] * s,
        this.flyPos[2] + dir[2] * s,
      ];
    };
    move(fwd, axis("KeyW", "KeyS") * v);
    move(right, axis("KeyD", "KeyA") * v);
    move([0, 0, 1], axis("KeyE", "KeyQ") * v);
  }
}
