"use client";

// =============================================================================
// OrbitalViewer.tsx — the interactive demo: one fullscreen WebGL2 canvas, a
// lil-gui control panel, and a render loop over the shared GLSL renderer.
//
// Layers (each documented in its own module):
//   lib/horb.ts      — baked-asset reader (tables + display stats)
//   lib/palettes.ts  — palette definitions
//   lib/renderer.ts  — shader assembly + uniform upload (the C# host's twin)
//   lib/cameras.ts   — orbit + fly cameras (CLI-compatible conventions)
//
// This file owns what remains: UI state, its mapping to render parameters
// (slice-plane construction, camera-locked clip planes), input handling, and
// the requestAnimationFrame loop.
//
// URL parameters mirror the offline CLI (?state=4,2,1&view=volume&mode=complex
// &camera=35,25,2.6&size=1024 …) so any view is shareable/scriptable — the
// screenshot harness (scripts/shot.mjs) drives the app through them and waits
// for window.__renderReady.
// =============================================================================

import GUI from "lil-gui";
import { useEffect, useRef } from "react";
import { CameraRig, type CameraPose } from "../lib/cameras";
import { framingRadius, loadHorb } from "../lib/horb";
import { loadPalettes } from "../lib/palettes";
import { OrbitalRenderer, type CommonParams } from "../lib/renderer";
import { cross, norm, scale, type Vec3 } from "../lib/vec3";

const DEG = Math.PI / 180;

type ClipAxis = "forward" | "right" | "up";

interface ClipParams {
  enabled: boolean;
  axis: ClipAxis;
  /** Plane offset from the origin along the axis, in framing radii. */
  offset: number;
  /** Keep the near side instead of the far side. */
  flip: boolean;
  /** Follow the live camera (the axis re-orients every frame) instead of
   * staying fixed at the initial camera's axes (the default — user decision
   * 2026-07-19: a cut that rides the camera disorients while orbiting). */
  camLock: boolean;
}

/** The full UI state. Defaults reproduce the offline CLI's defaults so web
 * and stills start from the same picture. */
function defaultParams() {
  return {
    view: "volume" as "slice" | "volume",
    n: 4,
    l: 2,
    m: 1,
    mode: "real" as "real" | "complex",
    color: "ramp" as "ramp" | "signed" | "phase",
    value: "density" as "density" | "amplitude",
    gamma: 0.45,
    dither: true,
    ramp: "accretion_tuned",
    rampSpace: "oklab" as "oklab" | "srgb",
    phaseVivid: true,
    phaseChromaPow: 0.6,
    /** Canvas backing-store scale relative to CSS pixels × devicePixelRatio. */
    renderScale: 1.0,

    // Slice: presets use the CLI's exact axes; "custom" orients the plane
    // normal by azimuth/elevation, spins it with roll, and slides it along
    // its normal. Dragging on the canvas rotates the custom plane.
    slicePlane: "xz" as "xz" | "xy" | "yz" | "custom",
    sliceAz: 90,
    sliceEl: 0,
    sliceRoll: 0,
    /** Offset along the plane normal, in framing radii. */
    sliceOffset: 0,
    sliceZoom: 1,

    // Volume. EA defaults are the user-tuned values of 2026-07-19; the
    // density range is deliberately narrow — beyond ~50 everything is fog
    // (the offline CLI still accepts anything, for bulk-structure looks).
    integrator: "mip" as "mip" | "ea",
    steps: 400,
    density: 5,
    opacityPow: 2.15,
    emission: 5,
    fov: 40,
    clips: [
      { enabled: false, axis: "forward", offset: 0, flip: false, camLock: false },
      { enabled: false, axis: "up", offset: 0, flip: false, camLock: false },
    ] as [ClipParams, ClipParams],
  };
}
type Params = ReturnType<typeof defaultParams>;

const COLOR_MODE = { ramp: 0, signed: 1, phase: 2 } as const;

/** Apply ?key=value overrides (see file header). Unknown keys are ignored. */
function applyUrlOverrides(p: Params, search: string) {
  const q = new URLSearchParams(search);
  const num = (k: string, set: (v: number) => void) => {
    const v = q.get(k);
    if (v !== null && Number.isFinite(+v)) set(+v);
  };
  const str = <T extends string>(k: string, allowed: T[], set: (v: T) => void) => {
    const v = q.get(k);
    if (v !== null && (allowed as string[]).includes(v)) set(v as T);
  };

  const state = q.get("state")?.split(",").map(Number);
  if (state?.length === 3 && state.every(Number.isFinite))
    [p.n, p.l, p.m] = state;
  str("view", ["slice", "volume"], (v) => (p.view = v));
  str("mode", ["real", "complex"], (v) => {
    p.mode = v;
    p.color = v === "real" ? "ramp" : "phase";
  });
  str("color", ["ramp", "signed", "phase"], (v) => (p.color = v));
  str("value", ["density", "amplitude"], (v) => (p.value = v));
  num("gamma", (v) => (p.gamma = v));
  if (q.get("ramp")) p.ramp = q.get("ramp")!;
  str("rampSpace", ["oklab", "srgb"], (v) => (p.rampSpace = v));
  if (q.get("vivid") === "0") p.phaseVivid = false;
  num("chromaPow", (v) => (p.phaseChromaPow = v));
  if (q.get("dither") === "0") p.dither = false;
  num("scale", (v) => (p.renderScale = v));

  str("plane", ["xz", "xy", "yz", "custom"], (v) => (p.slicePlane = v));
  num("az", (v) => (p.sliceAz = v));
  num("el", (v) => (p.sliceEl = v));
  num("roll", (v) => (p.sliceRoll = v));
  num("offset", (v) => (p.sliceOffset = v));
  num("zoom", (v) => (p.sliceZoom = v));

  str("integrator", ["mip", "ea"], (v) => (p.integrator = v));
  num("steps", (v) => (p.steps = Math.round(v)));
  num("density", (v) => (p.density = v));
  num("opacityPow", (v) => (p.opacityPow = v));
  num("emission", (v) => (p.emission = v));
  num("fov", (v) => (p.fov = v));

  // clip=axis,offset[,flip[,camLock]] — repeatable (first → clip A, …).
  q.getAll("clip").forEach((spec, i) => {
    if (i >= 2) return;
    const [axis, offset, flip, camLock] = spec.split(",");
    if (axis === "forward" || axis === "right" || axis === "up")
      p.clips[i] = {
        enabled: true,
        axis,
        offset: Number.isFinite(+offset) ? +offset : 0,
        flip: flip === "1",
        camLock: camLock === "1",
      };
  });
}

/** Slice-plane geometry. Presets replicate export/Program.cs verbatim (so web
 * and CLI slices are directly comparable); "custom" builds the plane from an
 * (azimuth, elevation) normal, an in-plane roll, and a normal offset. */
function slicePlaneVectors(p: Params, framing: number) {
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
function clipPlaneVectors(
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
function seedCustomFromPreset(p: Params) {
  if (p.slicePlane === "custom") return;
  [p.sliceAz, p.sliceEl] =
    p.slicePlane === "xz" ? [90, 0] : p.slicePlane === "yz" ? [0, 0] : [0, 89];
  p.sliceRoll = 0;
  p.slicePlane = "custom";
}

export default function OrbitalViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const statsEl = statsRef.current!;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const on = <K extends keyof WindowEventMap>(
      target: Window | Document | HTMLElement,
      type: string,
      fn: (e: any) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => target.removeEventListener(type, fn));
    };

    (async () => {
      const params = defaultParams();
      applyUrlOverrides(params, location.search);
      const q = new URLSearchParams(location.search);
      const fixedSize = q.get("size") ? Math.max(16, +q.get("size")!) : null;
      const camOverride = q.get("camera")?.split(",").map(Number);

      const gl = canvas.getContext("webgl2", {
        antialias: false, // shader output is already dithered; MSAA is useless
        preserveDrawingBuffer: true, // screenshot harness reads the canvas
      });
      if (!gl) {
        statsEl.textContent = "WebGL2 unavailable in this browser.";
        return;
      }

      const [asset, palettes] = await Promise.all([
        loadHorb("generated/orbitals.bin"),
        loadPalettes("generated/palettes.json"),
      ]);
      const renderer = await OrbitalRenderer.create(gl, asset, palettes, "generated/shaders");
      if (disposed) return;

      const rig = new CameraRig();
      if (camOverride?.length === 3 && camOverride.every(Number.isFinite))
        [rig.azDeg, rig.elDeg, rig.dist] = camOverride;
      // Frozen copy of the starting camera's axes: the reference frame for
      // non-camLocked clip planes (framing factor is irrelevant — only the
      // basis directions are used).
      const basePose = rig.pose(1);

      // ----------------------------------------------------------------- GUI
      const gui = new GUI({ title: "hydrogen" });
      cleanups.push(() => gui.destroy());

      const fState = gui.addFolder("state");
      const nC = fState.add(params, "n", 1, asset.nMax, 1);
      const lC = fState.add(params, "l", 0, asset.nMax - 1, 1);
      const mC = fState.add(params, "m", -(asset.nMax - 1), asset.nMax - 1, 1);
      const clampState = () => {
        params.l = Math.min(params.l, params.n - 1);
        params.m = Math.max(-params.l, Math.min(params.l, params.m));
        lC.max(params.n - 1);
        mC.min(-params.l).max(params.l);
        [nC, lC, mC].forEach((c) => c.updateDisplay());
      };
      nC.onChange(clampState);
      lC.onChange(clampState);
      mC.onChange(clampState);
      clampState();
      fState
        .add(params, "mode", ["real", "complex"])
        .onChange((v: string) => {
          // Keep the conventional pairing; the color control stays free after.
          params.color = v === "real" ? "ramp" : "phase";
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
        });

      gui.add(params, "view", ["slice", "volume"]).onChange(syncFolders);

      const fDisplay = gui.addFolder("display");
      fDisplay.add(params, "color", ["ramp", "signed", "phase"]);
      fDisplay.add(params, "value", ["density", "amplitude"]);
      fDisplay.add(params, "gamma", 0.2, 1, 0.01);
      fDisplay.add(params, "dither");
      fDisplay.add(params, "renderScale", 0.25, 1.5, 0.05);

      const fPalette = gui.addFolder("palette").close();
      fPalette.add(params, "ramp", Object.keys(palettes.ramps));
      fPalette.add(params, "rampSpace", ["oklab", "srgb"]);
      fPalette.add(params, "phaseVivid");
      fPalette.add(params, "phaseChromaPow", 0, 1, 0.01);

      const fSlice = gui.addFolder("slice plane");
      fSlice.add(params, "slicePlane", ["xz", "xy", "yz", "custom"]).listen();
      fSlice.add(params, "sliceAz", -180, 180, 0.1).listen();
      fSlice.add(params, "sliceEl", -89, 89, 0.1).listen();
      fSlice.add(params, "sliceRoll", -180, 180, 0.1);
      fSlice.add(params, "sliceOffset", -1, 1, 0.005);
      fSlice.add(params, "sliceZoom", 0.5, 20, 0.01).listen();

      const fVolume = gui.addFolder("volume");
      fVolume.add(params, "integrator", ["mip", "ea"]);
      fVolume.add(params, "steps", 64, 1200, 1);
      fVolume.add(params, "density", 1, 50, 0.5);
      fVolume.add(params, "opacityPow", 0.5, 4, 0.05);
      fVolume.add(params, "emission", 0.1, 20, 0.05);
      fVolume.add(params, "fov", 20, 90, 1);

      const fCamera = gui.addFolder("camera");
      // Bound to a proxy, not rig.mode: lil-gui writes the bound property
      // *before* onChange, which would hide the old mode from setMode and
      // break the orbit→fly pose seeding.
      const camUi = { mode: rig.mode };
      fCamera
        .add(camUi, "mode", ["orbit", "fly"])
        .name("camera")
        .onChange((v: "orbit" | "fly") => rig.setMode(v, framing()));
      fCamera.add(rig, "azDeg", -180, 180, 0.1).listen();
      fCamera.add(rig, "elDeg", -89, 89, 0.1).listen();
      fCamera.add(rig, "dist", 1.05, 12, 0.01).listen();
      fCamera.add(rig, "flySpeed", 0.05, 3, 0.01);

      const clipFolder = (label: string, c: ClipParams) => {
        const f = gui.addFolder(label).close();
        f.add(c, "enabled");
        f.add(c, "axis", ["forward", "right", "up"]);
        f.add(c, "offset", -1.2, 1.2, 0.005);
        f.add(c, "flip");
        f.add(c, "camLock").name("lock to camera");
        return f;
      };
      const fClipA = clipFolder("clip plane A", params.clips[0]);
      const fClipB = clipFolder("clip plane B", params.clips[1]);

      function syncFolders() {
        const vol = params.view === "volume";
        (vol ? fSlice : fVolume).hide();
        (vol ? fVolume : fSlice).show();
        for (const f of [fCamera, fClipA, fClipB]) if (vol) f.show(); else f.hide();
      }
      syncFolders();

      const framing = () => framingRadius(asset, params.n);

      // --------------------------------------------------------------- input
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      on(canvas, "pointerdown", (e: PointerEvent) => {
        if (params.view === "volume" && rig.mode === "fly") {
          canvas.requestPointerLock();
          return;
        }
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
      });
      on(canvas, "pointermove", (e: PointerEvent) => {
        if (document.pointerLockElement === canvas) {
          rig.look(e.movementX, e.movementY);
          return;
        }
        if (!dragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        if (params.view === "volume") rig.drag(dx, dy);
        else {
          seedCustomFromPreset(params);
          params.sliceAz -= dx * 0.3;
          params.sliceEl = Math.min(89, Math.max(-89, params.sliceEl + dy * 0.3));
        }
      });
      on(canvas, "pointerup", () => (dragging = false));
      on(
        canvas,
        "wheel",
        (e: WheelEvent) => {
          e.preventDefault();
          if (params.view === "volume") rig.wheel(e.deltaY);
          else
            params.sliceZoom = Math.min(
              20,
              Math.max(0.5, params.sliceZoom * Math.exp(-e.deltaY * 0.001)),
            );
        },
        { passive: false },
      );
      const guiHasFocus = () =>
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLSelectElement;
      on(window, "keydown", (e: KeyboardEvent) => {
        if (!guiHasFocus()) rig.keyDown(e.code);
      });
      on(window, "keyup", (e: KeyboardEvent) => rig.keyUp(e.code));
      on(document, "pointerlockchange", () => {
        if (document.pointerLockElement !== canvas) rig.clearKeys();
      });

      // ---------------------------------------------------------- the loop
      const resize = () => {
        const w = fixedSize ?? Math.round(canvas.clientWidth * devicePixelRatio * params.renderScale);
        const h = fixedSize ?? Math.round(canvas.clientHeight * devicePixelRatio * params.renderScale);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
      };
      if (fixedSize) {
        canvas.classList.remove("view-fill");
        canvas.style.width = canvas.style.height = `${fixedSize}px`;
      }

      let lastT = performance.now();
      let emaMs = 0;
      let statsAge = 0;
      const loop = (tMs: number) => {
        if (disposed) return;
        const dt = Math.min((tMs - lastT) / 1000, 0.1);
        lastT = tMs;
        resize();
        rig.update(dt, framing());

        const common: CommonParams = {
          n: params.n,
          l: params.l,
          m: params.m,
          realMode: params.mode === "real",
          colorMode: COLOR_MODE[params.color],
          rampName: params.ramp,
          rampSpaceSrgb: params.rampSpace === "srgb",
          gamma: params.gamma,
          valueMode: params.value === "amplitude" ? 1 : 0,
          dither: params.dither,
          phaseVivid: params.phaseVivid,
          phaseChromaPow: params.phaseChromaPow,
        };

        if (params.view === "slice") {
          renderer.renderSlice({ common, ...slicePlaneVectors(params, framing()) });
        } else {
          const pose = rig.pose(framing());
          renderer.renderVolume({
            common,
            camPos: pose.pos,
            camRight: pose.right,
            camUp: pose.up,
            camFwd: pose.fwd,
            fovYDeg: params.fov,
            integrator: params.integrator === "ea" ? 1 : 0,
            steps: params.steps,
            densityScale: params.density,
            opacityPow: params.opacityPow,
            emissionGain: params.emission,
            clipPlanes: clipPlaneVectors(params.clips, pose, basePose, framing()),
          });
        }

        emaMs = emaMs === 0 ? dt * 1000 : emaMs * 0.9 + dt * 1000 * 0.1;
        if ((statsAge += dt) > 0.25) {
          statsAge = 0;
          const help =
            params.view === "slice"
              ? "drag: rotate plane · wheel: zoom"
              : rig.mode === "orbit"
                ? "drag: orbit · wheel: dolly"
                : "click: capture mouse · WASD+EQ fly · Shift fast · Esc release";
          statsEl.textContent =
            `|${params.n},${params.l},${params.m}⟩ ${params.mode} · ` +
            `${canvas.width}×${canvas.height} · ${emaMs.toFixed(1)} ms\n${help}`;
        }
        (window as unknown as { __renderReady?: boolean }).__renderReady = true;
        // Shot mode (?size=N) renders exactly one frame: deterministic, and a
        // multi-second software-rasterized EA frame can't stall the harness.
        if (!fixedSize) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    })().catch((err) => {
      console.error(err);
      statsEl.textContent = `failed to start: ${err}`;
    });

    return () => {
      disposed = true;
      cleanups.forEach((f) => f());
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="view view-fill" />
      <div ref={statsRef} className="stats">
        loading tables + shaders…
      </div>
    </>
  );
}
