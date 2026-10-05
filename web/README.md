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
into `public/generated/`. It also generates a compact orbital catalog and
650 individual table files, copied byte-for-byte from the certified bake.
The production build is a static export in `out/`.

## Loading screen

`components/LoadingScreen.tsx` includes critical loader CSS and a small classic
script in the initial HTML. The script draws the original orbital immediately,
then hands animation to a WebGL2 OffscreenCanvas worker so GUI construction and
other main-thread JavaScript do not freeze it. There are no loader image, video,
table, shader, or extra JavaScript network requests. The shared app stylesheet
remains a separate render-blocking request, as requested; first paint still
waits for it. The runtime is approximately 6.7 KB gzipped, and the complete
loader markup/styles are approximately 7.5 KB gzipped.

`lib/loading-orbital.ts` specializes the archived `lib/loading-scene.ts`
reference. It evaluates the same normalized, equal-amplitude
`|1,0,0⟩ + |2,1,0⟩` superposition directly, without lookup textures:

```text
a(r) = exp(-r) / sqrt(pi)
b(r,z) = z exp(-r/2) / (4 sqrt(2 pi))
psi(r,z,t) = [a(r) exp(i t/2) + b(r,z) exp(i t/8)] / sqrt(2)
```

It retains the reference's perspective camera at 89° elevation, three density
isosurfaces, signed real-wavefunction OKLab color mapping, finite-difference
normals, GGX lighting, shadows, and bloom. The backdrop matches the black page
without changing the orbital palette. In atomic units `E_n = -1/(2n²)`;
at 4 au/s the density alone repeats after 4.18879 seconds, while the complete
signed color and geometry cycle repeats after 12.56637 seconds. Discarding the
wavefunction's sign would lose the original color sequence and internal
structure. The direct basis formulas closely match the reference's interpolated
Float32 tables: a 16-phase comparison at equal 256² resolution measured a
maximum mean absolute channel error below 0.025 on a 0–255 scale.
The comparison gives the archived reference the same black backdrop.

The approximation is the rendering budget: at most 256² pixels, with the
reference's 64-step raymarch and bisection-refined surfaces. Slow devices can
reduce resolution further. Bootstrap and worker share a wall-clock phase
origin, preventing a reset at handoff. The bootstrap context is released when
the worker presents its first frame. The worker releases resources when the
loader becomes hidden or is removed, and on page exit. Reduced-motion preference
shows one real orbital frame; browsers without the worker path keep the
main-thread live renderer. Viewer initialization waits for worker readiness
for at most the approved 250 ms.

`npm run bake:loading-runtime` compiles/minifies the self-contained factory and
`scripts/loading-bootstrap.js` into `lib/loading-runtime.ts`; development and
production builds regenerate it automatically. The generated code includes
neither the baked lookup arrays nor third-party runtime dependencies.

`npm run check:loading` against a production export checks animation before
framework JavaScript arrives, zero image/video requests, moving compositor
filmstrip frames through a 700 ms main-thread stall, mobile/reduced-motion and
worker fallback behavior, actual viewer startup/hydration, and context/worker
cleanup. It reports main-shader compilation gaps including interval edges;
these are measurements, not a claim of guaranteed smooth cold compilation.
`npm run check:loading-reference` independently samples 16 phases against the
archived table-based renderer and writes `.shots/loading-cycle-comparison.png`.
Use `MESA_SHADER_CACHE_DISABLE=true npm run check:loading` to expose cold driver
compilation on Mesa. The Intel/OpenGL test setup still pauses presentation
roughly 300–450 ms on a cold heavy superposition shader, even with the loader
in a worker. The accepted stable version keeps the live loader; ahead-of-time
playback and shader-specialization tradeoffs are recorded for later in
[the performance notes](../docs/web-performance.md#deferred-ahead-of-time-loader-playback).
Screenshots and a standalone animated preview are written to `.shots/`.

The viewer fetches a ~448 KB catalog and the selected state's 48 KB of
tables, instead of downloading the full 16 MB asset. Superpositions fetch
only their required tables. Shared tables and concurrent requests are cached;
changing quantum numbers fetches any missing tables while retaining the last
presented image. No tables are resampled or approximated.

`lib/programs.ts` fetches and asynchronously compiles only the programs
needed by the selected technique, enabled flow, and enabled post effects.
Discrete integrator, shading, and derivative choices become shader constants
so unused branches disappear. The single-state variant also removes the
superposition branch. Compiled variants use a bounded LRU cache. Async linking
enables `KHR_parallel_shader_compile` before submitting shaders where
supported, following the
[WebGL extension contract](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/).

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
one provide supersampled antialiasing. The optional quality governor starts
large views conservatively and adjusts resolution toward a 60 FPS frame
budget. It uses actual frame intervals, including long stalls, rather than
the simulation's clamped time step.

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
capture scale, within GPU limits. All modes preserve aspect ratio while
limiting screen-space targets to 128 MiB and at most 8 megapixels. This protects
high-DPI displays from multi-gigabyte allocations at 8× SSAA. The actual
render/capture dimensions appear in the stats and PNG filename.

Resizing path tracing releases its previous accumulation buffers. Disabling
flow or post processing releases their targets; unmounting releases every
renderer-owned program, table texture, and framebuffer.

## Performance and regression checks

Run these against a production export served locally. GPU results depend on
the driver and selected scene; software-rendered Chromium is a separate case.

```sh
npm run build
npm run check:assets
# In another terminal: python3 -m http.server 3003 --directory out
npm run check:renderer
PERF_BASE=http://localhost:3003 PERF_GPU=1 npm run perf -- "scale=0.25"
```

The asset check compares every table and statistic to the original HORB bake,
and checks signed-m caching and concurrent-request deduplication. The browser
check covers all analytic techniques, superpositions, n=25, every flow method,
post processing, axes, clipping, repeated path-trace resize, and PNG capture.
`CHECK_REFERENCE=<original-export-URL>` additionally compares rendered pixels
against an unchanged build. `CHECK_SOFTWARE=1` selects SwiftShader.

The performance probe reports startup, compiled-program/context counts,
context loss, blocking shader queries, and median/p95 frame intervals over
ten seconds after warm-up. Its default backend is SwiftShader; `PERF_GPU=1`
requests hardware acceleration and reports the actual renderer used.

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
- `components/LoadingScreen.tsx` — initial HTML loading shell.
- `lib/params.ts` — typed user-facing state and URL codec.
- `lib/presets.ts` — curated preset catalog and application logic.
- `lib/panels.ts` — preset, superposition, palette, and help overlays.
- `lib/renderer.ts` — WebGL resources, shader assembly, flow state, and draw
  passes.
- `lib/programs.ts` — lazy asynchronous shader variants and bounded cache.
- `lib/superposition.ts` — term validation, coefficients, and time evolution.
- `lib/scene.ts`, `lib/cameras.ts` — plane geometry and navigation.
- `lib/horb.ts`, `lib/palettes.ts`, `lib/color.ts` — assets and perceptual
  color support.
- `lib/loading-orbital.ts`, `lib/loading-runtime.ts` — live physics-based loader
  and its generated inline runtime (`scripts/bake-loading-runtime.mjs`).
- `scripts/loading-bootstrap.js` — immediate first frame, worker handoff, and
  cleanup; `scripts/check-loading*.mjs` — startup and reference checks.
- `lib/loading-scene.ts`, `lib/loading-asset.ts` — the original standalone loading
  screen and its baked tables (`scripts/bake-loading.mjs`).
