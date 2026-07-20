# hydrogen2 — hydrogen wavefunction visualizer

High-fidelity visualizations of the bound-state wavefunctions of atomic hydrogen,

    ψ_nlm(r, θ, φ) = R_nl(r) · Y_lm(θ, φ),

the standard analytic solution of the time-independent Schrödinger equation
(fixed proton, atomic units a₀ = 1) — including **superpositions**
ψ = Σₖ cₖ ψₖ with real-time evolution e^{−iEₙt}, up to n = 25.

**Live demo:** https://xminty77.github.io/hydrogen

## Architecture

One renderer, three delivery modes:

| Directory  | Language        | Role                                                              |
|------------|-----------------|-------------------------------------------------------------------|
| `lab/`     | Julia           | The single physics implementation (FP64/BigFloat). Bakes 1D tables of R_nl and normalized P_lm into a compact binary asset; hosts the numerical-validation harness and palette design. |
| `shaders/` | GLSL ES 3.00    | The single renderer codebase. Runs unmodified on desktop GL (via `GL_ARB_ES3_compatibility`) and WebGL2. |
| `export/`  | C# (Silk.NET)   | Offline exports: high-resolution stills and the gallery batch, rendered offscreen on the workstation GPU. Understands web-demo URLs (`dotnet run -- url "<link>"`). |
| `web/`     | TypeScript      | Interactive demo (Next.js static export) — see `web/README.md`. |

**Why 1D tables instead of 3D volumes:** ψ is separable, so the renderer
reconstructs it exactly from two 1D texture fetches and a `sincos` —
R_nl(r) · P̄_lm(cosθ) · azimuthal(mφ). Tables are baked in extended precision
and stored as Float32, confining all numerically delicate work (high-n
recurrences, factorial normalizations) to bake time. The shaders never do
anything FP32 can't do accurately, the field has no grid resolution limit, and
the web demo's assets stay small (n ≤ 25 ⇒ 16 MiB). Superpositions pack each
term's tables into one row of a 2D texture; the time factor e^{−iEₙt} is
folded into the per-term complex coefficients on the CPU, so time evolution
costs the shaders nothing.

## Rendering techniques

Seven volumetric techniques share one integration/shading library
(`shaders/common.glsl`): MIP, emission–absorption (the certified default),
anisotropic ambient multi-scattering, MIDA, emissive isosurfaces (optionally
lit — Lambert/Blinn–Phong/GGX gated by gradient confidence), progressive
volumetric path tracing, and eikonal refraction. Every parameter is exposed in
the web UI and the CLI; the two hosts share the URL/option vocabulary and are
verified pixel-comparable (≤ 1 LSB).

## Toolchain

Not on PATH by default on this machine:

- Julia 1.12 — `~/.juliaup/bin/julia`
- .NET SDK 10 — `~/.dotnet/dotnet`
- Node 26 — `~/.conda/envs/hydrogen/bin/node`

Bake the asset (writes `assets/orbitals.bin`):

```sh
~/.juliaup/bin/julia --project=lab -t auto lab/scripts/bake.jl 25
```

## Status

- [x] Toolchain + scaffold + GL smoke test (ES 3.00 shaders confirmed on desktop GL, offscreen PNG readback works)
- [x] M1: physics core + validation + baked asset (614 tests; worst FP32 pipeline error 4.25e-6 of state peak)
- [x] M2: 2D slice renderer + palettes (GPU vs CPU reference ≤ 0.56 LSB; OKLCH ramp + vivid phase wheel, user sign-off)
- [x] M3: 3D raymarcher (MIP + emission–absorption, exact clip planes)
- [x] M4: batch still exports (`gallery/stills/index.html`); final resolution pinned at 4096²
- [x] M5: web demo (`web/`; verified vs CPU reference ≤ 1 LSB)
- [x] Iteration 5: rendering-technique prototypes (multi-scatter, MIDA, isosurfaces, local illumination, path tracing, eikonal refraction)
- [x] Iteration 6: superposition + time evolution, n ≤ 25 asset, palette editor, UI overhaul (custom panels, keybinds, capture, auto quality), C# parity incl. URL parsing, refreshed n ≤ 10 gallery with the new modes
- [ ] Per-technique user feedback → final looks; then the 4096² gallery run
- [ ] Animations (2D moving cross-sections, 3D orbiting camera, superposition beats)
