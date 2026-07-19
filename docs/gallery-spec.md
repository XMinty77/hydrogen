# Gallery specification — offline still exports (M4)

Target: the checkbook items "offline still image exports … up to high energy
levels, exhaustive for every l and m; various crossections for 2D; various
angles for 3D", drafted at 1024² (2× supersampled), re-run at final
resolution after composition sign-off.

## Per-state image list

For each state |n, l, m⟩ (n ≤ 10):

### 2D cross-sections (slice renderer)

| # | Image | Plane | Rationale |
|---|-------|-------|-----------|
| 1 | real, ramp | **xz** through origin | The canonical textbook view: contains the z-axis, shows radial nodes and polar nodal cones simultaneously. |
| 2 | real, ramp | **xy** through origin — only when l−\|m\| is even | Equatorial view: the cos(mφ) petal structure. Skipped when parity puts a nodal plane exactly at the equator (the slice would be black). |
| 3 | real, **signed** (diverging) | xz | Lobe signs — the textbook ± phase structure, chroma-complement negatives. |
| 4 | complex, **phase** | m = 0: xz. m ≠ 0: **xy offset to the plane of maximum amplitude** (z\* = r\*·cosθ\*, computed per state from the baked tables) | The e^{imφ} pinwheel, guaranteed non-degenerate: the cut passes through the state's brightest torus regardless of nodal parity. |

### 3D volumetric (volume renderer)

Camera views (iteration 4, user 2026-07-19): **q34** (az 35°, el 25°, 2.6×),
**side** (az 0°, el 0° — perfectly horizontal, 2.6×), **side_tilt** (az 0°,
el 15°, 2.6×), **diag_side** (az 0°, el 60° — 30° down from the top, no
azimuthal rotation, 2.9×), **top** (az 35°, el 78°, 3.1×). Distances in
framing radii; diag_side's 2.9× was crop-checked on (10,9,0) and (10,4,0).

| # | Image | Integrator | View | Rationale |
|---|-------|-----------|------|-----------|
| 5–9 | real, ramp | MIP | all five | The signature glowing-cloud look. MIP is **ramp-only** (user, 2026-07-19): the max-density sample carries no depth context, so signed/phase hues at it read as arbitrary. |
| 10–14 | real, **signed** | **EA** | all five | Lobe signs in 3D as translucent glowing gas (moved off MIP, iteration 3). |
| 15 | real, ramp | **EA** | ¾ | The translucent glowing-gas render with depth/occlusion. |
| 16 | real, ramp | **EA + half-cut** (clip plane removes y > 0) | ¾ | The checkbook's "3D crossection": interior structure through a cutaway, volumetrically. |
| 17 | real, signed | EA + half-cut | ¾ | Signed cutaway. |
| 18 | complex, phase | **EA** | ¾ | The phase torus/cloud as glowing gas. At the tuned low density the front/back phase-cancellation desaturation that once made MIP the complex default is minor (verified on (5,3,3), 2026-07-19). |

### Not included per-state (deliberate)

- **Amplitude-mode variants** (|ψ| instead of |ψ|²): a display-mapping toggle,
  not a distinct visual — available via CLI/web, redundant ×2 in the gallery.
- **Diagonal/rotated cut planes**: infinite family; the web demo makes them
  interactive. A few hand-picked ones can join a curated "showcase" set later.
- **Complex MIP**: MIP is ramp-only since iteration 3; the phase-at-max
  variant remains available in the CLI and web demo for exploration.

## m coverage — decision needed

"Exhaustive for every l and m" taken literally means m ∈ {−l … +l} (385
states). But the −m images are exact transforms of the +m ones:

- complex: ψ_{n,l,−m} = conj(ψ) up to sign → identical magnitudes, hue-mirrored
  phase (a color inversion of image #10, #4);
- real: the sin(mφ) harmonic is the cos(mφ) one rotated by π/(2m) about z →
  #1/#3 (xz) differ only trivially, #2/#4 are in-plane rotations.

**Decision (user, 2026-07-18): Option A** — m ∈ {0 … l}: 220 states,
18 images each (17 when the xy slice is parity-skipped; counts as of
iteration 4), 3,865 images. The −m transforms are documented in the
gallery index.

## Mechanics

- **Batch mode**: a `gallery` CLI command loops in-process (one GL context,
  cached tables) — per-image process startup would dominate otherwise.
- **Supersampling**: rendered at 2× target, Lanczos-downsampled (in-host).
- **Layout**: `gallery/stills/n{n}/l{l}/m{m}/<image-name>.png`.
- **Contact sheets**: one static HTML index per n (thumbnail grid linking to
  full images) so the whole gallery is browsable at a glance.
- **Determinism**: fixed normalization from baked stats + deterministic dither
  → re-runs are byte-identical; the draft→final rerun changes resolution only.
- **Draft pass**: 1024² (user-approved), then composition review, then the
  final-resolution run (resolution decided after the draft looks right).

## Iteration 4 (user, 2026-07-19 — views + technique prototypes)

- **Five camera views** (was three): side is now perfectly horizontal
  (el 0°), a slightly-tilted secondary side view (el 15°) and a diagonal
  side view (el 60° — 30° down from the top, no azimuthal rotation, 2.9×
  distance) join the set. 18 images per state (17 with the parity skip),
  3,865 total.
- **Technique prototypes shipped as opt-ins, not gallery changes** (pending
  user judgment through the web demo): `--tonemap agx` (AgX filmic display
  transform for the volumetric integrators; the plain gamma/clamp stays the
  default), `--integrator scatter` (EA plus a self-shadowed directional key
  light — `--light AZ,EL`, `--light-gain`, `--shadow-steps`,
  `--shadow-density`; the plain EA integrator is untouched, per the user's
  explicit request), and `--exposure` (EV shift ahead of either tonemap).
  Shadow extinction is decoupled from the viewing density: at density 5 the
  medium is optically thin, so shadow rays use their own much larger scale
  (default 120) — without it self-shadowing tops out at ~10%.

## Iteration 3 (user, 2026-07-19 — second web-demo round)

- **Defaults everywhere: emission gain 6.7, display gamma 0.71** — for every
  image type, replacing iteration 2's EA-only 0.67 / MIP-and-slice 0.45
  split. Web ≤0.5 LSB parity re-verified at the new gamma.
- **MIP is ramp-only**: the signed-MIP trio and the complex-MIP image are
  dropped; signed now gets EA at all three angles and the complex phase
  image is EA. Per-state set: 14 images (13 with the parity skip).
- **2D slice aspect bug fixed**: the web demo's fullscreen (non-square)
  canvas stretched slices horizontally — the U axis now carries the
  width/height factor, so pixels are square and the vertical extent stays
  the framing (the volume renderer's vertical-FOV convention). The CLI
  applies the same convention for non-square `--size`.

## Iteration 2 (user, 2026-07-19 — via the web demo)

- **EA transfer function retuned interactively**: density 5, opacity exponent
  2.15, emission gain 5, display gamma 0.67 (EA images only; MIP and slices
  keep 0.45). These are now the `VolumeParams` defaults; the old values
  (300 / 2.2 / 1.6 / 0.45) are in git history. The web demo's density slider
  is capped at 50 — beyond that everything reads as fog.
- **Signed palette**: negative lobes switched from the chroma complement to a
  hue reflection about the 125° OKLab axis (red→blue, gold→green, shared
  dark base). Isolated in its own commit for easy revert.

## Post-draft decisions (user, 2026-07-18)

- **Final resolution pinned at 4096²** unless a desire for higher quality
  arises. Drafts and iteration continue at 1024² (the 2.1-minute full-gallery
  turnaround makes re-renders effectively free).
- **Rendering-technique iteration deferred until after the web demo (M5)**:
  judging the drafts from fixed angles proved hard — the interactive demo
  gives every render type arbitrary viewpoints, so concrete per-technique
  feedback will be formulated there. The final-resolution run waits for that
  feedback loop to converge.
