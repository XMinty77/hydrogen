# =============================================================================
# tables.jl — baking ψ's separable factors into GPU-ready 1D tables.
# =============================================================================
#
# Because ψ_nlm = R_nl(r) · P̄_lm(cosθ) · azimuthal(mφ) is separable, the GPU
# renderers never need a 3D volume: they reconstruct ψ exactly from two 1D
# table lookups plus a `sincos`. This file bakes those tables — in BigFloat,
# rounded once to Float32 — and computes the per-state display statistics the
# renderers use to normalize |ψ|² into a colormap range.
#
# Sample-point mappings (chosen for accuracy, mirrored exactly in the shaders)
# ----------------------------------------------------------------------------
# • Radial tables are sampled uniformly in s = √(r/r_max), i.e. r = r_max·s².
#   R_nl locally oscillates with wavenumber k(r) ≈ √(2/r) near the origin, so
#   uniform-in-r sampling wastes points at large r while under-resolving small
#   r. Under the √ mapping the phase advance per sample, k(r)·Δr ∝ √(1/r)·√r,
#   is *constant* across the table — every oscillation gets equal resolution.
#   The shader inverts this with a single sqrt: texcoord = √(r/r_max).
# • Angular tables are sampled uniformly in θ (not u = cosθ): P̄_l^m behaves
#   like cos(lθ + …), so θ-uniform sampling resolves its oscillations evenly,
#   whereas u-uniform sampling degenerates near the poles where dθ/du → ∞.
#   The shader inverts with texcoord = acos(u)/π.
#
# Both mappings make linear interpolation error scale as (phase/sample)²/8,
# uniformly over the whole table — measured and certified in validate.jl.
# =============================================================================

using Statistics: quantile   # (unweighted; weighted version implemented below)

# -----------------------------------------------------------------------------
# Domain sizing: how far out to tabulate.
# -----------------------------------------------------------------------------

"Display half-width heuristic carried over from the prototype: the classical
turning point sits near r = 2n², so `factor`·n² tracks it with headroom, and
the additive `pad` keeps the diffuse tails of low-n states from being clipped.
This is the *framing* radius — where the interesting structure lives, and the
ball over which display statistics are computed. It is NOT a safe truncation
radius for ψ itself; see `safe_clip_radius`."
const EXTENT_FACTOR = 2.2
const EXTENT_PAD = 2.0

"""
    r_max_for(n) -> Float64

Display/framing radius for principal quantum number `n` (Bohr radii): the
default camera extent, and the ball over which `display_stats` quantiles are
taken. Radial *tables* extend farther — to `safe_clip_radius` — because ψ is
still faintly visible here (measured: truncating at this radius leaves a
10–16% brightness discontinuity under the default display mapping, a hard
spherical edge the prototype actually had).
"""
r_max_for(n::Integer) = EXTENT_FACTOR * n^2 + EXTENT_PAD

# -----------------------------------------------------------------------------
# Safe truncation radius (data-driven, per state).
#
# The renderers hard-clip ψ to 0 beyond the radial table's extent, so that
# extent must be far enough out that the discontinuity is invisible. "Invisible"
# is evaluated under a display mapping deliberately *harsher* than the default
# (lower gamma brightens faint tails; a floor of half an 8-bit step instead of
# a full one; the rigorous bound max|Y_lm| ≤ √((2l+1)/4π) for the angular
# factor), leaving ≳2× amplitude margin over the worst real-mode √2 azimuthal
# factor. The criterion:
#
#     ( |R(r)|² · (2l+1)/(4π) / q999 )^TAIL_GAMMA  <  TAIL_FLOOR
#
# where q999 is the state's display-normalization quantile — i.e. exactly the
# brightness the renderer would draw, with margin.
# -----------------------------------------------------------------------------
const TAIL_GAMMA = 0.40      # harsher than the display default of ~0.45
const TAIL_FLOOR = 1 / 512   # half an 8-bit step

"""
    safe_clip_radius(n, l; q999) -> Float64

Smallest radius ≥ `r_max_for(n)` at which the tail-visibility criterion above
holds (searched in 1% steps, capped at 3× the framing radius). `q999` defaults
to this state's m = 0 display quantile; pass it in when already computed.
"""
function safe_clip_radius(n::Integer, l::Integer;
                          q999::Float64 = display_stats(n, l, 0, true).q999)
    Nr = radial_norm(Float64, n, l)
    Ymax2 = (2l + 1) / (4π)                       # rigorous max of |Y_lm|²
    visible(r) = (radial(n, l, r, Nr)^2 * Ymax2 / q999)^TAIL_GAMMA ≥ TAIL_FLOOR
    r_frame = r_max_for(n)
    r = r_frame
    while visible(r) && r < 3 * r_frame
        r *= 1.01
    end
    return r
end

# -----------------------------------------------------------------------------
# Table containers + their sample-point mappings.
# -----------------------------------------------------------------------------

"""
Baked radial table for one (n, l): `values[i] = R_nl(r_i)` with
`r_i = r_max·s_i²`, `s_i = (i−1)/(samples−1)` — uniform in s, endpoints
inclusive. Stored Float32 (baked via BigFloat) — exactly the GPU texture data.
"""
struct RadialTable
    n::Int
    l::Int
    r_max::Float64
    values::Vector{Float32}
end

"""
Baked angular table for one (l, m≥0): `values[i] = P̄_l^m(cos θ_i)` with
`θ_i = π·(i−1)/(samples−1)` — uniform in θ, endpoints inclusive. Negative m
never needs its own table (only the azimuthal factor differs; see sphharm).
"""
struct AngularTable
    l::Int
    m::Int
    values::Vector{Float32}
end

"Sample radius for index `i` of a `samples`-point radial table (the r_i above)."
radial_node(i::Integer, samples::Integer, r_max::Real) =
    r_max * ((i - 1) / (samples - 1))^2

"Sample u = cosθ for index `i` of a `samples`-point angular table (the θ_i above)."
angular_node(i::Integer, samples::Integer) = cospi((i - 1) / (samples - 1))

"""
    bake_radial(n, l, samples; r_max) -> RadialTable

Evaluate R_nl in BigFloat at every radial node and round once to Float32.
`r_max` defaults to the state's `safe_clip_radius` (pass it in when it is
already known, e.g. from a precomputed stats pass, to avoid recomputation).
"""
function bake_radial(n::Integer, l::Integer, samples::Integer;
                     r_max::Float64 = safe_clip_radius(n, l))
    check_qn(n, l, 0)
    rmax = r_max
    N = radial_norm(BigFloat, n, l)
    values = Vector{Float32}(undef, samples)
    for i in 1:samples
        values[i] = Float32(radial(n, l, BigFloat(radial_node(i, samples, rmax)), N))
    end
    return RadialTable(n, l, rmax, values)
end

"""
    bake_angular(l, m, samples) -> AngularTable

Evaluate P̄_l^m in BigFloat at every angular node and round once to Float32.
"""
function bake_angular(l::Integer, m::Integer, samples::Integer)
    values = Vector{Float32}(undef, samples)
    for i in 1:samples
        values[i] = Float32(plm_norm(l, m, BigFloat(angular_node(i, samples))))
    end
    return AngularTable(l, m, values)
end

# -----------------------------------------------------------------------------
# Simulated GPU lookup — Float32 arithmetic throughout.
#
# The shaders will fetch two texels with texelFetch and mix them manually (GPU
# fixed-function texture filtering has unspecified precision; manual FP32 mix
# is bit-reproducible across native GL and WebGL2). These functions replicate
# that exact arithmetic on the CPU, so validate.jl certifies the *actual*
# rendering pipeline, not an idealization of it — and reference renders can use
# them to be pixel-comparable with GPU output.
# -----------------------------------------------------------------------------

"Shared core: linearly interpolate `values` at fractional index `f·(len−1)`,
`f ∈ [0,1]`, entirely in Float32, clamping to the table ends."
function lookup01(values::Vector{Float32}, f::Float32)
    x = clamp(f, 0.0f0, 1.0f0) * Float32(length(values) - 1)
    i0 = min(unsafe_trunc(Int, x), length(values) - 2)   # left node (0-based)
    t = x - Float32(i0)
    return (1.0f0 - t) * values[i0 + 1] + t * values[i0 + 2]
end

"""
    lookup_radial(tab, r::Float32) -> Float32

R_nl(r) as the GPU will compute it: √-mapped coordinate, Float32 linear
interpolation. Returns 0 beyond r_max (matching the renderers' clip).
"""
function lookup_radial(tab::RadialTable, r::Float32)
    r > tab.r_max && return 0.0f0
    return lookup01(tab.values, sqrt(r / Float32(tab.r_max)))
end

"""
    lookup_angular(tab, θ::Float32) -> Float32

P̄_l^m(cosθ) as the GPU will compute it: the table is indexed by the *polar
angle* θ ∈ [0, π] directly, Float32 linear interpolation.

Indexing by θ — with the shader deriving it as `θ = atan(√(x²+y²), z)` — is a
deliberate conditioning choice: deriving θ from u = z/r via acos amplifies
FP32 rounding of u by 1/sinθ near the poles, which was measured to cost up to
3e-4 of the factor's peak for m = 1 states (whose θ-slope peaks at the pole).
Two-argument atan has uniformly bounded conditioning, eliminating that error
class entirely — for the same shader cost, since atan is needed for φ anyway.
"""
lookup_angular(tab::AngularTable, θ::Float32) =
    lookup01(tab.values, θ / Float32(π))

# -----------------------------------------------------------------------------
# Display statistics.
#
# The renderers map |ψ|² → [0,1] before colormapping. Dividing by the global
# max makes everything but the nuclear spike invisible, so (as in the
# prototype) we normalize by a high *volume-weighted quantile* of |ψ|² over the
# ball r ≤ r_max. Those quantiles depend on (n, l, |m|, mode) only:
#   • |m| not m — the ±m states differ by an azimuth rotation (real mode) or
#     a global phase (complex mode), neither of which changes value statistics;
#   • mode matters — the real harmonics carry a √2·cos(mφ) factor whose
#     square averages differently than the complex |e^{imφ}| = 1.
# -----------------------------------------------------------------------------

"""
Volume-weighted statistics of |ψ|² for one (n, l, |m|, mode), computed in
Float64 on a spherical product grid (r × u, plus one azimuthal period of
cos²(mφ) when the mode makes ψ φ-dependent). `max_density` is the grid maximum
(the azimuthal factor's max is folded in exactly); `q999`/`q9999` are the
0.999 / 0.9999 volume quantiles the renderers use for normalization.
"""
struct DisplayStats
    n::Int
    l::Int
    m::Int              # |m| ≥ 0
    real_mode::Bool
    max_density::Float64
    q999::Float64
    q9999::Float64
end

"Weighted p-quantile: smallest value v such that weights of {vals ≤ v} reach a
fraction p of the total. Exact for our purpose (no interpolation refinement)."
function weighted_quantile(vals::Vector{Float64}, weights::Vector{Float64}, p::Real)
    perm = sortperm(vals)
    total = sum(weights)
    acc = 0.0
    for idx in perm
        acc += weights[idx]
        acc ≥ p * total && return vals[idx]
    end
    return vals[perm[end]]
end

"""
    display_stats(n, l, m, real_mode; nr=320, nu=256, nφ=64) -> DisplayStats

Grid resolutions are modest because |ψ|² is smooth and quantiles are forgiving;
doubling them moves the results at the ~1e-3 relative level (measured in the
validation study, scripts/validate.jl).
Cell midpoints + proper volume weights (dV = r² dr du dφ, with dr from the
√ radial mapping) keep the estimate unbiased.
"""
function display_stats(n::Integer, l::Integer, m::Integer, real_mode::Bool;
                       nr::Int = 512, nu::Int = 320, nφ::Int = 64)
    check_qn(n, l, m)
    m = abs(m)
    rmax = r_max_for(n)
    Nr = radial_norm(Float64, n, l)

    # Radial factor R² and volume weight at s-midpoints: r = rmax·s²,
    # dV_r = r²dr = rmax³·2s⁵ ds — only *relative* weights matter for quantiles.
    R2 = Vector{Float64}(undef, nr)
    wr = Vector{Float64}(undef, nr)
    for i in 1:nr
        s = (i - 0.5) / nr
        r = rmax * s^2
        R2[i] = radial(n, l, r, Nr)^2
        wr[i] = s^5
    end

    # Angular factor P̄² at u-midpoints (uniform u; weight constant).
    P2 = [plm_norm(l, m, -1.0 + (j - 0.5) * 2.0 / nu)^2 for j in 1:nu]

    # Azimuthal factor: |e^{imφ}|² = 1 (complex or m = 0), else 2cos²(mφ),
    # sampled over one period — statistics over one period equal the full circle.
    A2 = (real_mode && m != 0) ? [2.0 * cos(m * ((k - 0.5) * (π / m) / nφ))^2 for k in 1:nφ] :
                                 [1.0]

    # Assemble the value/weight lists for the quantiles.
    vals = Vector{Float64}(undef, nr * nu * length(A2))
    wts = Vector{Float64}(undef, length(vals))
    idx = 1
    for a in A2, j in 1:nu, i in 1:nr
        vals[idx] = R2[i] * P2[j] * a
        wts[idx] = wr[i]
        idx += 1
    end

    max_density = maximum(R2) * maximum(P2) *
                  ((real_mode && m != 0) ? 2.0 : 1.0)   # exact azimuthal max
    return DisplayStats(n, l, m, real_mode, max_density,
                        weighted_quantile(vals, wts, 0.999),
                        weighted_quantile(vals, wts, 0.9999))
end
