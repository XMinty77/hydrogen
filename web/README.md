# web/ — interactive demo (M5)

Next.js (static export) + WebGL2 host for the shared GLSL renderer in
`../shaders/`. No physics or color code lives here: the app fetches the same
baked asset (`../assets/orbitals.bin`), palettes, and shader sources the C#
export host uses, assembled under the identical
`prelude.glsl + common.glsl + <view>.frag` contract. Verified against the
lab's FP64→FP32 CPU reference at ≤ 1 LSB (8-bit).

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

## Controls

- **State / display / palette** — lil-gui panel (top right). n ≤ 10, all l, m
  (negative m included); real/complex; ramp / signed / phase coloring;
  density/amplitude; gamma; palette selection.
- **2D slice** — presets xz, xy, yz or a fully custom plane (azimuth,
  elevation, roll, offset along the normal). Drag rotates the plane, wheel
  zooms.
- **3D volume** — seven techniques under the `technique` selector, every
  parameter exposed for experimentation (iteration 5):
  - **mip** — maximum-intensity projection (phase-at-max hue in complex mode).
  - **ea** — emission–absorption, the certified default look.
  - **scatter** — anisotropic ambient multi-scattering: EA + a key light with
    Wrenninge-style multi-scatter octaves (soft self-shadowing that glows
    through), a Henyey–Greenstein phase factor (forward halos, silver
    linings), and a Fibonacci-direction ambient-occlusion field.
  - **mida** — maximum intensity difference accumulation (Bruckner & Gröller),
    with the γ slider blending EA ↔ MIDA ↔ MIP; pairs with the compressed
    normalization toggle (display folder: off/log/asinh + strength).
  - **iso** — emissive nested isosurfaces (bisection-refined, level sweep =
    "3D slides" through the wavefunction), rim glow, optional lit shading.
  - **pathtrace** — progressive volumetric path tracing (delta tracking,
    multiple scattering with palette-tinted albedo, NEE key light, procedural
    environments, thin-lens depth of field); accumulates while the view is
    still, `?spp=N` sets shot-mode convergence.
  - **eikonal** — refraction rendering: ψ mapped to a gradient-index medium
    (power/log compressive map), rays bent by the eikonal equation, spherical
    environment illumination (studio/hue-sphere/checker/…), optional
    chromatic dispersion and internal palette glow.
  - Surface-shading folder (ea/scatter/iso): Lambert, Blinn–Phong, or
    GGX/Fresnel response on the key light, gated by gradient confidence so
    only shell-like regions light up (no volume "fur").
  - Shared: steps/density/opacity/emission; display transform: plain gamma
    ("gamma", default) or AgX filmic ("agx") + EV exposure; two clip planes
    (axis: view forward/right/up + offset + flip), world-fixed at the
    starting camera's axes by default, each optionally locked to the live
    camera. Orbit camera (drag + wheel) or FPS fly camera (click to capture
    the mouse, WASD + E/Q, Shift = fast, Esc releases).

## URL parameters

Every control is scriptable — the vocabulary mirrors the offline CLI
(`export/Program.cs`), e.g.

```
?view=volume&state=4,2,1&mode=complex&camera=35,25,2.6&integrator=mip&steps=600
?view=slice&state=5,3,2&plane=custom&az=45&el=30&roll=15&zoom=1.6
?view=volume&state=10,4,0&integrator=scatter&tonemap=agx&lightAz=-30&lightEl=50
```

The address bar also **mirrors the live view**: as you explore, the query
string updates in place (only values that differ from the defaults), so the
current picture is always copyable as a link. Volume extras: `integrator=
mip|ea|scatter`, `tonemap=gamma|agx`, `exposure` (EV), and for scatter
`lightAz`/`lightEl` (degrees), `lightGain`, `shadowSteps`, `shadowDensity`.

`size=N` fixes the canvas at N×N pixels and renders a single frame — the
deterministic screenshot mode used by the harness:

```sh
npm run shot -- "view=slice&state=4,2,1&size=1024" .shots/slice.png
# SHOT_BASE overrides the server URL; SHOT_GPU=1 uses the real GPU via EGL.
```
