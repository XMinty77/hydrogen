# web/ — interactive demo

Next.js (static export) + WebGL2 host for the shared GLSL renderer in
`../shaders/`. No physics or color code lives here: the app fetches the same
baked asset (`../assets/orbitals.bin`, n ≤ 25), palettes, and shader sources
the C# export host uses, assembled under the identical
`prelude.glsl + common.glsl + <view>.frag` contract. Verified against the
lab's FP64→FP32 CPU reference at ≤ 1 LSB (8-bit), and against the C# host at
≤ 1 LSB for URL round-trips.

## Running

```sh
export PATH="$HOME/.conda/envs/hydrogen/bin:$PATH"   # node 26 (this machine)
npm install
npm run dev      # http://localhost:3000 (predev syncs assets/shaders)
npm run build    # static site in out/ — host anywhere, no server runtime
```

`scripts/sync-assets.mjs` (auto-run before dev/build) mirrors the repo's
assets and shaders into `public/generated/` — re-bake or edit a shader and
reload, nothing else to do.

## The UI

lil-gui panel (top right), grouped as: **state** (n ≤ 25, all l, m;
real/complex basis) · **time evolution** · **display** (color/value/gamma/
compression + **white point**/tonemap/exposure) · **palette** · **quality** ·
**slice plane** or **volume** (technique + per-technique subfolders) ·
**camera** · **clip planes** · **capture**. Two custom panels open from it:

The **color** modes are `ramp` (brightness → palette), `signed` (real mode:
hue-reflected negative lobes), `phase` (complex mode: constant-lightness OKLCH
hue wheel) and `okphase` — the palette's *own* color hue-rotated in OKLCH by
arg ψ, so complex orbitals inherit the accretion look while hue still encodes
phase. Its **okphase: signed hue** toggle additionally reflects the negative-real
half across the signed mode's 250° OKLab axis, so ψ and −ψ read as complementary
palette colors (gold ↔ magenta) instead of a bare 180° spin through arbitrary
hues. The **white point ×q999** slider (paired with the log/asinh compression)
pulls the saturated lobe cores — whose |ψ|² overshoots the q999 normalization
many-fold and would otherwise clamp to one flat color — back into the ramp so
their interior gradient shows.

- **Superposition editor** (`state ▸ superposition editor…`): build
  ψ = Σ cₖ |n,l,m⟩ from up to 8 terms — per-term n/l/m, amplitude, phase —
  with normalization, presets (sp/sp³ hybrids, the 1s–2p radiating-dipole
  beat, shell breathing, a circular Rydberg wave packet), and a live hint
  showing the slowest beat period. Works in either harmonic basis and in
  every view, slices included.
- **Palette editor** (`palette ▸ palette editor…`): draggable gradient stops
  (click the bar to add one), true OKLab/sRGB-interpolated preview, and a
  per-stop **OKLCH picker** (lightness / chroma / hue sliders alongside the
  sRGB swatch — editing in the same perceptual space the ramp interpolates
  through keeps a hand-tuned palette smooth). "Start from" any built-in ramp,
  phase-wheel sliders (L/C/hue-zero), copy-URL and copy-JSON export. Edits
  select the `custom` ramp and persist in the URL.

**Time evolution** multiplies each term by e^{−iEₙt} (atomic units; the log
slider spans the 4 decades between 1s–2p beats and Rydberg orbit periods).
Superpositions of different n genuinely move; single states spin their phase
hue. Space = play/pause, R = rewind, and a paused moment's `t` lands in the
URL so the exact frame is shareable.

**Volume techniques** (`volume ▸ technique`, every parameter exposed):
`mip` · `ea` (the certified default) · `scatter` (Wrenninge multi-scatter
octaves + Henyey–Greenstein key light + Fibonacci ambient occlusion) ·
`mida` (Bruckner & Gröller, γ blends EA↔MIDA↔MIP; pairs with the display
folder's log/asinh compression) · `iso` (nested bisection-refined emissive
shells, level sweep = "3D slides"; **palette-mapped shading** walks the ramp
with the surface illumination — unlit faces sit at the shell's cool base
color, the key light lifts lit faces toward the hot end — so one shell shows
the full accretion gradient with 3-D form) · `isolegacy` (the same shells with
the original pre-palette-mapped shading — self-glow at the shell brightness plus
a white specular highlight; desaturates under strong light but keeps a glassier,
more saturated look on phase/okphase states, kept for completeness) · `pathtrace`
(progressive
delta-tracking Monte Carlo with palette-tinted multiple scattering, NEE key
light, environments, thin-lens DoF; accumulates while the view is still).
`eikonal` (ψ as a gradient-index medium, curved rays, spherical environments,
dispersion) is kept in the implementation but hidden from the menu — reach it
with `?integrator=eikonal`. The **surface shading** subfolder
(ea/scatter/iso) adds Lambert/Blinn–Phong/GGX responses gated by gradient
confidence so only shell-like regions light up.

**Cameras**: orbit (drag + wheel) or fly (click to capture the mouse,
WASD + E/Q, Shift = fast). Inside fly mode, **C** toggles the center-locked
variant: the view stays on the nucleus while A/D + E/Q slide you around the
current sphere and W/S change its radius. Azimuths wrap, elevations clamp —
no angle ever runs away. Dolly distance now reaches down to 0.15 framing radii
(right into the core). The camera folder's **orientation axes** toggle blends
analytic 3-D axes (X red, Y green, Z blue) over the frame — a rotation aid
that tracks the live camera. Its **compact gizmo** sub-toggle shortens the arms
to a small cluster around the origin/crosshair (a Minecraft-F3-style indicator)
instead of full arms spanning the domain.

**Keyboard** (press **H** or **?** in the app): Space/R time, C center lock,
P save PNG (canvas only, no UI), U copy view URL, G hide the panels, H help.
**Esc** returns focus to the canvas from any GUI field so the global keys work
again immediately (and, in fly mode, releases the pointer lock as usual).

**Quality**: `renderScale` spans 0.05×–4×. Below 1 it renders under display
resolution (fast, weak GPUs); above 1 it oversamples and lets the browser
downscale — true supersampled anti-aliasing, the way to get crisp isosurface
silhouettes (2× ≈ 4 samples/pixel). An auto governor drops resolution when
frames stall and restores it with headroom (off-switch included; never touches
the path tracer's accumulation). Isosurface normals are taken from the raw
|ψ|² field (not the tone-mapped brightness) and the shell march is jittered
per pixel, so shading stays smooth and the marching grid never bands.

## URL parameters

Every control is scriptable and the address bar **mirrors the live view** —
only values differing from the defaults are written, so the current picture is
always copyable as a link, e.g.

```
?view=volume&state=4,2,1&mode=complex&camera=35,25,2.6&integrator=iso&shadeModel=ggx
?view=volume&state=4,2,1&integrator=isolegacy&color=okphase   # legacy shell shading
?state=4,2,1&color=okphase&okSigned=1&axes=1&axesGizmo=1&integrator=ea
?state=1,0,0&view=slice&compress=log&compressWhite=10   # reveal the 1s core gradient
?terms=1,0,0;2,1,0&mode=real&color=ramp&time=1&timeScale=4
?ramp=custom&rampStops=05030f@0,3b1c58@0.35,e0562e@0.65,ffc94e@0.85,fff7e0@1
```

The offline host consumes the same vocabulary:
`dotnet run --project ../export -- url "<link>"` reproduces the browser's
frame pixel-comparably.

`size=N` fixes the canvas at N×N pixels and renders a single frame — the
deterministic screenshot mode used by the harness; `spp=N` sets the path
tracer's shot-mode convergence and `t=N` the simulated time:

```sh
npm run shot -- "view=slice&state=4,2,1&size=1024" .shots/slice.png
# SHOT_BASE overrides the server URL; SHOT_GPU=1 uses the real GPU via EGL.
```

## Code layout

`components/OrbitalViewer.tsx` orchestrates; each concern lives in its own
module under `lib/`: `params.ts` (parameter model + URL codec),
`superposition.ts` (terms, presets, time evolution), `panels.ts` (custom
overlay panels), `scene.ts` (slice/clip geometry), `cameras.ts`,
`renderer.ts` (WebGL2 host, the C# host's twin), `horb.ts` / `palettes.ts`
(asset readers), `color.ts` (OKLab).
