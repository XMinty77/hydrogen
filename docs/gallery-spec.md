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

| # | Image | Integrator | View | Rationale |
|---|-------|-----------|------|-----------|
| 5–7 | real, ramp | MIP | ¾ (az 35°, el 25°), side (az 0°, el 8°), top (az 35°, el 78°) | The signature glowing-cloud look, three angles. |
| 8–10 | real, **signed** | MIP | same three angles | Lobe signs in 3D (user tweak 2026-07-18: signed versions of all real 3D renders). |
| 11 | real, ramp | **EA** | ¾ | The translucent glowing-gas render with depth/occlusion. |
| 12 | real, signed | EA | ¾ | Signed glowing-gas. |
| 13 | real, ramp | **EA + half-cut** (clip plane removes y > 0) | ¾ | The checkbook's "3D crossection": interior structure through a cutaway, volumetrically. |
| 14 | real, signed | EA + half-cut | ¾ | Signed cutaway. |
| 15 | complex, phase | MIP (phase-at-max) | ¾ | The phase torus/cloud. (EA is not used for complex: front/back phase cancellation desaturates it — documented in volume.frag.) |

### Not included per-state (deliberate)

- **Amplitude-mode variants** (|ψ| instead of |ψ|²): a display-mapping toggle,
  not a distinct visual — available via CLI/web, redundant ×2 in the gallery.
- **Diagonal/rotated cut planes**: infinite family; the web demo makes them
  interactive. A few hand-picked ones can join a curated "showcase" set later.
- **Complex EA**: see #10.

## m coverage — decision needed

"Exhaustive for every l and m" taken literally means m ∈ {−l … +l} (385
states). But the −m images are exact transforms of the +m ones:

- complex: ψ_{n,l,−m} = conj(ψ) up to sign → identical magnitudes, hue-mirrored
  phase (a color inversion of image #10, #4);
- real: the sin(mφ) harmonic is the cos(mφ) one rotated by π/(2m) about z →
  #1/#3 (xz) differ only trivially, #2/#4 are in-plane rotations.

**Decision (user, 2026-07-18): Option A** — m ∈ {0 … l}: 220 states,
15 images each (14 when the xy slice is parity-skipped), ~3,150 images.
The −m transforms are documented in the gallery index.

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

## Post-draft decisions (user, 2026-07-18)

- **Final resolution pinned at 4096²** unless a desire for higher quality
  arises. Drafts and iteration continue at 1024² (the 2.1-minute full-gallery
  turnaround makes re-renders effectively free).
- **Rendering-technique iteration deferred until after the web demo (M5)**:
  judging the drafts from fixed angles proved hard — the interactive demo
  gives every render type arbitrary viewpoints, so concrete per-technique
  feedback will be formulated there. The final-resolution run waits for that
  feedback loop to converge.
