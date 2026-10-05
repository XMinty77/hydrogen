# Web performance investigation

## Startup cleanup baseline

These results describe the startup cleanup before the animated loader below.

Measured locally in production Chromium/ANGLE on Intel UHD Graphics 770,
1600×900 CSS pixels, DPR 1, render scale 0.25. These measurements do not
establish performance on the reported A5000 workstation or Chromebook.

| Default view | Original build | Revised build |
|---|---:|---:|
| WebGL contexts | 2 | 1 |
| Programs compiled at startup | 22 | 1 |
| First app frame | ~16.2 s | ~0.4 s |
| Initial orbital data | 16.7 MB | ~0.51 MB |
| Steady frame interval, median/p95 | ~16.7/16.8 ms | ~16.7/16.7 ms |

The original build already sustained 60 FPS on this particular GPU once
startup completed. Its initialization still synchronously linked programs
with individual stalls up to 4.5 seconds. The reported hardware crashes were
not reproduced here; removing the second renderer, eager compilation, and
unbounded allocations addresses concrete contributors to startup failure.

The revised isosurface/GGX, default accretion flow, and default granular-flow
scenes also sustained ~16.7 ms median and p95 frame intervals at scale 0.25.
They initialized in ~0.45–0.58 seconds. These are scene-specific results,
not a promise of 60 FPS at arbitrary supersampling or solver settings.

At that stage, the loading shell was static HTML/CSS with a 6 KB still of the
original scene.
It appeared in ~0.08–0.10 seconds on localhost, including with JavaScript
disabled. At an emulated 3 Mbit/s and 80 ms latency, first content appeared
in ~0.32 seconds and the app rendered in ~3.74 seconds. The runtime data,
palette, and selected shader sources together totaled ~0.58 MB.

Changes:

- Load exact orbital tables on demand from the shared bake.
- Compile only active programs asynchronously; specialize discrete technique,
  shading, derivative, and single-state branches. Cache at most 16 variants.
- Start large automatic-quality views with a conservative pixel count and
  react to actual frame intervals toward a 60 FPS target.
- Bound screen-space allocations by GPU limits, eight megapixels, and an
  estimated 128 MiB budget, including accumulation, trails, and post effects.
- Release accumulation on resize, inactive feature targets on mode changes,
  and all owned GL resources on unmount. Capture within the render frame
  without preserving the drawing buffer.

Verification:

- All 650 table files and all 5,850 statistics match the original bake.
- Nineteen deterministic cases matched the unchanged build pixel-for-pixel:
  every analytic technique, superpositions up to eight terms, n=25, all five
  flow methods, fourth-order/midpoint transport, post, axes, and clipping.
- Repeated path-tracer resizes retain exactly two accumulation framebuffers;
  switching techniques releases them. Disabling flow and post releases their
  targets. Repeated shader-variant switches stay within the cache limit.
- PNG capture contains the rendered image. Returning to a visited quantum
  state reuses its tables. A stalled download leaves the loading shell visible.
- Production exports work at both `/` and the GitHub Pages `/hydrogen/` path.
- An 8× request at DPR 2 was bounded to 3,861×2,172 with no GL error. Context
  loss produces a visible reload message instead of an indefinite loading screen.

SwiftShader also starts without context loss, but needs much lower automatic
resolution and has uneven frame pacing. Hardware-GPU results should not be
interpreted as software-renderer performance guarantees.

See [web/README.md](../web/README.md#performance-and-regression-checks) for
the reproducible asset, rendering, comparison, and performance commands.

## Accepted animated loader (2026-10-05)

The current stable loader renders the original equal-amplitude 1s + 2p₀
superposition with direct basis formulas, the original camera, intersecting
projected isosurfaces, signed color sequence, lighting, and bloom. Its complete
color/geometry cycle lasts 12.56637 seconds. The backdrop matches the black
page; the orbital palette is independent of that backdrop.

The inline runtime is approximately 6.7 KB gzipped, with no loader asset
requests. It draws before framework JavaScript loads, then hands animation to
an OffscreenCanvas worker. Rendering is capped at 256² pixels. The viewer waits
for the handoff for at most 250 ms. The shared app stylesheet stays separate.
Worker and GL resources are released after loading. The former still asset
has been removed.

On the same Intel/Chromium setup, the live loader presented 42 changing frames
during a deliberate 700 ms main-thread CPU stall, with maximum frame gaps under
19 ms. A 16-phase comparison to the archived table-based renderer measured
maximum mean channel error below 0.025/255 at equal resolution. Cold heavy main
shader compilation still caused roughly 300–450 ms presentation pauses; warm
compilation was much smoother. These are local measurements, not universal
device guarantees. The user accepted this live implementation as the stable
point, with the remaining cold compilation pause understood.

## Deferred: ahead-of-time loader playback

Investigate rendering ahead, or baking the complete physical loop at build
time or on an edge server, then playing it without a live GL context. This
follow-up is deferred until after the accepted live loader; no AoT playback is
implemented in this stable point.

Compare actual presentation during cold main-viewer compilation, first-frame
latency, compressed payload, decode/raster/upload work, and memory use against
the live worker loader. Removing loader GL does not establish that a shared
graphics-driver pause disappears: the earlier compositor-only CSS study also
paused during cold compilation. Measure playback after its frames are ready.

Preserve the confirmed intersecting structure and full signed color sequence,
and the defensible claim that this is the same superposition animated. A baked
loop must remain smooth, immediately visible, and lightweight enough to justify
its network cost. Respect the 250 ms extra startup allowance and keep the shared
stylesheet separate. Reconsider shader specialization separately if it adds
recompilation when display settings change.
