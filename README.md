# hydrogen2 — hydrogen wavefunction visualizer

High-fidelity visualizations of the bound-state wavefunctions of atomic hydrogen,

    ψ_nlm(r, θ, φ) = R_nl(r) · Y_lm(θ, φ),

the standard analytic solution of the time-independent Schrödinger equation
(fixed proton, atomic units a₀ = 1). Successor to the `../hydrogen` prototype,
rebuilt around a single shared GPU renderer.

## Architecture

One renderer, three delivery modes:

| Directory  | Language        | Role                                                              |
|------------|-----------------|-------------------------------------------------------------------|
| `lab/`     | Julia           | The single physics implementation (FP64/BigFloat). Bakes 1D tables of R_nl and normalized P_lm into a compact binary asset; hosts the numerical-validation harness and palette design. |
| `shaders/` | GLSL ES 3.00    | The single renderer codebase. Runs unmodified on desktop GL (via `GL_ARB_ES3_compatibility`) and WebGL2. |
| `export/`  | C# (Silk.NET)   | Offline exports: high-resolution stills and ffmpeg animations, rendered offscreen on the workstation GPU. |
| `web/`     | TypeScript      | Interactive demo (Next.js static export): 2D arbitrary cross-sections; 3D rendering via MIP, emission–absorption, ambient multi-scattering, MIDA, emissive isosurfaces, volumetric path tracing, and eikonal refraction; clip planes, FPS explorer. |

**Why 1D tables instead of 3D volumes:** ψ is separable, so the renderer
reconstructs it exactly from two 1D texture fetches and a `sincos` —
R_nl(r) · P̄_lm(cosθ) · azimuthal(mφ). Tables are baked in extended precision
and stored as Float32, confining all numerically delicate work (high-n
recurrences, factorial normalizations) to bake time. The shaders never do
anything FP32 can't do accurately, the field has no grid resolution limit, and
the web demo's assets stay in the low megabytes.

## Toolchain

Not on PATH by default on this machine:

- Julia 1.12 — `~/.juliaup/bin/julia`
- .NET SDK 10 — `~/.dotnet/dotnet`
- Node 26 — `~/.conda/envs/hydrogen/bin/node`

## Status

- [x] Toolchain + scaffold + GL smoke test (ES 3.00 shaders confirmed on desktop GL, offscreen PNG readback works)
- [x] M1: physics core + validation + baked asset (614 tests; worst FP32 pipeline error 4.25e-6 of state peak)
- [x] M2: 2D slice renderer + palettes (GPU vs CPU reference ≤ 0.56 LSB; OKLCH ramp + vivid phase wheel, user sign-off)
- [x] M3: 3D raymarcher (MIP + emission–absorption, exact clip planes)
- [x] M4: batch still exports — draft 1024² gallery, 3,205 images / 220 states in 2.1 min (`gallery/stills/index.html`); final resolution pinned at 4096²
- [x] M5: web demo (`web/`, see its README; verified vs CPU reference ≤ 1 LSB)
- [ ] Rendering-technique iteration with user feedback through the web demo (lit isosurfaces, shadowed EA, filmic tonemap, bloom …)
- [ ] Final-resolution (4096²) gallery run after technique sign-off
- [ ] Animations (2D moving cross-sections, 3D orbiting camera; deferred until after web-demo feedback)
