"use client";

// =============================================================================
// OrbitalViewer.tsx — the interactive demo: one fullscreen WebGL2 canvas, a
// lil-gui control panel, custom overlay panels, and a render loop over the
// shared GLSL renderer.
//
// Layers (each documented in its own module):
//   lib/horb.ts          — baked-asset reader (tables + display stats)
//   lib/palettes.ts      — palette definitions
//   lib/color.ts         — sRGB/OKLab conversions (palette editor)
//   lib/params.ts        — UI parameter model + URL codec
//   lib/superposition.ts — superposed states, time evolution, presets
//   lib/scene.ts         — slice/clip plane geometry from params
//   lib/cameras.ts       — orbit + fly (+ center-locked) cameras
//   lib/panels.ts        — superposition editor, palette editor, help overlay
//   lib/renderer.ts      — shader assembly + uniform upload (the C# host's twin)
//
// This file owns what remains: building the GUI over the params object, input
// handling (pointer + keyboard), the requestAnimationFrame loop with the time
// integrator and auto-quality governor, PNG capture, and — for the path
// tracer — deciding when the progressive accumulation must restart.
//
// URL parameters mirror the offline CLI (?state=4,2,1&view=volume&mode=complex
// &camera=35,25,2.6&size=1024 …) so any view is shareable/scriptable — the
// screenshot harness (scripts/shot.mjs) drives the app through them and waits
// for window.__renderReady. For the path tracer, shot mode keeps accumulating
// until ?spp=N samples before flagging ready.
// =============================================================================

import GUI from "lil-gui";
import { useEffect, useRef } from "react";
import { CameraRig, type CameraPose } from "../lib/cameras";
import { framingRadius, loadHorb } from "../lib/horb";
import { loadPalettes } from "../lib/palettes";
import {
  applyUrlOverrides,
  buildQuery,
  COLOR_MODE,
  COMPRESS,
  defaultParams,
  ENV_MODE,
  ENVS,
  INTEGRATOR,
  SHADE_MODEL,
  SHADE_MODELS,
  TECHNIQUES,
  TONEMAP,
  type PhaseDefaults,
} from "../lib/params";
import { HelpOverlay, PalettePanel, rampFromStops, TermsPanel } from "../lib/panels";
import {
  OrbitalRenderer,
  type CameraParams,
  type CommonParams,
  type LightParams,
  type ShadeParams,
} from "../lib/renderer";
import { clipPlaneVectors, seedCustomFromPreset, slicePlaneVectors } from "../lib/scene";
import { coefficientsAt, superFraming } from "../lib/superposition";
import { scale } from "../lib/vec3";

export default function OrbitalViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const statsEl = statsRef.current!;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const on = (
      target: Window | Document | HTMLElement,
      type: string,
      fn: (e: any) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => target.removeEventListener(type, fn));
    };

    (async () => {
      const gl = canvas.getContext("webgl2", {
        antialias: false, // shader output is already dithered; MSAA is useless
        preserveDrawingBuffer: true, // PNG capture + screenshot harness
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

      const params = defaultParams();
      applyUrlOverrides(params, location.search, asset.nMax);
      const q = new URLSearchParams(location.search);
      const fixedSize = q.get("size") ? Math.max(16, +q.get("size")!) : null;
      const camOverride = q.get("camera")?.split(",").map(Number);
      /** Shot mode: path-traced frames accumulate to this many samples per
       * pixel before the harness is told the render is ready. */
      const sppTarget = q.get("spp") ? Math.max(1, +q.get("spp")!) : 32;

      const phaseDefaults: PhaseDefaults = {
        L: palettes.phaseL,
        C: palettes.phaseC,
        h0Deg: (palettes.phaseH0 * 180) / Math.PI,
      };

      const rig = new CameraRig();
      if (camOverride?.length === 3 && camOverride.every(Number.isFinite))
        [rig.azDeg, rig.elDeg, rig.dist] = camOverride;
      // Frozen copy of the starting camera's axes: the reference frame for
      // non-camLocked clip planes (framing factor is irrelevant — only the
      // basis directions are used).
      const basePose = rig.pose(1);

      const framing = () =>
        params.terms.length > 0
          ? superFraming(params.terms, asset)
          : framingRadius(asset, params.n);

      // ------------------------------------------------- URL state writeback
      // The address bar mirrors the live view (user request 2026-07-19), so
      // any moment of exploration is copyable as a link. replaceState (no
      // pushState) leaves history alone.
      let lastQuery: string | null = null;
      const syncUrl = () => {
        const query = buildQuery(
          params,
          { isOrbit: rig.mode === "orbit", azDeg: rig.azDeg, elDeg: rig.elDeg, dist: rig.dist },
          phaseDefaults,
        );
        if (query !== lastQuery) {
          lastQuery = query;
          history.replaceState(null, "", query ? `?${query}` : location.pathname);
        }
      };

      // --------------------------------------------------- overlay panels
      const termsPanel = new TermsPanel({
        params,
        nMax: asset.nMax,
        onChange: () => syncUrl(),
        onPreset: (mode, timeScale) => {
          params.mode = mode;
          params.color = mode === "real" ? "ramp" : "phase";
          params.timeScale = timeScale;
          params.simTime = 0;
          timeUi.log = Math.log10(timeScale); // keep the log slider in sync
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
        },
      });
      cleanups.push(() => termsPanel.root.remove());

      const palettePanel = new PalettePanel({
        params,
        ramps: palettes.ramps,
        phaseDefaults,
        onChange: () => {
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
          syncUrl();
        },
        currentUrl: () => {
          syncUrl();
          return location.href;
        },
      });
      cleanups.push(() => palettePanel.root.remove());

      const help = new HelpOverlay();
      cleanups.push(() => help.root.remove());

      // ----------------------------------------------------------------- GUI
      const gui = new GUI({ title: "hydrogen" });
      // Hide the root's collapsible title bar: it would fold the whole panel
      // away, which the G key (show/hide) already does more cleanly. The folders
      // become the top level. (lil-gui always builds a $title element.)
      (gui as unknown as { $title: HTMLElement }).$title.style.display = "none";
      cleanups.push(() => gui.destroy());

      // -- state ------------------------------------------------------------
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
          if (termsPanel.visible) termsPanel.render();
        });
      fState
        .add({ open: () => termsPanel.toggle() }, "open")
        .name("superposition editor…");

      gui.add(params, "view", ["slice", "volume"]).onChange(syncFolders);

      // -- time evolution ---------------------------------------------------
      const fTime = gui.addFolder("time evolution");
      fTime.add(params, "timeRun").name("run (Space)").listen();
      // Log-scaled speed: superposition beats span 4+ orders of magnitude
      // (16 au for 1s–2p, ~7000 au for Rydberg packets).
      const timeUi = { log: Math.log10(params.timeScale) };
      fTime
        .add(timeUi, "log", -1, 4, 0.01)
        .name("speed 10^x au/s")
        .onChange((v: number) => (params.timeScale = +Math.pow(10, v).toPrecision(3)));
      fTime.add({ reset: () => (params.simTime = 0) }, "reset").name("reset  t = 0  (R)");

      // -- display ----------------------------------------------------------
      const fDisplay = gui.addFolder("display");
      fDisplay.add(params, "color", ["ramp", "signed", "phase", "okphase"]).listen();
      fDisplay.add(params, "value", ["density", "amplitude"]);
      fDisplay.add(params, "gamma", 0.2, 1, 0.01);
      fDisplay.add(params, "compress", ["off", "log", "asinh"]);
      fDisplay.add(params, "compressK", 1, 500, 1);
      fDisplay.add(params, "compressWhite", 1, 32, 0.1).name("white point ×q999");
      fDisplay.add(params, "tonemap", ["gamma", "agx"]);
      fDisplay.add(params, "exposure", -4, 4, 0.05);
      fDisplay.add(params, "dither");

      // -- palette ----------------------------------------------------------
      const fPalette = gui.addFolder("palette").close();
      fPalette
        .add(params, "ramp", [...Object.keys(palettes.ramps), "custom"])
        .listen();
      fPalette.add(params, "rampSpace", ["oklab", "srgb"]);
      fPalette.add(params, "phaseVivid");
      fPalette.add(params, "phaseChromaPow", 0, 1, 0.01);
      fPalette.add(params, "okPhaseSigned").name("okphase: signed hue");
      fPalette
        .add({ open: () => palettePanel.toggle() }, "open")
        .name("palette editor…");

      // -- quality ----------------------------------------------------------
      const fQuality = gui.addFolder("quality").close();
      fQuality.add(params, "renderScale", 0.05, 1.5, 0.01);
      fQuality.add(params, "autoQuality").name("auto (drop res when slow)");

      // -- slice ------------------------------------------------------------
      const fSlice = gui.addFolder("slice plane");
      fSlice.add(params, "slicePlane", ["xz", "xy", "yz", "custom"]).listen();
      fSlice.add(params, "sliceAz", -180, 180, 0.1).listen();
      fSlice.add(params, "sliceEl", -89, 89, 0.1).listen();
      fSlice.add(params, "sliceRoll", -180, 180, 0.1);
      fSlice.add(params, "sliceOffset", -1, 1, 0.005);
      fSlice.add(params, "sliceZoom", 0.5, 20, 0.01).listen();

      // -- volume: technique + its per-technique subfolders ------------------
      const fVolume = gui.addFolder("volume");
      // Eikonal is hidden from the menu (still reachable via ?integrator=eikonal
      // and its folder still appears when selected) — the implementation stays.
      fVolume
        .add(params, "technique", TECHNIQUES.filter((t) => t !== "eikonal") as unknown as string[])
        .onChange(syncFolders);
      fVolume.add(params, "steps", 64, 1200, 1);
      fVolume.add(params, "density", 1, 50, 0.5);
      fVolume.add(params, "opacityPow", 0.5, 4, 0.05);
      fVolume.add(params, "emission", 0, 20, 0.05);

      const fLight = fVolume.addFolder("key light");
      fLight.add(params, "lightAz", -180, 180, 1);
      fLight.add(params, "lightEl", -89, 89, 1);
      fLight.add(params, "lightGain", 0, 30, 0.1);
      fLight.add(params, "hgG", -0.9, 0.9, 0.01).name("anisotropy g");

      const fScatter = fVolume.addFolder("multi-scattering");
      fScatter.add(params, "shadowSteps", 4, 64, 1);
      fScatter.add(params, "shadowDensity", 0, 400, 1);
      fScatter.add(params, "octaves", 1, 6, 1);
      fScatter.add(params, "octaveGain", 0.1, 0.9, 0.01);
      fScatter.add(params, "octaveExt", 0.1, 0.9, 0.01);
      fScatter.add(params, "ambientGain", 0, 10, 0.1);
      fScatter.add(params, "ambientDirs", 1, 12, 1);
      fScatter.add(params, "ambientRadius", 0.05, 0.6, 0.01);
      fScatter.add(params, "ambientDensity", 0, 1000, 5);

      const fMida = fVolume.addFolder("mida");
      fMida.add(params, "midaGamma", -1, 1, 0.01).name("γ  (EA ← MIDA → MIP)");

      const fIso = fVolume.addFolder("isosurfaces");
      fIso.add(params, "isoLevel", 0.02, 0.98, 0.005).name("level (depth sweep)");
      fIso.add(params, "isoCount", 1, 6, 1);
      fIso.add(params, "isoSpacing", 0.2, 0.95, 0.01);
      fIso.add(params, "isoAlpha", 0.05, 1, 0.01);
      fIso.add(params, "isoEmission", 0, 10, 0.05);
      fIso.add(params, "isoRim", 0, 10, 0.05);
      fIso.add(params, "isoAmbient", 0, 1, 0.01).name("ambient (ramp floor)");

      const fShade = fVolume.addFolder("surface shading");
      fShade.add(params, "shadeModel", SHADE_MODELS as unknown as string[]);
      fShade.add(params, "shadeDiffuse", 0, 2, 0.01);
      fShade.add(params, "shadeSpec", 0, 10, 0.05);
      fShade.add(params, "shadeRough", 0.02, 1, 0.01);
      fShade.add(params, "shadeF0", 0, 0.5, 0.005);
      fShade.add(params, "shadeConf", 0, 10, 0.05).name("gradient confidence");
      fShade.add(params, "gradDelta", 0.0005, 0.02, 0.0005);

      const fPt = fVolume.addFolder("path tracer");
      fPt.add(params, "maxBounces", 0, 16, 1);
      fPt.add(params, "albedo", 0, 1, 0.01);
      fPt.add(params, "scatterTint", 0, 1, 0.01);
      fPt.add(params, "sppFrame", 1, 8, 1).name("samples / frame");
      fPt.add(params, "aperture", 0, 0.25, 0.001);
      fPt.add(params, "focus", 0.2, 6, 0.01);
      fPt.add(params, "ptEnv", ENVS as unknown as string[]).name("environment");
      fPt.add(params, "ptEnvGain", 0, 5, 0.05);

      const fEik = fVolume.addFolder("eikonal");
      fEik.add(params, "eikSteps", 64, 1200, 1).name("steps");
      fEik.add(params, "iorScale", 0, 1.5, 0.005).name("Δn (index scale)");
      fEik.add(params, "eikMap", ["pow", "log"]).name("density map");
      fEik.add(params, "eikPow", 0.1, 2, 0.01);
      fEik.add(params, "eikLogK", 1, 500, 1);
      fEik.add(params, "absorb", 0, 20, 0.05);
      fEik.add(params, "eikEmission", 0, 10, 0.05);
      fEik.add(params, "dispersion", 0, 0.2, 0.001);
      fEik.add(params, "eikEnv", ENVS as unknown as string[]).name("environment");
      fEik.add(params, "eikEnvGain", 0, 5, 0.05);
      fEik.add(params, "eikGradDelta", 0.0005, 0.02, 0.0005);

      // -- camera -----------------------------------------------------------
      const fCamera = gui.addFolder("camera");
      // Bound to a proxy, not rig.mode: lil-gui writes the bound property
      // *before* onChange, which would hide the old mode from setMode and
      // break the orbit→fly pose seeding.
      const camUi = { mode: rig.mode };
      fCamera
        .add(camUi, "mode", ["orbit", "fly"])
        .name("camera")
        .onChange((v: "orbit" | "fly") => rig.setMode(v, framing()));
      const centerLockC = fCamera
        .add(rig, "centerLock")
        .name("center lock (C)")
        .onChange((v: boolean) => {
          rig.centerLock = !v; // undo lil-gui's direct write; go through the API
          rig.setCenterLock(v, framing());
          centerLockC.updateDisplay();
        })
        .listen();
      fCamera.add(rig, "azDeg", -180, 180, 0.1).listen();
      fCamera.add(rig, "elDeg", -89, 89, 0.1).listen();
      fCamera.add(rig, "dist", 0.15, 12, 0.01).listen();
      fCamera.add(rig, "flySpeed", 0.05, 3, 0.01);
      fCamera.add(params, "fov", 20, 90, 1);
      fCamera.add(params, "axes").name("orientation axes");
      fCamera.add(params, "axesGizmo").name("↳ compact gizmo");

      // -- clip planes ------------------------------------------------------
      const fClips = gui.addFolder("clip planes").close();
      const clipFolder = (label: string, c: (typeof params.clips)[0]) => {
        const f = fClips.addFolder(label);
        f.add(c, "enabled");
        f.add(c, "axis", ["forward", "right", "up"]);
        f.add(c, "offset", -1.2, 1.2, 0.005);
        f.add(c, "flip");
        f.add(c, "camLock").name("lock to camera");
        return f;
      };
      clipFolder("plane A", params.clips[0]);
      clipFolder("plane B", params.clips[1]);

      // -- capture ----------------------------------------------------------
      const fCapture = gui.addFolder("capture").close();
      fCapture.add({ png: () => (wantCapture = true) }, "png").name("save PNG  (P)");
      fCapture
        .add({ url: () => { syncUrl(); navigator.clipboard?.writeText(location.href); } }, "url")
        .name("copy view URL  (U)");
      fCapture
        .add({ help: () => help.toggle() }, "help")
        .name("keyboard help  (H)");

      /** Which folders each view/technique needs. */
      function syncFolders() {
        const vol = params.view === "volume";
        const t = params.technique;
        const iso = t === "iso" || t === "isolegacy";
        const show = (f: GUI, cond: boolean) => (cond ? f.show() : f.hide());
        show(fSlice, !vol);
        show(fVolume, vol);
        show(fCamera, vol);
        show(fClips, vol);
        show(fLight, vol && (iso || ["ea", "scatter", "pathtrace"].includes(t)));
        show(fScatter, vol && t === "scatter");
        show(fMida, vol && t === "mida");
        show(fIso, vol && iso);
        show(fShade, vol && (iso || ["ea", "scatter"].includes(t)));
        show(fPt, vol && t === "pathtrace");
        show(fEik, vol && t === "eikonal");
      }
      syncFolders();

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
          params.sliceAz = params.sliceAz - dx * 0.3;
          if (params.sliceAz > 180) params.sliceAz -= 360;
          if (params.sliceAz <= -180) params.sliceAz += 360;
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
        document.activeElement instanceof HTMLSelectElement ||
        document.activeElement instanceof HTMLButtonElement;
      let guiVisible = true;
      // Which overlay panels were open when the UI was last hidden (G) — so
      // bringing the UI back restores them instead of losing the palette editor.
      let panelMemory = { terms: false, palette: false };
      let wantCapture = false;
      on(window, "keydown", (e: KeyboardEvent) => {
        // Esc anywhere returns focus to the canvas: blur whatever GUI input or
        // control holds it (which otherwise swallows the global keybinds below)
        // so Space/R/C/… work again immediately. The browser also uses Esc to
        // exit pointer lock in fly mode — refocusing the canvas is harmless there.
        if (e.code === "Escape") {
          (document.activeElement as HTMLElement | null)?.blur?.();
          canvas.focus();
          return;
        }
        if (guiHasFocus()) return;
        rig.keyDown(e.code);
        switch (e.code) {
          case "Space":
            e.preventDefault();
            params.timeRun = !params.timeRun;
            break;
          case "KeyR":
            params.simTime = 0;
            break;
          case "KeyC":
            if (params.view === "volume" && rig.mode === "fly")
              rig.setCenterLock(!rig.centerLock, framing());
            break;
          case "KeyP":
            wantCapture = true;
            break;
          case "KeyU":
            syncUrl();
            navigator.clipboard?.writeText(location.href);
            break;
          case "KeyG":
            guiVisible = !guiVisible;
            gui.show(guiVisible);
            if (!guiVisible) {
              panelMemory = { terms: termsPanel.visible, palette: palettePanel.visible };
              termsPanel.hide();
              palettePanel.hide();
            } else {
              if (panelMemory.terms) termsPanel.show();
              if (panelMemory.palette) palettePanel.show();
            }
            break;
          case "KeyH":
            help.toggle();
            break;
          default:
            if (e.key === "?") help.toggle();
        }
      });
      on(window, "keyup", (e: KeyboardEvent) => rig.keyUp(e.code));
      on(document, "pointerlockchange", () => {
        if (document.pointerLockElement !== canvas) rig.clearKeys();
      });

      // ------------------------------------------------------- PNG capture
      const captureFrame = () => {
        wantCapture = false;
        const state =
          params.terms.length > 0
            ? `sup${params.terms.length}`
            : `${params.n}_${params.l}_${params.m}`;
        const tag = params.view === "slice" ? "slice" : params.technique;
        const time = params.simTime !== 0 ? `_t${params.simTime.toFixed(1)}` : "";
        canvas.toBlob((blob) => {
          if (!blob) return;
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `hydrogen_${state}_${tag}${time}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });
      };

      // ------------------------------------------------------ quality govern
      // Auto quality: an internal multiplier on renderScale, stepped down when
      // frames stall and back up when there is headroom. Never touches the
      // user's slider; skipped for the path tracer (resolution changes reset
      // its accumulation) and for fixed-size shots.
      let qualityMul = 1;
      let governAge = 0;
      const govern = (dt: number, emaMs: number) => {
        if (!params.autoQuality || fixedSize) return;
        if (params.view === "volume" && params.technique === "pathtrace") return;
        if ((governAge += dt) < 0.5) return;
        governAge = 0;
        if (emaMs > 45 && qualityMul > 0.3) qualityMul = Math.max(0.3, qualityMul * 0.8);
        else if (emaMs < 15 && qualityMul < 1) qualityMul = Math.min(1, qualityMul / 0.8);
      };

      // ---------------------------------------------------------- the loop
      const resize = () => {
        const s = params.renderScale * qualityMul;
        const w = fixedSize ?? Math.max(16, Math.round(canvas.clientWidth * devicePixelRatio * s));
        const h = fixedSize ?? Math.max(16, Math.round(canvas.clientHeight * devicePixelRatio * s));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
      };
      if (fixedSize) {
        canvas.classList.remove("view-fill");
        canvas.style.width = canvas.style.height = `${fixedSize}px`;
      }

      // Everything the path-traced image depends on: when this signature
      // changes, the accumulation restarts. Display-only params (tonemap,
      // exposure, dither, sppFrame) are deliberately absent — they apply to
      // the already-accumulated result. Time-evolving superpositions change
      // the coefficients every frame, so the accumulation restarts per frame
      // (a moving target cannot be averaged).
      let lastPtSig = "";
      const ptSignature = (pose: CameraPose, clips: number[][], coefs: Float32Array | null) =>
        JSON.stringify([
          params.n, params.l, params.m, params.mode, params.color, params.value,
          params.gamma, params.compress, params.compressK, params.ramp,
          params.ramp === "custom" ? params.rampStops : 0,
          params.rampSpace, params.phaseVivid, params.phaseChromaPow,
          params.okPhaseSigned,
          params.phaseL, params.phaseC, params.phaseH0Deg,
          params.density, params.opacityPow, params.emission,
          params.lightAz, params.lightEl, params.lightGain, params.hgG,
          params.maxBounces, params.albedo, params.scatterTint,
          params.aperture, params.focus, params.ptEnv, params.ptEnvGain,
          coefs ? Array.from(coefs) : 0, params.superNormalize,
          pose.pos, pose.fwd, clips, canvas.width, canvas.height,
        ]);

      let lastT = performance.now();
      let emaMs = 0;
      let statsAge = 0;
      const loop = (tMs: number) => {
        if (disposed) return;
        const dt = Math.min((tMs - lastT) / 1000, 0.1);
        lastT = tMs;
        govern(dt, emaMs);
        resize();
        rig.update(dt, framing());

        // Simulated time: advance while running (never in deterministic shot
        // mode — there t comes fixed from the URL).
        if (params.timeRun && !fixedSize) params.simTime += dt * params.timeScale;

        const superOn = params.terms.length > 0;
        const timeActive = params.timeRun || params.simTime !== 0;
        // Coefficients are needed whenever the super path runs; a single state
        // under time evolution is a 1-term superposition (global phase spins).
        const effTerms =
          superOn ? params.terms
          : timeActive ? [{ n: params.n, l: params.l, m: params.m, amp: 1, phaseDeg: 0 }]
          : [];
        const coefs =
          effTerms.length > 0
            ? coefficientsAt(effTerms, params.simTime, params.superNormalize)
            : null;

        const common: CommonParams = {
          n: params.n,
          l: params.l,
          m: params.m,
          realMode: params.mode === "real",
          terms: effTerms,
          termCoefs: coefs,
          superNormalize: params.superNormalize,
          colorMode: COLOR_MODE[params.color],
          rampName: params.ramp,
          customRamp: params.ramp === "custom" ? rampFromStops(params.rampStops) : null,
          rampSpaceSrgb: params.rampSpace === "srgb",
          gamma: params.gamma,
          valueMode: params.value === "amplitude" ? 1 : 0,
          compressMode: COMPRESS[params.compress],
          compressK: params.compressK,
          compressWhite: params.compressWhite,
          dither: params.dither,
          phaseVivid: params.phaseVivid,
          phaseChromaPow: params.phaseChromaPow,
          okPhaseSigned: params.okPhaseSigned,
          phaseL: params.phaseL,
          phaseC: params.phaseC,
          phaseH0Rad: (params.phaseH0Deg * Math.PI) / 180,
        };

        if (params.view === "slice") {
          // Aspect correction: uv spans the full canvas on both axes, so equal
          // half-extents would stretch the field on a non-square canvas. The
          // U axis gets the width/height factor — pixels become square, the
          // vertical extent stays the framing (the volume renderer's
          // vertical-FOV convention), and wider windows just see more world.
          const sp = slicePlaneVectors(params, framing());
          const aspect = canvas.width / canvas.height;
          renderer.renderSlice({ common, ...sp, axisU: scale(sp.axisU, aspect) });
        } else {
          const pose = rig.pose(framing());
          const clips = clipPlaneVectors(params.clips, pose, basePose, framing());
          const camera: CameraParams = {
            camPos: pose.pos,
            camRight: pose.right,
            camUp: pose.up,
            camFwd: pose.fwd,
            fovYDeg: params.fov,
            tonemap: TONEMAP[params.tonemap],
            exposureEv: params.exposure,
            clipPlanes: clips,
          };
          const light: LightParams = {
            lightAzDeg: params.lightAz,
            lightElDeg: params.lightEl,
            lightGain: params.lightGain,
            hgG: params.hgG,
          };
          const shade: ShadeParams = {
            shadeModel: SHADE_MODEL[params.shadeModel],
            shadeDiffuse: params.shadeDiffuse,
            shadeSpec: params.shadeSpec,
            shadeRough: params.shadeRough,
            shadeF0: params.shadeF0,
            shadeConf: params.shadeConf,
            gradDelta: params.gradDelta,
          };

          if (params.technique === "pathtrace") {
            if (!renderer.floatRenderable) {
              statsEl.textContent =
                "path tracing needs float render targets (EXT_color_buffer_float) — unavailable here.";
              return;
            }
            const sig = ptSignature(pose, clips, coefs);
            if (sig !== lastPtSig) {
              lastPtSig = sig;
              renderer.resetAccum();
            }
            renderer.pathtraceSample({
              common,
              camera,
              light,
              densityScale: params.density,
              opacityPow: params.opacityPow,
              emissionGain: params.emission,
              maxBounces: params.maxBounces,
              albedo: params.albedo,
              scatterTint: params.scatterTint,
              sppFrame: params.sppFrame,
              aperture: params.aperture * framing(),
              focusDist: params.focus * framing(),
              envMode: ENV_MODE[params.ptEnv],
              envGain: params.ptEnvGain,
            });
          } else if (params.technique === "eikonal") {
            renderer.renderEikonal({
              common,
              camera,
              steps: params.eikSteps,
              iorScale: params.iorScale,
              eikMap: params.eikMap === "log" ? 1 : 0,
              eikPow: params.eikPow,
              eikLogK: params.eikLogK,
              absorb: params.absorb,
              emission: params.eikEmission,
              dispersion: params.dispersion,
              envMode: ENV_MODE[params.eikEnv],
              envGain: params.eikEnvGain,
              gradDelta: params.eikGradDelta,
            });
          } else {
            renderer.renderVolume({
              common,
              camera,
              light,
              shade,
              integrator: INTEGRATOR[params.technique],
              isoLegacy: params.technique === "isolegacy",
              steps: params.steps,
              densityScale: params.density,
              opacityPow: params.opacityPow,
              emissionGain: params.emission,
              shadowSteps: params.shadowSteps,
              shadowDensity: params.shadowDensity,
              octaves: params.octaves,
              octaveGain: params.octaveGain,
              octaveExt: params.octaveExt,
              ambientGain: params.ambientGain,
              ambientDirs: params.ambientDirs,
              ambientRadius: params.ambientRadius,
              ambientDensity: params.ambientDensity,
              midaGamma: params.midaGamma,
              isoLevel: params.isoLevel,
              isoCount: params.isoCount,
              isoSpacing: params.isoSpacing,
              isoAlpha: params.isoAlpha,
              isoEmission: params.isoEmission,
              isoRim: params.isoRim,
              isoAmbient: params.isoAmbient,
            });
          }
          // Orientation axes: blended over the finished frame, so they track
          // the live camera regardless of which integrator drew it. Gizmo mode
          // clusters short arms around the origin/crosshair (Minecraft F3 look).
          if (params.axes)
            renderer.renderAxes(camera, framing() * (params.axesGizmo ? 0.22 : 1));
        }

        if (wantCapture) captureFrame();

        emaMs = emaMs === 0 ? dt * 1000 : emaMs * 0.9 + dt * 1000 * 0.1;
        if ((statsAge += dt) > 0.25) {
          statsAge = 0;
          if (!fixedSize) syncUrl();
          const state =
            params.terms.length > 0
              ? `Σ ${params.terms.length} terms`
              : `|${params.n},${params.l},${params.m}⟩`;
          const time = timeActive
            ? ` · t=${params.simTime.toFixed(1)} au${params.timeRun ? "" : " ⏸"}`
            : "";
          const spp =
            params.view === "volume" && params.technique === "pathtrace"
              ? ` · ${renderer.pathtraceSamples} spp`
              : "";
          const quality = qualityMul < 1 ? ` · auto ×${qualityMul.toFixed(2)}` : "";
          const help_ =
            params.view === "slice"
              ? "drag: rotate plane · wheel: zoom · H: help"
              : rig.mode === "orbit"
                ? "drag: orbit · wheel: dolly · H: help"
                : rig.centerLock
                  ? "center-locked · AD/EQ: sphere · WS: radius · C: unlock"
                  : "click: capture mouse · WASD+EQ fly · C: center lock · Esc release";
          statsEl.textContent =
            `${state} ${params.mode}${time} · ` +
            `${canvas.width}×${canvas.height} · ${emaMs.toFixed(1)} ms${spp}${quality}\n${help_}`;
        }

        // Shot mode (?size=N) renders deterministically and stops: one frame
        // for the direct techniques, or — for the path tracer — as many
        // accumulation passes as it takes to reach ?spp=N samples per pixel.
        const converging =
          params.view === "volume" &&
          params.technique === "pathtrace" &&
          renderer.pathtraceSamples < sppTarget;
        if (!fixedSize || !converging)
          (window as unknown as { __renderReady?: boolean }).__renderReady = true;
        if (!fixedSize || converging) requestAnimationFrame(loop);
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
      {/* tabIndex makes the canvas programmatically focusable (Esc refocus). */}
      <canvas ref={canvasRef} className="view view-fill" tabIndex={-1} />
      <div ref={statsRef} className="stats">
        loading tables + shaders…
      </div>
    </>
  );
}
