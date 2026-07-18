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
| `web/`     | TypeScript      | Interactive demo (Next.js static export): 2D arbitrary cross-sections, 3D volumetric rendering with camera-locked clip planes, FPS explorer. |

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
- [ ] M1: physics core + validation + baked asset
- [ ] M2: 2D slice renderer + palettes
- [ ] M3: 3D raymarcher
- [ ] M4: batch exports (stills, animations)
- [ ] M5: web demo
