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
- **3D volume** — MIP or emission–absorption; steps/density/opacity/emission;
  two clip planes (axis: view forward/right/up + offset + flip), world-fixed
  at the starting camera's axes by default, each optionally locked to the
  live camera ("lock to camera"). Orbit camera (drag + wheel) or FPS fly
  camera (click to capture the mouse, WASD + E/Q, Shift = fast, Esc
  releases).

## URL parameters

Every control is scriptable — the vocabulary mirrors the offline CLI
(`export/Program.cs`), e.g.

```
?view=volume&state=4,2,1&mode=complex&camera=35,25,2.6&integrator=mip&steps=600
?view=slice&state=5,3,2&plane=custom&az=45&el=30&roll=15&zoom=1.6
```

`size=N` fixes the canvas at N×N pixels and renders a single frame — the
deterministic screenshot mode used by the harness:

```sh
npm run shot -- "view=slice&state=4,2,1&size=1024" .shots/slice.png
# SHOT_BASE overrides the server URL; SHOT_GPU=1 uses the real GPU via EGL.
```
