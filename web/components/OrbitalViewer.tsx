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
//   lib/superposition.ts — superposed states and time evolution
//   lib/presets.ts       — curated state, flow, and rendering starting points
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
import { hexToSrgb } from "../lib/color";
import { framingRadius, loadHorb } from "../lib/horb";
import { LOADING_ASSET_BYTES } from "../lib/loading-asset";
import { startLoadingScene } from "../lib/loading-scene";
import { loadPalettes } from "../lib/palettes";
import {
  applyUrlOverrides,
  BLOOM_COMPOSITES,
  buildQuery,
  COLOR_MODE,
  COMPRESS,
  defaultParams,
  ENV_MODE,
  ENVS,
  FLOW_COLOR,
  FLOW_COLORS,
  FLOW_COMPOSITE,
  FLOW_COMPOSITES,
  FLOW_DERIVATIVE,
  FLOW_DERIVATIVES,
  FLOW_INTEGRATOR,
  FLOW_INTEGRATORS,
  FLOW_METHODS,
  FLOW_VOLUME_METHODS,
  FLOW_SEED,
  FLOW_SEEDS,
  INTEGRATOR,
  SHADE_MODEL,
  SHADE_MODELS,
  TECHNIQUES,
  TONEMAP,
  type PhaseDefaults,
} from "../lib/params";
import {
  HelpOverlay,
  PalettePanel,
  PresetsPanel,
  rampFromStops,
  TermsPanel,
} from "../lib/panels";
import { applyViewerPreset, VIEWER_PRESETS } from "../lib/presets";
import {
  OrbitalRenderer,
  type CameraParams,
  type CommonParams,
  type FlowFieldParams,
  type FlowParticleParams,
  type FlowVolumeParams,
  type LightParams,
  type ShadeParams,
} from "../lib/renderer";
import { clipPlaneVectors, seedCustomFromPreset, slicePlaneVectors } from "../lib/scene";
import { coefficientsAt, superFraming } from "../lib/superposition";
import { scale } from "../lib/vec3";

export default function OrbitalViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);
  const flowLegendRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef<HTMLDivElement>(null);
  const loadingNoteRef = useRef<HTMLDivElement>(null);
  const loadingBarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const statsEl = statsRef.current!;
    const flowLegendEl = flowLegendRef.current!;
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

    // ------------------------------------------------------- loading screen
    // Started before anything is fetched: the overlay draws its own scene from
    // ~7 KB of inlined tables (lib/loading-scene.ts) while the 16 MB asset and
    // the shared shaders are still in flight.
    const loadingEl = loadingRef.current!;
    const loadingNoteEl = loadingNoteRef.current!;
    const loadingBarEl = loadingBarRef.current!;
    // The canvas is created here rather than in the JSX because disposing the
    // scene releases its WebGL2 context, and a canvas element cannot hand out
    // a second one — a remount (React strict mode) needs a fresh element.
    const loadingCanvas = document.createElement("canvas");
    loadingCanvas.className = "loading-view";
    loadingEl.prepend(loadingCanvas);
    const loadingScene = startLoadingScene(loadingCanvas);
    let loadingTimer: number | undefined;
    const loadingNote = (text: string, fraction?: number) => {
      loadingNoteEl.textContent = text;
      if (fraction !== undefined) loadingBarEl.style.width = `${fraction * 100}%`;
    };
    const endLoadingScreen = () => {
      if (loadingEl.hidden || loadingEl.classList.contains("loading-done")) return;
      loadingBarEl.style.width = "100%";
      loadingEl.classList.add("loading-done"); // CSS fade
      loadingTimer = window.setTimeout(() => {
        loadingEl.hidden = true;
        loadingScene?.dispose();
        loadingCanvas.remove(); // its context is gone; keep no dead canvas around
      }, 600);
    };
    cleanups.push(() => {
      clearTimeout(loadingTimer);
      loadingScene?.dispose();
      loadingCanvas.remove();
    });

    (async () => {
      const gl = canvas.getContext("webgl2", {
        antialias: false, // shader output is already dithered; MSAA is useless
        preserveDrawingBuffer: true, // PNG capture + screenshot harness
      });
      if (!gl) {
        endLoadingScreen();
        statsEl.textContent = "WebGL2 unavailable in this browser.";
        return;
      }

      loadingNote("fetching orbital tables", 0);
      const [asset, palettes] = await Promise.all([
        // LOADING_ASSET_BYTES is the asset's size at bake time; clamp in case
        // a re-bake changed it without regenerating the loading module.
        loadHorb("generated/orbitals.bin", (bytes) => {
          const done = Math.min(1, bytes / LOADING_ASSET_BYTES);
          loadingNote(`orbital tables · ${Math.round(100 * done)}%`, done);
        }),
        loadPalettes("generated/palettes.json"),
      ]);
      loadingNote("compiling shaders", 1);
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
      /** Deterministic warm-up for advected screenshots: unlike a density
       * still, a trail needs history. `?flowFrames=N` overrides the default. */
      const requestedFlowFrames = Number(q.get("flowFrames"));
      const flowFramesTarget = Number.isFinite(requestedFlowFrames) && requestedFlowFrames > 0
        ? Math.max(1, Math.min(600, Math.round(requestedFlowFrames)))
        : 45;

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
      let basePose = rig.pose(1);

      const framing = () =>
        params.terms.length > 0
          ? superFraming(params.terms, asset)
          : framingRadius(asset, params.n);

      // ------------------------------------------------- URL state writeback
      // The address bar mirrors the live view so any moment of exploration is
      // copyable as a link. replaceState leaves browser history untouched.
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
        onChange: () => {
          // Keep the main GUI in step with params: the editor can rewrite n,l,m
          // when it collapses a 1-term list on close, so re-run clampState (it
          // refreshes the l/m slider ranges and displays) and resync the URL.
          clampState();
          syncFolders();
          syncUrl();
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

      let presetsPanel: PresetsPanel;
      gui.add({ open: () => presetsPanel.toggle() }, "open").name("browse presets…");
      const fScene = gui.addFolder("scene");
      const fAppearance = gui.addFolder("appearance").close();
      const fRendering = gui.addFolder("rendering");
      const fFlow = gui.addFolder("probability flow");
      if (!params.flowEnabled) fFlow.close();
      const fNavigation = gui.addFolder("camera + clipping").close();
      const fOutput = gui.addFolder("output").close();

      // -- scene ------------------------------------------------------------
      const fState = fScene.addFolder("quantum state");
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
        .listen() // every other state control listens; without this the mode
        // dropdown could show a stale value after a preset set it, reading as
        // the render being "stuck" in the other basis.
        .onChange(() => {
          // Mode (harmonic basis) and color are independent: switching basis
          // must not overwrite the user's chosen color — they are often
          // comparing one coloring across bases. Only the term editor, whose
          // rows carry basis-specific labels, needs a re-render.
          if (termsPanel.visible) termsPanel.render();
        });
      fState
        .add({ open: () => termsPanel.toggle() }, "open")
        .name("superposition editor…");

      fScene.add(params, "view", ["slice", "volume"]).onChange(syncFolders);

      // -- time evolution ---------------------------------------------------
      const fTime = fScene.addFolder("time evolution").close();
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
      const fDisplay = fAppearance.addFolder("display mapping");
      fDisplay.add(params, "color", ["ramp", "signed", "phase", "okphase"])
        .listen().onChange(syncFolders);
      fDisplay.add(params, "value", ["density", "amplitude"]);
      fDisplay.add(params, "gamma", 0.2, 1, 0.01);
      fDisplay.add(params, "compress", ["off", "log", "asinh"]).onChange(syncFolders);
      const compressKC = fDisplay.add(params, "compressK", 1, 500, 1);
      fDisplay.add(params, "compressWhite", 1, 32, 0.1).name("white point ×q999");
      const tonemapC = fDisplay.add(params, "tonemap", ["gamma", "agx"]);
      const exposureC = fDisplay.add(params, "exposure", -4, 4, 0.05);
      fDisplay.add(params, "dither");

      // -- display-referred finishing ---------------------------------------
      const fPost = fAppearance.addFolder("post processing").close();
      fPost.add(params, "postEnabled").name("enable finishing").onChange(syncFolders);

      const fBloom = fPost.addFolder("bloom").close();
      fBloom.add(params, "bloomEnabled").name("enabled").onChange(syncFolders);
      const bloomThresholdC = fBloom.add(params, "bloomThreshold", 0, 1.5, 0.005)
        .name("bright-pass threshold");
      const bloomKneeC = fBloom.add(params, "bloomKnee", 0, 1, 0.01)
        .name("soft knee");
      const bloomIntensityC = fBloom.add(params, "bloomIntensity", 0, 4, 0.01);
      const bloomRadiusC = fBloom.add(params, "bloomRadius", 0.05, 5, 0.05)
        .name("blur radius");
      const bloomIterationsC = fBloom.add(params, "bloomIterations", 1, 8, 1)
        .name("blur iterations");
      const bloomScaleC = fBloom.add(params, "bloomScale", 0.125, 1, 0.025)
        .name("buffer scale");
      const bloomSaturationC = fBloom.add(params, "bloomSaturation", 0, 2, 0.01);
      const bloomTintC = fBloom.addColor(params, "bloomTint").name("tint");
      const bloomCompositeC = fBloom
        .add(params, "bloomComposite", BLOOM_COMPOSITES as unknown as string[])
        .name("blend");
      const bloomControls = [
        bloomThresholdC, bloomKneeC, bloomIntensityC, bloomRadiusC,
        bloomIterationsC, bloomScaleC, bloomSaturationC, bloomTintC,
        bloomCompositeC,
      ];

      const fGrade = fPost.addFolder("color grade").close();
      fGrade.add(params, "postExposure", -3, 3, 0.01).name("exposure EV");
      fGrade.add(params, "postContrast", 0, 2, 0.01).name("contrast");
      fGrade.add(params, "postSaturation", 0, 2, 0.01).name("saturation");
      fGrade.add(params, "postVibrance", -1, 1, 0.01).name("vibrance");

      const fLens = fPost.addFolder("lens finishing").close();
      fLens.add(params, "postAberration", 0, 8, 0.05)
        .name("chromatic shift px").onChange(syncFolders);
      const aberrationFalloffC = fLens
        .add(params, "postAberrationFalloff", 0.1, 5, 0.05)
        .name("shift edge falloff");
      fLens.add(params, "vignetteEnabled").name("vignette").onChange(syncFolders);
      const vignetteAmountC = fLens.add(params, "vignetteAmount", 0, 1, 0.01)
        .name("vignette amount");
      const vignetteRadiusC = fLens.add(params, "vignetteRadius", 0.1, 1.5, 0.01)
        .name("vignette radius");
      const vignetteSoftnessC = fLens.add(params, "vignetteSoftness", 0.01, 1, 0.01)
        .name("edge softness");
      const vignetteRoundnessC = fLens.add(params, "vignetteRoundness", 0, 1, 0.01)
        .name("aspect roundness");
      const vignetteCenterXC = fLens.add(params, "vignetteCenterX", -0.5, 0.5, 0.005)
        .name("center x");
      const vignetteCenterYC = fLens.add(params, "vignetteCenterY", -0.5, 0.5, 0.005)
        .name("center y");
      const vignetteControls = [
        vignetteAmountC, vignetteRadiusC, vignetteSoftnessC,
        vignetteRoundnessC, vignetteCenterXC, vignetteCenterYC,
      ];

      const fGrain = fPost.addFolder("film grain").close();
      fGrain.add(params, "grainEnabled").name("enabled").onChange(syncFolders);
      const grainAmountC = fGrain.add(params, "grainAmount", 0, 0.2, 0.001)
        .name("amount");
      const grainScaleC = fGrain.add(params, "grainScale", 0.25, 8, 0.05)
        .name("grain size px");
      const grainSpeedC = fGrain.add(params, "grainSpeed", 0, 8, 0.05)
        .name("refresh speed");
      const grainColoredC = fGrain.add(params, "grainColored").name("colored");
      const grainControls = [grainAmountC, grainScaleC, grainSpeedC, grainColoredC];

      // -- genuine probability flow ----------------------------------------
      const applyFlowTreatment = (method: string) => {
        if (method === "motes") Object.assign(params, {
          flowStreakLength: 0.001, flowSpeedStretch: 0,
          flowWidth: 1.1, flowHalo: 2.2, flowHaloGain: 0.08,
          flowTailPower: 0.5, flowHeadBoost: 2.5, flowOpacity: 0.1,
          flowTrailHalfLife: 0.06, flowTrailDiffusion: 0,
          flowEmission: 3.5, flowComposite: "screen",
        });
        if (method === "trails") Object.assign(params, {
          flowStreakLength: 0.03, flowSpeedStretch: 0.7,
          flowWidth: 0.8, flowHalo: 3.4, flowHaloGain: 0.13,
          flowTailPower: 1.5, flowHeadBoost: 1.1, flowOpacity: 0.035,
          flowTrailHalfLife: 0.65, flowTrailDiffusion: 0.012,
          flowEmission: 4.5, flowComposite: "screen",
        });
        if (method === "accretion") Object.assign(params, {
          flowStreakLength: 0.04, flowSpeedStretch: 0.7,
          flowWidth: 0.65, flowHalo: 5, flowHaloGain: 0.12,
          flowTailPower: 1.8, flowHeadBoost: 0.8, flowOpacity: 0.008,
          flowTrailHalfLife: 1.1, flowTrailDiffusion: 0.015,
          flowEmission: 4.5, flowComposite: "additive",
        });
        if (method === "granular") Object.assign(params, {
          flowVolumeSignalGain: 2.8, flowVolumeSignalPow: 1.15,
          flowVolumeThreshold: 0.08, flowVolumeSoftness: 0.18,
          flowVolumeExtinction: 1.8, flowVolumeEmission: 1.5,
          flowVolumeOpacity: 0.5, flowVolumeDitherAmount: 0.94,
          flowVolumeDitherScale: 54, flowVolumeDitherRate: 3,
          flowVolumeDitherCoverage: 0.24, flowComposite: "screen",
        });
      };
      fFlow.add(params, "flowEnabled").name("show advected flow").listen();
      fFlow.add(params, "flowMethod", FLOW_METHODS as unknown as string[])
        .name("method").listen().onChange((method: string) => {
          params.view = method === "ink" ? "slice" : "volume";
          applyFlowTreatment(method);
          renderer.resetFlowParticles();
          renderer.resetFlowInk();
          renderer.resetFlowVolume();
          syncFolders();
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
        });
      fFlow.add(params, "flowRun").name("run transport").listen();
      fFlow.add(params, "flowReverse").name("reverse trajectories");

      const fFlowAppearance = fFlow.addFolder("appearance").close();
      fFlowAppearance.add(params, "flowBase", 0, 1, 0.01).name("density context");
      fFlowAppearance.add(params, "flowColor", FLOW_COLORS as unknown as string[])
        .name("color encodes").onChange(syncFolders);
      const flowColorGainC = fFlowAppearance.add(params, "flowColorGain", 0.05, 20, 0.05)
        .name("speed color gain");
      fFlowAppearance.add(params, "flowColorFloor", 0, 1, 0.01).name("palette floor");
      fFlowAppearance.add(params, "flowDensityGate", 0, 3, 0.05)
        .name("ρ visibility gate");
      fFlowAppearance.add(params, "flowLegend").name("meaning legend");
      fFlowAppearance.add({ open: () => palettePanel.toggle() }, "open")
        .name("edit flow palette…");

      const fFlowTransport = fFlow.addFolder("transport field").close();
      const flowSpeedUi = { log: Math.log10(params.flowTimeScale) };
      fFlowTransport.add(flowSpeedUi, "log", -1, 4, 0.01)
        .name("speed 10^x au/s")
        .onChange((v: number) => (params.flowTimeScale = +Math.pow(10, v).toPrecision(4)));
      fFlowTransport.add(params, "flowMaxSpeed", 0.05, 8, 0.05)
        .name("cap R / second");
      fFlowTransport.add(params, "flowIntegrator", FLOW_INTEGRATORS as unknown as string[])
        .name("integrator");
      const flowSubstepsC = fFlowTransport.add(params, "flowSubsteps", 1, 4, 1)
        .name("substeps");
      fFlowTransport.add(params, "flowDerivative", FLOW_DERIVATIVES as unknown as string[])
        .name("derivative stencil");
      fFlowTransport.add(params, "flowDelta", 0.0001, 0.02, 0.0001)
        .name("derivative step / R");
      fFlowTransport.add(params, "flowNodeEps", 0.000001, 0.02, 0.000001)
        .name("node regularizer ε");

      const fFlowSeeds = fFlow.addFolder("tracer seeding").close();
      fFlowSeeds.add(params, "flowSeed", FLOW_SEEDS as unknown as string[])
        .name("distribution");
      fFlowSeeds.add(params, "flowSeedPower", 0.05, 3, 0.05).name("importance power");
      const flowSpawnTriesC = fFlowSeeds.add(params, "flowSpawnTries", 1, 12, 1)
        .name("rejection tries");
      const flowSeedClipsC = fFlowSeeds.add(params, "flowSeedInsideClips")
        .name("seed kept volume");
      fFlowSeeds.add({ reseed: () => {
        params.flowResetNonce += 1;
        renderer.resetFlowParticles();
        renderer.resetFlowInk();
        renderer.resetFlowVolume();
      } }, "reseed").name("new random ensemble");

      const fFlowParticles = fFlow.addFolder("3-D motes + trails").close();
      fFlowParticles.add(params, "flowParticleSide", 32, 256, 8)
        .name("particle grid side");
      fFlowParticles.add(params, "flowLifetime", 0.25, 30, 0.25)
        .name("lifetime seconds");
      fFlowParticles.add(params, "flowStreakLength", 0.0001, 0.12, 0.0005)
        .name("local streak / R");
      fFlowParticles.add(params, "flowSpeedStretch", 0, 1, 0.01)
        .name("speed → length");
      fFlowParticles.add(params, "flowWidth", 0.1, 5, 0.05).name("core width px");
      fFlowParticles.add(params, "flowHalo", 1, 12, 0.1).name("halo radius");
      fFlowParticles.add(params, "flowHaloGain", 0, 1, 0.005).name("halo energy");
      fFlowParticles.add(params, "flowTailPower", 0.05, 8, 0.05).name("tail taper");
      fFlowParticles.add(params, "flowHeadBoost", 0, 8, 0.05).name("mote head boost");
      fFlowParticles.add(params, "flowOpacity", 0.0005, 0.5, 0.0005)
        .name("deposit / frame");
      fFlowParticles.add(params, "flowTrailHalfLife", 0, 8, 0.02)
        .name("trail half-life s");
      fFlowParticles.add(params, "flowTrailDiffusion", 0, 0.3, 0.001)
        .name("silk diffusion");
      fFlowParticles.add(params, "flowEmission", 0.05, 30, 0.05)
        .name("HDR emission");
      fFlowParticles.add(params, "flowCompositeOpacity", 0, 4, 0.02)
        .name("composite gain");
      fFlowParticles.add(params, "flowComposite", FLOW_COMPOSITES as unknown as string[])
        .name("composite");
      fFlowParticles.add(params, "flowClipVisible").name("respect clip planes");

      const fFlowInk = fFlow.addFolder("slice advected ink").close();
      fFlowInk.add(params, "flowInkScale", 2, 256, 1).name("injection scale");
      fFlowInk.add(params, "flowInkDecay", 0, 5, 0.01).name("dye decay / s");
      fFlowInk.add(params, "flowInkInjection", 0, 8, 0.01).name("dye injection / s");
      fFlowInk.add(params, "flowInkDiffusion", 0, 2, 0.005).name("diffusion");
      fFlowInk.add(params, "flowInkThroughFade", 0, 1, 0.01).name("through-plane loss");
      fFlowInk.add(params, "flowInkContrast", 0.1, 5, 0.05).name("filament contrast");
      fFlowInk.add(params, "flowInkOpacity", 0, 2, 0.01).name("overlay opacity");

      const fFlowVolume = fFlow.addFolder("3-D advected nebula").close();
      fFlowVolume.add(params, "flowVolumeGrid", 16, 96, 4)
        .name("voxel grid N³").onFinishChange(() => renderer.resetFlowVolume());
      fFlowVolume.add(params, "flowVolumeSteps", 24, 256, 4).name("ray steps");

      const fFlowVolumeSource = fFlowVolume.addFolder("passive material source").close();
      fFlowVolumeSource.add(params, "flowVolumeNoiseScale", 0.5, 48, 0.25)
        .name("structure frequency");
      fFlowVolumeSource.add(params, "flowVolumeNoiseOctaves", 1, 5, 1)
        .name("fBm octaves");
      fFlowVolumeSource.add(params, "flowVolumeLacunarity", 1.01, 4, 0.01)
        .name("octave lacunarity");
      fFlowVolumeSource.add(params, "flowVolumePersistence", 0, 1, 0.01)
        .name("octave persistence");
      fFlowVolumeSource.add(params, "flowVolumeNoiseContrast", 0.05, 5, 0.05)
        .name("source contrast");
      const fFlowVolumeDynamics = fFlowVolume.addFolder("material dynamics").close();
      fFlowVolumeDynamics.add(params, "flowVolumeDecay", 0, 5, 0.01)
        .name("dye decay / s");
      fFlowVolumeDynamics.add(params, "flowVolumeInjection", 0, 8, 0.01)
        .name("ambient source injection / s");
      fFlowVolumeDynamics.add(params, "flowVolumeDiffusion", 0, 2, 0.005)
        .name("diffusion / s");
      fFlowVolumeDynamics.add(params, "flowVolumeCorrection", 0, 1, 0.01)
        .name("MacCormack sharpness");

      const fFlowVolumeTransfer = fFlowVolume.addFolder("volume transfer").close();
      fFlowVolumeTransfer.add(params, "flowVolumeSignalGain", 0.05, 20, 0.05)
        .name("dye signal gain");
      fFlowVolumeTransfer.add(params, "flowVolumeSignalPow", 0.05, 5, 0.05)
        .name("dye exponent");
      fFlowVolumeTransfer.add(params, "flowVolumeThreshold", 0, 1, 0.005)
        .name("visibility threshold");
      fFlowVolumeTransfer.add(params, "flowVolumeSoftness", 0.001, 0.5, 0.005)
        .name("threshold softness");
      fFlowVolumeTransfer.add(params, "flowVolumeExtinction", 0, 30, 0.1)
        .name("self-occlusion");
      fFlowVolumeTransfer.add(params, "flowVolumeEmission", 0.05, 30, 0.05)
        .name("HDR emission");
      fFlowVolumeTransfer.add(params, "flowVolumeOpacity", 0, 4, 0.02)
        .name("overlay gain");
      fFlowVolumeTransfer.add(params, "flowVolumeRayJitter", 0, 1, 0.01)
        .name("ray-step dither");
      fFlowVolumeTransfer.add(params, "flowComposite", FLOW_COMPOSITES as unknown as string[])
        .name("composite");

      const fFlowVolumeDither = fFlowVolume.addFolder("granular stochastic medium").close();
      fFlowVolumeDither.add(params, "flowVolumeDitherAmount", 0, 1, 0.01)
        .name("sparsity blend").onChange(syncFolders);
      const flowDitherCoverageC = fFlowVolumeDither
        .add(params, "flowVolumeDitherCoverage", 0.01, 1, 0.01)
        .name("sample coverage");
      const flowDitherScaleC = fFlowVolumeDither
        .add(params, "flowVolumeDitherScale", 2, 160, 1)
        .name("grain frequency");
      const flowDitherRateC = fFlowVolumeDither
        .add(params, "flowVolumeDitherRate", 0, 60, 0.25)
        .name("sampling refresh / s");

      const refreshGui = () => {
        clampState();
        syncFolders();
        gui.controllersRecursive().forEach((c) => c.updateDisplay());
      };
      // -- palette ----------------------------------------------------------
      const fPalette = fAppearance.addFolder("palette").close();
      fPalette
        .add(params, "ramp", [...Object.keys(palettes.ramps), "custom"])
        .listen();
      fPalette.add(params, "rampSpace", ["oklab", "srgb"]);
      const phaseVividC = fPalette.add(params, "phaseVivid");
      const phaseChromaC = fPalette.add(params, "phaseChromaPow", 0, 1, 0.01);
      const okPhaseSignedC = fPalette.add(params, "okPhaseSigned")
        .name("okphase: signed hue");
      fPalette
        .add({ open: () => palettePanel.toggle() }, "open")
        .name("palette editor…");

      // -- quality ----------------------------------------------------------
      const fQuality = fOutput.addFolder("interactive quality").close();
      // Above 1 the backing store is larger than the display and the browser
      // downsamples it — true supersampled anti-aliasing (SSAA). 2 = 4×
      // samples/pixel (smooth), up to 8 = 64× for stills on a strong GPU.
      fQuality.add(params, "renderScale", 0.05, 8, 0.05).name("render scale (≥1 = SSAA)");
      fQuality.add(params, "autoQuality").name("auto (drop res when slow)");

      // -- slice ------------------------------------------------------------
      const fSlice = fRendering.addFolder("slice plane");
      fSlice.add(params, "slicePlane", ["xz", "xy", "yz", "custom"])
        .listen().onChange(syncFolders);
      const sliceAzC = fSlice.add(params, "sliceAz", -180, 180, 0.1).listen();
      const sliceElC = fSlice.add(params, "sliceEl", -89, 89, 0.1).listen();
      const sliceRollC = fSlice.add(params, "sliceRoll", -180, 180, 0.1);
      fSlice.add(params, "sliceOffset", -1, 1, 0.005);
      fSlice.add(params, "sliceZoom", 0.5, 20, 0.01).listen();

      // -- volume: technique + its per-technique subfolders ------------------
      const fVolume = fRendering.addFolder("volume");
      // Eikonal is hidden from the menu (still reachable via ?integrator=eikonal
      // and its folder still appears when selected) — the implementation stays.
      fVolume
        .add(params, "technique", TECHNIQUES.filter((t) => t !== "eikonal") as unknown as string[])
        .onChange(syncFolders);
      const volumeStepsC = fVolume.add(params, "steps", 64, 1200, 1);
      const densityC = fVolume.add(params, "density", 1, 50, 0.5);
      const opacityPowC = fVolume.add(params, "opacityPow", 0.5, 4, 0.05);
      const emissionC = fVolume.add(params, "emission", 0, 20, 0.05);

      const fLight = fVolume.addFolder("key light").close();
      fLight.add(params, "lightAz", -180, 180, 1);
      fLight.add(params, "lightEl", -89, 89, 1);
      const lightGainC = fLight.add(params, "lightGain", 0, 30, 0.1);
      const hgC = fLight.add(params, "hgG", -0.9, 0.9, 0.01).name("anisotropy g");

      const fShadow = fVolume.addFolder("directional shadow").close();
      fShadow.add(params, "shadowSteps", 4, 64, 1);
      fShadow.add(params, "shadowDensity", 0, 400, 1);
      fShadow.add(params, "octaves", 1, 6, 1);
      fShadow.add(params, "octaveGain", 0.1, 0.9, 0.01);
      fShadow.add(params, "octaveExt", 0.1, 0.9, 0.01);

      const fAmbient = fVolume.addFolder("ambient scattering").close();
      fAmbient.add(params, "ambientGain", 0, 10, 0.1);
      fAmbient.add(params, "ambientDirs", 1, 12, 1);
      fAmbient.add(params, "ambientRadius", 0.05, 0.6, 0.01);
      fAmbient.add(params, "ambientDensity", 0, 1000, 5);

      const fMida = fVolume.addFolder("mida").close();
      fMida.add(params, "midaGamma", -1, 1, 0.01).name("γ  (EA ← MIDA → MIP)");

      const fIso = fVolume.addFolder("isosurfaces").close();
      fIso.add(params, "isoLevel", 0.02, 0.98, 0.005).name("level (depth sweep)");
      fIso.add(params, "isoCount", 1, 6, 1);
      fIso.add(params, "isoSpacing", 0.2, 0.95, 0.01);
      fIso.add(params, "isoAlpha", 0.05, 1, 0.01);
      fIso.add(params, "isoEmission", 0, 10, 0.05);
      fIso.add(params, "isoRim", 0, 10, 0.05);
      const isoAmbientC = fIso.add(params, "isoAmbient", 0, 1, 0.01)
        .name("ambient (ramp floor)");

      const fShade = fVolume.addFolder("surface shading").close();
      fShade.add(params, "shadeModel", SHADE_MODELS as unknown as string[])
        .onChange(syncFolders);
      const shadeDiffuseC = fShade.add(params, "shadeDiffuse", 0, 2, 0.01);
      const shadeSpecC = fShade.add(params, "shadeSpec", 0, 10, 0.05);
      const shadeRoughC = fShade.add(params, "shadeRough", 0.02, 1, 0.01);
      const shadeF0C = fShade.add(params, "shadeF0", 0, 0.5, 0.005);
      const shadeConfC = fShade.add(params, "shadeConf", 0, 10, 0.05)
        .name("gradient confidence");
      const gradDeltaC = fShade.add(params, "gradDelta", 0.0005, 0.02, 0.0005);

      const fPt = fVolume.addFolder("path tracer").close();
      fPt.add(params, "maxBounces", 0, 16, 1);
      fPt.add(params, "albedo", 0, 1, 0.01);
      fPt.add(params, "scatterTint", 0, 1, 0.01);
      fPt.add(params, "sppFrame", 1, 8, 1).name("samples / frame");
      fPt.add(params, "aperture", 0, 0.25, 0.001);
      fPt.add(params, "focus", 0.2, 6, 0.01);
      fPt.add(params, "ptEnv", ENVS as unknown as string[]).name("environment");
      fPt.add(params, "ptEnvGain", 0, 5, 0.05);

      const fEik = fVolume.addFolder("eikonal").close();
      fEik.add(params, "eikSteps", 64, 1200, 1).name("steps");
      fEik.add(params, "iorScale", 0, 1.5, 0.005).name("Δn (index scale)");
      fEik.add(params, "eikMap", ["pow", "log"]).name("density map")
        .onChange(syncFolders);
      const eikPowC = fEik.add(params, "eikPow", 0.1, 2, 0.01);
      const eikLogKC = fEik.add(params, "eikLogK", 1, 500, 1);
      fEik.add(params, "absorb", 0, 20, 0.05);
      fEik.add(params, "eikEmission", 0, 10, 0.05);
      fEik.add(params, "dispersion", 0, 0.2, 0.001);
      fEik.add(params, "eikEnv", ENVS as unknown as string[]).name("environment");
      fEik.add(params, "eikEnvGain", 0, 5, 0.05);
      fEik.add(params, "eikGradDelta", 0.0005, 0.02, 0.0005);

      // -- camera -----------------------------------------------------------
      const fCamera = fNavigation.addFolder("camera");
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
      fCamera.add(params, "axes").name("orientation axes").onChange(syncFolders);
      const axesGizmoC = fCamera.add(params, "axesGizmo").name("↳ compact gizmo");

      // -- clip planes ------------------------------------------------------
      const fClips = fNavigation.addFolder("clip planes").close();
      const clipFolder = (label: string, c: (typeof params.clips)[0]) => {
        const f = fClips.addFolder(label);
        f.add(c, "enabled").name("enable cut");
        f.add(c, "axis", ["forward", "right", "up"]);
        f.add(c, "offset", -1.2, 1.2, 0.005).name("offset / R");
        f.add(c, "flip").name("keep near side");
        f.add(c, "camLock").name("follow camera");
        return f;
      };
      clipFolder("plane A", params.clips[0]);
      clipFolder("plane B", params.clips[1]);

      // -- capture ----------------------------------------------------------
      const fCapture = fOutput.addFolder("image capture").close();
      fCapture.add(params, "captureScale", 0.25, 8, 0.25)
        .name("capture render scale");
      const captureSppC = fCapture.add(params, "captureSpp", 1, 512, 1)
        .name("pathtrace target spp");
      const captureFlowFramesC = fCapture.add(params, "captureFlowFrames", 1, 240, 1)
        .name("flow warm-up frames");
      fCapture.add({ png: () => (captureRequested = true) }, "png")
        .name("render PNG  (P)");
      fCapture
        .add({ url: () => { syncUrl(); navigator.clipboard?.writeText(location.href); } }, "url")
        .name("copy view URL  (U)");
      fCapture
        .add({ help: () => help.toggle() }, "help")
        .name("keyboard help  (H)");

      presetsPanel = new PresetsPanel({
        presets: VIEWER_PRESETS,
        onApply: (preset) => {
          applyViewerPreset(params, preset, asset.nMax);
          if (preset.camera) {
            if (rig.mode !== "orbit") rig.setMode("orbit", framing());
            rig.azDeg = preset.camera.azDeg;
            rig.elDeg = preset.camera.elDeg;
            rig.dist = preset.camera.dist;
            camUi.mode = rig.mode;
            // A preset camera is the scene's authored starting frame. Fixed
            // clip axes enabled afterwards should use that frame, matching a
            // copied URL and the offline renderer.
            basePose = rig.pose(1);
          }
          timeUi.log = Math.log10(params.timeScale);
          flowSpeedUi.log = Math.log10(params.flowTimeScale);
          params.flowResetNonce += 1;
          renderer.resetFlowParticles();
          renderer.resetFlowInk();
          renderer.resetFlowVolume();
          renderer.resetAccum();
          if (termsPanel.visible) termsPanel.render();
          refreshGui();
          syncUrl();
        },
      });
      cleanups.push(() => presetsPanel.root.remove());

      /** Which folders each view/technique needs. */
      function syncFolders() {
        const vol = params.view === "volume";
        const t = params.technique;
        const iso = t === "iso" || t === "isolegacy";
        const show = (item: { show(): unknown; hide(): unknown }, cond: boolean) =>
          (cond ? item.show() : item.hide());
        const shadeOn = params.shadeModel !== "off";
        const glossyShade = params.shadeModel === "blinn" || params.shadeModel === "ggx";
        const phaseColorActive = params.color === "phase"
          || (params.flowEnabled && params.flowColor === "phase");
        show(fSlice, !vol);
        show(fVolume, vol);
        show(fCamera, vol);
        show(fClips, vol);
        show(tonemapC, vol);
        show(exposureC, vol);
        show(compressKC, params.compress !== "off");
        show(phaseVividC, phaseColorActive);
        show(phaseChromaC, phaseColorActive);
        show(okPhaseSignedC, params.color === "okphase");
        show(fBloom, params.postEnabled);
        show(fGrade, params.postEnabled);
        show(fLens, params.postEnabled);
        show(fGrain, params.postEnabled);
        bloomControls.forEach((c) => show(c, params.postEnabled && params.bloomEnabled));
        show(aberrationFalloffC, params.postEnabled && params.postAberration > 0);
        vignetteControls.forEach((c) =>
          show(c, params.postEnabled && params.vignetteEnabled));
        grainControls.forEach((c) =>
          show(c, params.postEnabled && params.grainEnabled));
        const hasSuperposition = params.terms.length > 0;
        show(nC, !hasSuperposition);
        show(lC, !hasSuperposition);
        show(mC, !hasSuperposition);
        show(sliceAzC, !vol && params.slicePlane === "custom");
        show(sliceElC, !vol && params.slicePlane === "custom");
        show(sliceRollC, !vol && params.slicePlane === "custom");

        show(volumeStepsC, vol && t !== "pathtrace" && t !== "eikonal");
        const transferActive = vol && t !== "mip" && !iso && t !== "eikonal";
        show(densityC, transferActive);
        show(opacityPowC, transferActive);
        show(emissionC, transferActive);

        const lightActive = vol && (t === "scatter" || t === "pathtrace" || iso
          || (t === "ea" && shadeOn));
        show(fLight, lightActive);
        show(lightGainC, lightActive && (t === "scatter" || t === "pathtrace"
          || (shadeOn && (t !== "iso" || glossyShade))));
        show(hgC, vol && (t === "scatter" || t === "pathtrace"));
        show(fShadow, vol && (t === "scatter" || (iso && shadeOn)));
        show(fAmbient, vol && t === "scatter");
        show(fMida, vol && t === "mida");
        show(fIso, vol && iso);
        show(isoAmbientC, vol && t === "iso");
        show(fShade, vol && (iso || ["ea", "scatter"].includes(t)));
        show(shadeDiffuseC, vol && shadeOn
          && (["ea", "scatter", "isolegacy"] as string[]).includes(t));
        show(shadeSpecC, vol && shadeOn && glossyShade);
        show(shadeRoughC, vol && shadeOn && glossyShade);
        show(shadeF0C, vol && shadeOn && glossyShade);
        show(shadeConfC, vol && shadeOn && (t === "ea" || t === "scatter"));
        show(gradDeltaC, vol && (iso || (shadeOn && (t === "ea" || t === "scatter"))));
        show(fPt, vol && t === "pathtrace");
        show(fEik, vol && t === "eikonal");
        show(eikPowC, vol && t === "eikonal" && params.eikMap === "pow");
        show(eikLogKC, vol && t === "eikonal" && params.eikMap === "log");
        show(axesGizmoC, vol && params.axes);

        const volumeFlow = (FLOW_VOLUME_METHODS as readonly string[])
          .includes(params.flowMethod);
        const particleFlow = params.flowMethod !== "ink" && !volumeFlow;
        show(fFlowParticles, particleFlow);
        show(fFlowInk, params.flowMethod === "ink");
        show(fFlowVolume, volumeFlow);
        show(fFlowVolumeTransfer, volumeFlow);
        show(fFlowVolumeDither, volumeFlow);
        show(flowSubstepsC, params.flowMethod !== "ink");
        show(flowSpawnTriesC, particleFlow);
        show(flowSeedClipsC, params.flowMethod !== "ink");
        show(flowColorGainC, params.flowColor !== "palette-material");
        const stochasticVolume = volumeFlow && params.flowVolumeDitherAmount > 0;
        show(flowDitherCoverageC, stochasticVolume);
        show(flowDitherScaleC, stochasticVolume);
        show(flowDitherRateC, stochasticVolume);
        show(captureSppC, vol && t === "pathtrace");
        show(captureFlowFramesC, params.flowEnabled && !volumeFlow);
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
      let panelMemory = { terms: false, palette: false, presets: false };
      let captureRequested = false;
      let captureActive = false;
      let captureExporting = false;
      let captureFrames = 0;
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
            if (!captureActive) captureRequested = true;
            break;
          case "KeyU":
            syncUrl();
            navigator.clipboard?.writeText(location.href);
            break;
          case "KeyG":
            guiVisible = !guiVisible;
            gui.show(guiVisible);
            if (!guiVisible) {
              panelMemory = {
                terms: termsPanel.visible,
                palette: palettePanel.visible,
                presets: presetsPanel.visible,
              };
              termsPanel.hide();
              palettePanel.hide();
              presetsPanel.hide();
            } else {
              if (panelMemory.terms) termsPanel.show();
              if (panelMemory.palette) palettePanel.show();
              if (panelMemory.presets) presetsPanel.show();
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
        captureExporting = true;
        const state =
          params.terms.length > 0
            ? `sup${params.terms.length}`
            : `${params.n}_${params.l}_${params.m}`;
        const tag = params.view === "slice" ? "slice" : params.technique;
        const time = params.simTime !== 0 ? `_t${params.simTime.toFixed(1)}` : "";
        canvas.toBlob((blob) => {
          if (blob) {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `hydrogen_${state}_${tag}${time}_${canvas.width}x${canvas.height}.png`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          }
          captureExporting = false;
          captureActive = false;
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
        if (!params.autoQuality || fixedSize || captureActive) return;
        if (params.view === "volume" && params.technique === "pathtrace") return;
        if ((governAge += dt) < 0.5) return;
        governAge = 0;
        if (emaMs > 45 && qualityMul > 0.3) qualityMul = Math.max(0.3, qualityMul * 0.8);
        else if (emaMs < 15 && qualityMul < 1) qualityMul = Math.min(1, qualityMul / 0.8);
      };

      // ---------------------------------------------------------- the loop
      const resize = (captureScale?: number) => {
        const s = captureScale ?? params.renderScale * qualityMul;
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

      let lastFlowStateSig = "";
      let lastFlowTrailSig = "";
      let lastFlowInkSig = "";
      let lastFlowVolumeSig = "";

      let lastT = performance.now();
      let fixedFlowFrames = 0;
      let emaMs = 0;
      let statsAge = 0;
      const loop = (tMs: number) => {
        if (disposed) return;
        const dt = Math.min((tMs - lastT) / 1000, 0.1);
        lastT = tMs;
        if (captureRequested && !captureActive) {
          captureRequested = false;
          captureActive = true;
          captureFrames = 0;
          lastPtSig = "";
          lastFlowTrailSig = "";
          lastFlowInkSig = "";
          renderer.resetAccum();
          renderer.resetFlowTrails();
          renderer.resetFlowInk();
        }
        govern(dt, emaMs);
        resize(captureActive ? params.captureScale : undefined);
        rig.update(dt, framing());

        // Simulated time: advance while running (never in deterministic shot
        // mode — there t comes fixed from the URL).
        if (params.timeRun && !fixedSize && !captureActive)
          params.simTime += dt * params.timeScale;

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

        const flowIsVolume = (FLOW_VOLUME_METHODS as readonly string[])
          .includes(params.flowMethod);
        const flowIsParticles = params.flowMethod !== "ink" && !flowIsVolume;
        const flowSupported = !flowIsParticles || renderer.floatRenderable;
        const flowCompatible = flowSupported
          && (params.view === "slice") === (params.flowMethod === "ink");
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
          flowOverlayEnabled: params.flowEnabled && flowCompatible,
          flowBase: params.flowBase,
        };
        const flowField: FlowFieldParams = {
          derivative: FLOW_DERIVATIVE[params.flowDerivative],
          derivativeDelta: params.flowDelta,
          nodeEps: params.flowNodeEps,
          timeScale: params.flowTimeScale,
          maxSpeed: params.flowMaxSpeed,
          reverse: params.flowReverse,
          integrator: FLOW_INTEGRATOR[params.flowIntegrator],
          substeps: params.flowSubsteps,
          seedMode: FLOW_SEED[params.flowSeed],
          seedPower: params.flowSeedPower,
          spawnTries: params.flowSpawnTries,
          seedInsideClips: params.flowSeedInsideClips,
          resetNonce: params.flowResetNonce,
        };
        const flowDt = params.flowEnabled && params.flowRun
          ? (fixedSize || captureActive ? 1 / 60 : dt)
          : 0;
        const flowFieldSignature = JSON.stringify([
          params.n, params.l, params.m, params.mode,
          params.terms.map((term) => [term.n, term.l, term.m, term.amp, term.phaseDeg]),
          params.superNormalize, params.flowDerivative, params.flowDelta,
          params.flowNodeEps, params.flowSeed, params.flowSeedPower,
          params.flowSpawnTries, params.flowResetNonce,
        ]);

        renderer.beginPresentation(params.postEnabled);
        let axesCamera: CameraParams | null = null;
        if (params.view === "slice") {
          // Aspect correction: uv spans the full canvas on both axes, so equal
          // half-extents would stretch the field on a non-square canvas. The
          // U axis gets the width/height factor — pixels become square, the
          // vertical extent stays the framing (the volume renderer's
          // vertical-FOV convention), and wider windows just see more world.
          const sp = slicePlaneVectors(params, framing());
          const aspect = canvas.width / canvas.height;
          const slice = { ...sp, axisU: scale(sp.axisU, aspect) };
          renderer.renderSlice({ common, ...slice });
          if (params.flowEnabled && params.flowMethod === "ink") {
            const inkSig = JSON.stringify([
              flowFieldSignature, slice.origin, slice.axisU, slice.axisV,
              params.flowTimeScale, params.flowMaxSpeed, params.flowReverse,
              params.flowIntegrator, params.flowSeedInsideClips,
              params.flowInkScale, canvas.width, canvas.height,
            ]);
            if (inkSig !== lastFlowInkSig) {
              lastFlowInkSig = inkSig;
              renderer.resetFlowInk();
            }
            renderer.renderFlowInk({
              common,
              field: flowField,
              dt: flowDt,
              origin: slice.origin,
              axisU: slice.axisU,
              axisV: slice.axisV,
              colorMode: FLOW_COLOR[params.flowColor],
              colorGain: params.flowColorGain,
              colorFloor: params.flowColorFloor,
              densityGate: params.flowDensityGate,
              noiseScale: params.flowInkScale,
              decay: params.flowInkDecay,
              injection: params.flowInkInjection,
              diffusion: params.flowInkDiffusion,
              throughFade: params.flowInkThroughFade,
              contrast: params.flowInkContrast,
              opacity: params.flowInkOpacity,
            });
          }
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
          axesCamera = camera;
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

          let flowParticles: FlowParticleParams | null = null;
          if (params.flowEnabled && flowIsParticles && renderer.floatRenderable) {
            const particleStateSig = JSON.stringify([
              flowFieldSignature, params.flowParticleSide,
              params.flowSeedInsideClips ? clips : 0,
            ]);
            if (particleStateSig !== lastFlowStateSig) {
              lastFlowStateSig = particleStateSig;
              renderer.resetFlowParticles();
            }
            const trailSig = JSON.stringify([
              particleStateSig, pose.pos, pose.fwd, pose.up, clips,
              canvas.width, canvas.height, params.flowStreakLength,
              params.flowTimeScale, params.flowMaxSpeed, params.flowReverse,
              params.flowIntegrator, params.flowSubsteps,
              params.flowSpeedStretch, params.flowWidth, params.flowHalo,
              params.flowHaloGain, params.flowTailPower, params.flowHeadBoost,
              params.flowOpacity, params.flowTrailHalfLife,
              params.flowTrailDiffusion, params.flowColor,
              params.flowColorGain, params.flowColorFloor,
              params.flowDensityGate,
              params.ramp, params.ramp === "custom" ? params.rampStops : 0,
              params.rampSpace, params.phaseL, params.phaseC, params.phaseH0Deg,
              params.flowClipVisible,
            ]);
            if (trailSig !== lastFlowTrailSig) {
              lastFlowTrailSig = trailSig;
              renderer.resetFlowTrails();
            }
            flowParticles = {
              common,
              camera,
              field: flowField,
              dt: flowDt,
              particleSide: params.flowParticleSide,
              lifetime: params.flowLifetime,
              streakLength: params.flowStreakLength,
              speedStretch: params.flowSpeedStretch,
              widthPx: params.flowWidth,
              halo: params.flowHalo,
              haloGain: params.flowHaloGain,
              tailPower: params.flowTailPower,
              headBoost: params.flowHeadBoost,
              opacity: params.flowOpacity,
              trailHalfLife: params.flowTrailHalfLife,
              trailDiffusion: params.flowTrailDiffusion,
              emission: params.flowEmission,
              compositeOpacity: params.flowCompositeOpacity,
              compositeMode: FLOW_COMPOSITE[params.flowComposite],
              colorMode: FLOW_COLOR[params.flowColor],
              colorGain: params.flowColorGain,
              colorFloor: params.flowColorFloor,
              densityGate: params.flowDensityGate,
              clipVisible: params.flowClipVisible,
            };
            renderer.advanceFlowParticles(flowParticles);
          }

          let flowVolume: FlowVolumeParams | null = null;
          if (params.flowEnabled && flowIsVolume) {
            const volumeStateSig = JSON.stringify([
              flowFieldSignature, params.flowVolumeGrid,
              params.flowSeedInsideClips ? clips : 0,
              params.flowVolumeNoiseScale, params.flowVolumeNoiseOctaves,
              params.flowVolumeLacunarity, params.flowVolumePersistence,
              params.flowVolumeNoiseContrast,
            ]);
            if (volumeStateSig !== lastFlowVolumeSig) {
              lastFlowVolumeSig = volumeStateSig;
              renderer.resetFlowVolume();
            }
            flowVolume = {
              common,
              camera,
              field: flowField,
              dt: flowDt,
              grid: params.flowVolumeGrid,
              steps: params.flowVolumeSteps,
              noiseScale: params.flowVolumeNoiseScale,
              noiseOctaves: params.flowVolumeNoiseOctaves,
              lacunarity: params.flowVolumeLacunarity,
              persistence: params.flowVolumePersistence,
              noiseContrast: params.flowVolumeNoiseContrast,
              decay: params.flowVolumeDecay,
              injection: params.flowVolumeInjection,
              diffusion: params.flowVolumeDiffusion,
              correction: params.flowVolumeCorrection,
              signalGain: params.flowVolumeSignalGain,
              signalPow: params.flowVolumeSignalPow,
              threshold: params.flowVolumeThreshold,
              softness: params.flowVolumeSoftness,
              extinction: params.flowVolumeExtinction,
              emission: params.flowVolumeEmission,
              opacity: params.flowVolumeOpacity,
              ditherAmount: params.flowVolumeDitherAmount,
              ditherScale: params.flowVolumeDitherScale,
              ditherRate: params.flowVolumeDitherRate,
              ditherCoverage: params.flowVolumeDitherCoverage,
              rayJitter: params.flowVolumeRayJitter,
              colorMode: FLOW_COLOR[params.flowColor],
              colorGain: params.flowColorGain,
              colorFloor: params.flowColorFloor,
              densityGate: params.flowDensityGate,
              compositeMode: FLOW_COMPOSITE[params.flowComposite],
            };
            // Offscreen atlas work precedes the default-framebuffer base pass,
            // matching the particle path's cross-driver-safe ordering.
            renderer.advanceFlowVolume(flowVolume);
          }

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
          if (flowParticles) renderer.compositeFlowParticles(flowParticles);
          if (flowVolume) renderer.compositeFlowVolume(flowVolume);
        }

        const deterministicTime = fixedSize
          ? params.simTime + fixedFlowFrames / 60
          : captureActive
            ? params.simTime + captureFrames / 60
            : tMs / 1000;
        renderer.finishPresentation({
          bloomEnabled: params.bloomEnabled,
          bloomThreshold: params.bloomThreshold,
          bloomKnee: params.bloomKnee,
          bloomIntensity: params.bloomIntensity,
          bloomRadius: params.bloomRadius,
          bloomIterations: params.bloomIterations,
          bloomScale: params.bloomScale,
          bloomSaturation: params.bloomSaturation,
          bloomTint: hexToSrgb(params.bloomTint) ?? [1, 1, 1],
          bloomComposite: params.bloomComposite === "additive" ? 1 : 0,
          exposure: params.postExposure,
          contrast: params.postContrast,
          saturation: params.postSaturation,
          vibrance: params.postVibrance,
          aberrationPx: params.postAberration,
          aberrationFalloff: params.postAberrationFalloff,
          vignetteEnabled: params.vignetteEnabled,
          vignetteAmount: params.vignetteAmount,
          vignetteRadius: params.vignetteRadius,
          vignetteSoftness: params.vignetteSoftness,
          vignetteRoundness: params.vignetteRoundness,
          vignetteCenter: [params.vignetteCenterX, params.vignetteCenterY],
          grainEnabled: params.grainEnabled,
          grainAmount: params.grainAmount,
          grainScale: params.grainScale,
          grainTime: deterministicTime * params.grainSpeed,
          grainColored: params.grainColored,
        });
        // Axes are a measurement overlay: draw them after finishing so bloom,
        // aberration, and grain cannot soften or tint their direction colors.
        if (axesCamera && params.axes) {
          const f = framing();
          renderer.renderAxes(
            axesCamera, f * (params.axesGizmo ? 0.22 : 1000), f * 0.002,
          );
        }
        // The first completed frame retires the loading screen (idempotent).
        endLoadingScreen();

        if (captureActive) {
          captureFrames += 1;
          const pathReady = params.view !== "volume"
            || params.technique !== "pathtrace"
            || renderer.pathtraceSamples >= params.captureSpp;
          const flowNeedsHistory = params.flowEnabled && params.flowRun
            && flowCompatible && !flowIsVolume;
          const flowReady = !flowNeedsHistory
            || captureFrames >= params.captureFlowFrames;
          if (pathReady && flowReady && !captureExporting) captureFrame();
        }
        if (fixedSize && params.flowEnabled && params.flowRun && flowCompatible)
          fixedFlowFrames += 1;

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
          const capture = captureActive
            ? ` · CAPTURE ${canvas.width}×${canvas.height}`
            : "";
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
            `${canvas.width}×${canvas.height} · ${emaMs.toFixed(1)} ms${spp}${quality}${capture}\n${help_}`;
          flowLegendEl.hidden = !params.flowEnabled || !params.flowLegend;
          if (!flowLegendEl.hidden) {
            const color = params.flowColor === "phase"
              ? "hue = arg ψ"
              : params.flowColor === "palette-speed"
                ? "active palette = transport speed"
                : params.flowMethod === "ink"
                  ? "active palette = dye concentration"
                  : flowIsVolume
                    ? "active palette = advected material coordinate"
                    : "active palette = tracer age";
            const method = params.flowMethod === "ink"
              ? "semi-Lagrangian slice dye · tangential v; through-plane flow fades"
              : flowIsVolume
                ? `${params.flowVolumeGrid}³ passive-dye atlas · stochastic raymarch · analytic ρ gate`
                : `${params.flowParticleSide ** 2} ${params.flowSeed}-biased motes · persistent pathline light`;
            flowLegendEl.textContent = !flowSupported
              ? "ADVECTED PROBABILITY FLOW\n3-D motes need EXT_color_buffer_float on this GPU"
              : flowCompatible
              ? `ADVECTED PROBABILITY FLOW  v = j/(ρ+ε)\n${method}\n${color} · ${params.flowRun ? "running" : "paused"}${params.flowReverse ? " backward" : ""}`
              : `ADVECTED PROBABILITY FLOW\n${params.flowMethod === "ink" ? "ink requires slice view" : "3-D flow requires volume view"}`;
          }
        }

        // Shot mode (?size=N) renders deterministically and stops: one frame
        // for the direct techniques, or — for the path tracer — as many
        // accumulation passes as it takes to reach ?spp=N samples per pixel.
        const pathConverging =
          params.view === "volume" &&
          params.technique === "pathtrace" &&
          renderer.pathtraceSamples < sppTarget;
        const flowConverging = params.flowEnabled && params.flowRun
          && flowCompatible && fixedFlowFrames < flowFramesTarget;
        const converging = pathConverging || flowConverging;
        if (!fixedSize || !converging)
          (window as unknown as { __renderReady?: boolean }).__renderReady = true;
        if (!fixedSize || converging) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    })().catch((err) => {
      console.error(err);
      endLoadingScreen();
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
      <div ref={flowLegendRef} className="flow-legend" hidden />
      {/* Loading screen: its own renderer + baked data (lib/loading-scene.ts),
          covering the app until the first real frame is on the canvas. */}
      <div ref={loadingRef} className="loading">
        {/* the canvas is prepended here by the effect */}
        <div className="loading-caption">
          <div className="loading-title">hydrogen</div>
          <div className="loading-state">|1,0,0⟩ + |2,1,0⟩ · e^(−iEₙt)</div>
          <div className="loading-bar">
            <i ref={loadingBarRef} />
          </div>
          <div ref={loadingNoteRef} className="loading-note">
            starting
          </div>
        </div>
      </div>
    </>
  );
}
