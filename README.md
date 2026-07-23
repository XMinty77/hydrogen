# hydrogen2 — hydrogen wavefunction visualizer

High-fidelity visualizations of the bound-state wavefunctions of atomic
hydrogen,

    ψ_nlm(r, θ, φ) = R_nl(r) · Y_lm(θ, φ),

including superpositions `ψ = Σₖ cₖ ψₖ`, real-time phase evolution
`e^(−iEₙt)`, and every bound state through `n = 25`. The model uses atomic
units and a fixed proton.

**Live demo:** https://xminty77.github.io/hydrogen

## Architecture

The project has one baked physics asset and one GLSL renderer shared by the
interactive and offline hosts.

| Directory | Language | Responsibility |
|---|---|---|
| `lab/` | Julia | FP64/BigFloat wavefunction implementation, numerical validation, palette design, and the orbital-table baker. |
| `shaders/` | GLSL ES 3.00 | Shared slice, volume, path-tracing, refraction, and probability-flow rendering. The sources run in WebGL2 and desktop GL with `GL_ARB_ES3_compatibility`. |
| `export/` | C# / Silk.NET | Offscreen high-resolution stills, gallery batches, and rendering from compatible web URLs. |
| `web/` | TypeScript / Next.js | WebGL2 interaction shell, parameter panels, curated presets, URL state, and image capture. See [`web/README.md`](web/README.md). |

Rather than sampling ψ into a 3-D texture, the renderer reconstructs the
separable field from one-dimensional radial and angular tables:

    R_nl(r) · P̄_lm(cos θ) · azimuthal(mφ)

The numerically delicate recurrences and normalizations run during the Julia
bake. The resulting Float32 tables preserve continuous spatial evaluation in
the shaders without a 3-D grid-resolution limit. Superposition terms occupy
rows of table textures; the CPU folds each term's coefficient, phase, and
time factor together before upload.

## Rendering

The analytic density renderer includes:

- 2-D planar slices in real, signed, phase, and palette-relative phase color.
- MIP, emission–absorption, anisotropic multi-scattering, MIDA, and nested
  bisection-refined isosurfaces.
- Optional Lambert, Blinn–Phong, or GGX surface response gated by density
  gradient confidence.
- Progressive volumetric path tracing with multiple scattering, a direct
  light, environments, and thin-lens depth of field.
- Eikonal integration through a density-derived gradient-index medium.
- Two exact clip planes, orbit and fly cameras, orientation axes, editable
  perceptual palettes, dynamic-range compression, supersampled output, and an
  optional display-referred bloom/color/lens/grain finishing stage.

The web host also visualizes genuine spinless probability current. It
evaluates

    j = Im(conj(ψ) ∇ψ),       vε = j / (ρ + ε)

directly from the analytic complex field. The node regularizer `ε` controls
velocity near vanishing density; it does not replace or decorate the current.
Five active treatments share this transport field:

- `ink`: a persistent semi-Lagrangian dye texture on the selected slice.
- `motes`, `trails`, and `accretion`: GPU particles with increasingly
  persistent HDR pathline treatments.
- `granular`: a persistent 3-D passive-material atlas rendered as a sparse,
  expectation-preserving stochastic nebula.

Flow seeding, derivative order, integration, time scale, node regularization,
material dynamics, color meaning, transfer functions, and compositing remain
independently adjustable. Volume and particle visibility honor clip planes;
the analytic orbital density remains the spatial support and context.

## Toolchain

The local tool installations used during development are not necessarily on
`PATH`:

- Julia 1.12 — `~/.juliaup/bin/julia`
- .NET SDK 10 — `~/.dotnet/dotnet`
- Node 26 — `~/.conda/envs/hydrogen/bin/node`

Bake or refresh `assets/orbitals.bin` with:

```sh
~/.juliaup/bin/julia --project=lab -t auto lab/scripts/bake.jl 25
```

Run the interactive host with:

```sh
cd web
npm install
npm run dev -- -p 3001
```

The build synchronizes the asset, palette, and shader sources into the web
host automatically:

```sh
cd web
npm run build
```

## Validation and exports

The Julia suite covers the analytic wavefunction, table interpolation, and
Float32 pipeline. Its recorded worst normalized error is `4.25e-6`; rendered
web/CPU and web/offline comparisons are within one 8-bit LSB. The gallery
batch is deterministic and uses 2× supersampling followed by Lanczos
downsampling. See [`docs/gallery-spec.md`](docs/gallery-spec.md) for its
current image set and camera conventions.
