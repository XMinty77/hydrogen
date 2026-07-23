# Offline gallery specification

The gallery command renders the bound states `|n,l,m⟩` through `n = 10` at a
1024² working resolution and supports a final 4096² pass. Each output is
rendered at twice its target dimensions and Lanczos-downsampled in the host.

## State coverage

The batch covers `m ∈ {0 … l}`, giving 220 states. Negative-m states are
omitted because their images are exact transforms of the positive-m set:

- `ψ_(n,l,−m)` is the complex conjugate of `ψ_(n,l,m)` up to sign, so
  magnitudes match and phase hue mirrors.
- The negative-m real harmonic is a z-axis rotation of the positive-m real
  harmonic.

The generated index records these relationships. This keeps the gallery
exhaustive in distinct spatial structure without duplicating transformed
frames.

## Per-state image set

The command produces 23 images per state, or 22 when the equatorial real slice
is a nodal plane.

### Slices

| Image | Geometry | Purpose |
|---|---|---|
| `2d_real_xz` | xz plane through the origin | Canonical textbook view containing radial nodes and polar nodal cones. |
| `2d_real_xy` | xy plane through the origin, when `l−|m|` is even | Equatorial petal structure; skipped when parity makes the plane identically zero. |
| `2d_signed_xz` | xz plane through the origin | Real-wavefunction sign structure. |
| `2d_complex_phase` | xz for `m = 0`; otherwise an xy plane offset to maximum amplitude | Non-degenerate complex-phase pinwheel through the state's brightest angular band. |

The offset complex slice uses the maxima recorded in the baked radial and
angular tables, so it remains informative regardless of equatorial parity.

### Canonical cameras

Distances are in orbital framing radii.

| Name | Azimuth | Elevation | Distance | Use |
|---|---:|---:|---:|---|
| `q34` | 35° | 25° | 2.6 | Primary three-quarter comparison view. |
| `side` | 0° | 0° | 2.6 | Horizontal profile. |
| `side_tilt` | 0° | 15° | 2.6 | Slightly elevated profile. |
| `diag_side` | 0° | 60° | 2.9 | Diagonal side/top structure without azimuthal rotation. |
| `top` | 35° | 78° | 3.1 | Near-axis structure with extra room for the equatorial footprint. |

The larger diagonal and top distances avoid cropping the high-l `n = 10`
states.

### Core volumes

| Images | Integrator and color | Purpose |
|---|---|---|
| `3d_mip_real_<camera>` | MIP, real ramp, all five cameras | Signature projected-density silhouette. MIP stays ramp-only because the maximum sample has no useful depth context for sign or phase. |
| `3d_ea_signed_<camera>` | Emission–absorption, signed ramp, all five cameras | Three-dimensional lobe sign with depth and occlusion. |
| `3d_ea_real_q34` | Emission–absorption, real ramp | Canonical translucent density volume. |
| `3d_ea_real_cut` | Emission–absorption, real ramp, keep `y ≤ 0` | Volumetric cross-section exposing interior nodes. |
| `3d_ea_signed_cut` | Emission–absorption, signed ramp, keep `y ≤ 0` | Signed interior cross-section. |
| `3d_ea_complex_q34` | Emission–absorption, complex phase | Complex phase with depth ordering. |

### Technique comparisons

Five additional `q34` frames compare the wider renderer without multiplying
every camera angle:

- `3d_mida_signed_q34`
- `3d_scatter_signed_q34`
- `3d_iso_signed_q34`
- `3d_eik_real_q34`
- `3d_pt_phase_q34`

MIDA, multi-scattering, lit isosurfaces, eikonal refraction, and path tracing
share the state, framing, and primary camera for direct visual comparison.

Amplitude display, arbitrary rotated cuts, and alternate technique parameters
remain available through the CLI and web app but are not multiplied into the
per-state batch.

## Output mechanics

- One process and one GL context render the full batch; orbital tables remain
  cached between frames.
- PNG encoding runs on a bounded worker queue while the GPU advances.
- Output paths use
  `gallery/stills/n{n}/l{l}/m{m}/<image-name>.png`.
- Static contact sheets provide one thumbnail index per `n` plus a master
  index.
- Fixed baked normalization and deterministic dither make equal-parameter
  reruns byte-identical.
- `--only N,L,M` restricts the command to one state for validation.
- The default path-tracing comparison uses 48 samples per pixel; `--spp`
  overrides it.
