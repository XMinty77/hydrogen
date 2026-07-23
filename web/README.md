# web — interactive renderer

This directory contains the Next.js static shell around the shared WebGL2
renderer. Physics and color evaluation remain in the baked asset and GLSL
sources used by the C# export host; the web layer owns interaction, URL state,
presets, GPU resource lifetime, and capture.

## Running

```sh
npm install
npm run dev -- -p 3001
npm run build
```

`scripts/sync-assets.mjs`, invoked before development and production builds,
copies `../assets/orbitals.bin`, `../assets/palettes.json`, and `../shaders/`
into `public/generated/`. The production build is a static export in `out/`.

## Interface

The main control panel is organized by intent:

- **scene** — quantum state, superposition editor, view, and time evolution.
- **appearance** — display mapping, palette editing, and screen-space finishing.
- **rendering** — slice geometry or the selected volume technique and its
  relevant controls.
- **probability flow** — transport, seeding, and method-specific appearance.
- **camera + clipping** — orbit/fly controls, orientation axes, and two clip
  planes.
- **output** — interactive quality, capture quality, URL copying, and help.

The **browse presets…** button opens a separate curated panel. Presets live in
`lib/presets.ts` and are grouped into superpositions and selected
probability-flow studies. Applying one loads a deterministic scene and camera,
resets stateful flow and path-tracing buffers, and preserves only interactive
and capture quality preferences. Every resulting parameter remains editable.

The superposition editor builds

    ψ = Σₖ cₖ |nₖ,lₖ,mₖ⟩

from at most eight terms. Each row exposes quantum numbers, amplitude, and
initial phase; optional normalization and the live beat-period estimate help
compare stationary same-energy combinations with moving multi-energy states.
The six supplied superposition presets are sp, sp³, a 1s–2p dipole beat,
2s+3s shell breathing, a 3s+3p+3d lobe, and a circular Rydberg packet.

The palette editor supports draggable stops, sRGB or OKLab interpolation,
per-stop OKLCH editing, phase-wheel controls, and URL/JSON export. Display
color modes are:

- `ramp`: brightness through the selected ramp.
- `signed`: real-wavefunction sign encoded by a reflected OKLab hue.
- `phase`: argument of ψ encoded by the phase wheel.
- `okphase`: the active ramp hue-rotated by argument of ψ, optionally with a
  complementary signed-half reflection.

### Post processing

Post processing is opt-in and display-referred: it operates after the analytic
renderer and any genuine-flow composite, so it cannot change ψ, density,
probability current, clipping, or advection. The completed result is also what
PNG capture exports. Available controls are:

- **bloom** — soft-knee bright-pass threshold, intensity, blur radius,
  iterations, independently scaled bloom buffer, saturation, tint, and
  screen/additive compositing;
- **color grade** — post exposure, contrast, saturation, and vibrance;
- **lens finishing** — radial chromatic shift plus an independently centered,
  aspect-aware vignette with amount, radius, softness, and roundness;
- **film grain** — amount, grain size, refresh rate, and monochrome/colored
  noise. Automated screenshots and captures advance it deterministically.

Bloom works from a separate downsampled ping-pong buffer, so `buffer scale`,
`blur iterations`, and `blur radius` trade cost against spread independently.
Orientation axes resolve after post processing and remain crisp measurement
overlays.

## Analytic rendering

Slices can use the `xz`, `xy`, `yz`, or an arbitrary oriented and offset
plane. Volume techniques are:

- `mip`: maximum-intensity projection.
- `ea`: emission–absorption, the default translucent density renderer.
- `scatter`: EA plus directional shadowing and anisotropic ambient
  multi-scattering.
- `mida`: a continuous EA–MIDA–MIP blend.
- `iso`: nested, refined probability-density isosurfaces with palette-mapped
  lighting.
- `isolegacy`: the same isosurfaces with self-emissive shell color and white
  specular response.
- `pathtrace`: progressive delta-tracking volume path tracing.
- `eikonal`: curved rays in a density-derived refractive-index field. It is
  intentionally absent from the technique dropdown but remains available
  through `?integrator=eikonal`.

The volume renderer exposes extinction, emission, transfer mapping, light,
multi-scatter, isosurface, local-shading, path-tracing, and eikonal parameters
only where they are relevant. Two independently oriented clip planes apply to
volume density and active probability-flow overlays.

## Probability flow

The flow renderer differentiates the complex wavefunction rather than wrapped
phase and computes the spinless current and regularized transport field:

    j = Im(conj(ψ) ∇ψ)
    vε = j / (ρ + ε)

`ε` only regularizes nodes. Euler and midpoint/RK2 integration, second- and
fourth-order derivatives, 1–4 substeps, forward/reverse time, and a spatial
safety cap are exposed. The procedural material source is fixed in world
space, so a real single state is a strict zero-current control whose visible
material remains stationary.

Five presentations are active:

- **ink** backtraces a persistent slice texture through the in-plane
  component of `vε`. Normal flow attenuates material rather than appearing as
  false planar motion. Injection scale, rate, decay, diffusion, contrast,
  through-plane loss, and opacity are separate controls.
- **motes** advect discrete persistent GPU samples with minimal temporal
  history.
- **trails** add local displacement-oriented streaks and a decaying HDR
  history buffer, revealing direction and shear.
- **accretion** uses the same transported particles with longer-lived,
  additive cores and halos. On circular states its disk motion comes from the
  orbital current itself.
- **granular** semi-Lagrangian-advects a persistent RGB passive-material
  field in a 3-D atlas. A bounded MacCormack correction limits numerical
  diffusion. Raymarching combines that material with freshly evaluated
  analytic density, then uses expectation-preserving stochastic sparsity to
  make the evolving texture visible throughout the volume.

Particle seeding can be density-, flux-, or uniformly biased. Density and
flux modes use interactive rejection sampling and are visualization seeds,
not exact Born-distribution samples. Once accepted, every particle and dye
sample follows `vε`; no visual treatment adds a decorative velocity.

The flow palette may encode speed, material/age, or phase. The granular
method separately exposes atlas resolution, ray steps, source fBm,
injection/decay/diffusion, correction strength, signal mapping, extinction,
emission, opacity, ray jitter, grain coverage, spatial frequency, and temporal
refresh. Atlas and raymarch resolution are deliberately independent. The
RGBA8 atlas avoids requiring float-render-target extensions.

## Cameras and interaction

Volume view supports an orbit camera and a pointer-locked fly camera. In fly
mode, center lock keeps the view on the nucleus while movement traverses a
sphere around it. Slice dragging rotates a custom plane and the wheel changes
slice zoom.

Keyboard controls:

| Key | Action |
|---|---|
| Space | Play or pause time evolution. |
| R | Reset simulated time. |
| P | Render and download a PNG using the capture settings. |
| U | Copy the current view URL. |
| C | Toggle center-locked fly navigation. |
| G | Hide or show all panels. |
| H or ? | Open keyboard help. |
| Esc | Return focus to the canvas and release pointer lock. |

## Interactive and capture quality

`renderScale` controls the live canvas backing store relative to CSS pixels
and device pixel ratio. Values below one improve responsiveness; values above
one provide supersampled antialiasing. The optional quality governor lowers
only the live scale when frame time rises.

PNG capture has independent settings:

- `captureScale` temporarily replaces the live scale and ignores the quality
  governor.
- `captureSpp` is the progressive path-tracer convergence target.
- `captureFlowFrames` rebuilds resolution-dependent ink and trail history at
  the capture resolution.

While capturing, time is frozen and transport advances at a fixed 1/60-second
step. The renderer exports only after the selected convergence/history target,
then restores the interactive backing-store size on the next frame. A
`size=N` screenshot-harness URL remains authoritative over both live and
capture scale.

## URLs and automated screenshots

The address bar mirrors non-default controls without adding navigation
history. Unknown parameters are ignored. Representative URLs:

```text
?view=slice&state=2,1,1&mode=complex&plane=xy&flow=1&flowMethod=ink
?state=4,3,3&mode=complex&flow=1&flowMethod=accretion&clip=up,0
?state=3,2,2&mode=complex&flow=1&flowMethod=granular&flowColor=phase
?terms=1,0,0;2,1,0&mode=real&color=signed&time=1&timeScale=4
?integrator=iso&shadeModel=ggx&isoCount=3&scale=1
```

The offline host accepts the shared analytic-render vocabulary:

```sh
dotnet run --project ../export -- url "<web URL>"
```

The exporter also consumes the post-processing URL vocabulary. Its CPU resolve
mirrors the browser effects while leaving post-disabled renders unchanged.

For deterministic browser captures, `size=N` fixes a square backing store,
`spp=N` sets path-tracer convergence, `t=N` fixes simulated time, and
`flowFrames=N` sets fixed-step flow warm-up:

```sh
npm run shot -- "view=slice&state=4,2,1&size=1024" .shots/slice.png
```

`SHOT_BASE` selects a non-default dev-server URL; `SHOT_GPU=1` requests the
real GPU path.

## Code layout

- `components/OrbitalViewer.tsx` — application orchestration, lil-gui,
  interaction, render loop, and capture lifecycle.
- `lib/params.ts` — typed user-facing state and URL codec.
- `lib/presets.ts` — curated preset catalog and application logic.
- `lib/panels.ts` — preset, superposition, palette, and help overlays.
- `lib/renderer.ts` — WebGL resources, shader assembly, flow state, and draw
  passes.
- `lib/superposition.ts` — term validation, coefficients, and time evolution.
- `lib/scene.ts`, `lib/cameras.ts` — plane geometry and navigation.
- `lib/horb.ts`, `lib/palettes.ts`, `lib/color.ts` — assets and perceptual
  color support.
