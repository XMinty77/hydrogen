# =============================================================================
# palettes.jl — design the project palettes and emit assets/palettes.json.
# =============================================================================
#
# Produces:
#   assets/palettes.json          — consumed by the C# and web hosts (uploaded
#                                   as shader uniforms; interpolation happens
#                                   in-shader, in OKLab)
#   gallery/palettes/ramps.png    — comparison sheet: prototype sRGB-lerp vs
#                                   OKLab-lerp vs lightness-linearized "tuned"
#                                   variant, each with its measured OKLab
#                                   lightness profile underneath as grayscale
#   gallery/palettes/phase.png    — comparison sheet: prototype HSV wheel vs
#                                   constant-lightness OKLCH wheel, same layout
#
# The ramp candidates (all built from the prototype's accretion-disk stops):
#   accretion        — the stops verbatim; hosts may lerp them in sRGB to
#                      reproduce the prototype exactly (space = "srgb")
#   accretion_oklab  — same stops, lerped in OKLab (fixes between-stop sag)
#   accretion_tuned  — the OKLab path resampled so lightness is *exactly*
#                      linear in position: equal data steps = equal perceived
#                      brightness steps (the scientific-viz gold standard),
#                      while following the original hue/chroma trajectory
#
# Run:  julia --project=lab lab/scripts/palettes.jl
# =============================================================================

using HydrogenLab
using JSON3
using PNGFiles
using Colors: RGB, N0f8

# -----------------------------------------------------------------------------
# Source stops: the prototype's palette (config.jl CMAP_STOPS), verbatim.
# -----------------------------------------------------------------------------
const STOPS = [
    (0.00, (0.045, 0.020, 0.075)),   # purple-black (== background)
    (0.16, (0.230, 0.045, 0.360)),   # deep purple
    (0.40, (0.560, 0.110, 0.470)),   # magenta
    (0.62, (0.880, 0.300, 0.220)),   # red-orange
    (0.78, (0.980, 0.560, 0.150)),   # orange
    (0.90, (1.000, 0.800, 0.330)),   # amber
    (1.00, (1.000, 0.985, 0.880)),   # warm yellow-white
]

const PHASE_L = 0.75      # lightness of the cyclic phase wheel
const PHASE_C = 0.125     # chroma — just inside the sRGB gamut at every hue
                          # (wheel_chroma(0.75) = 0.1275, measured)
const PHASE_H0 = deg2rad(30.0)   # hue of phase 0 (warm orange-red, matching
                                 # the ramp's high end)

# -----------------------------------------------------------------------------
# Ramp evaluators (Float64; the shader mirrors the OKLab one in Float32).
# -----------------------------------------------------------------------------

"Piecewise-linear interpolation of `stops` [(pos, value)] at t, where lerp()
combines two stop payloads."
function interp_stops(stops, t, lerp)
    t ≤ stops[1][1] && return stops[1][2]
    for i in 2:length(stops)
        p0, p1 = stops[i - 1][1], stops[i][1]
        if t ≤ p1
            return lerp(stops[i - 1][2], stops[i][2], (t - p0) / (p1 - p0))
        end
    end
    return stops[end][2]
end

"Ramp color at t by lerping the stops in gamma-encoded sRGB (prototype path)."
ramp_srgb(stops, t) =
    interp_stops(stops, t, (c0, c1, s) -> c0 .+ s .* (c1 .- c0))

"Ramp color at t by lerping the stops in OKLab; returns sRGB."
function ramp_oklab(stops_lab, t)
    lab = interp_stops(stops_lab, t, (c0, c1, s) -> c0 .+ s .* (c1 .- c0))
    return oklab_to_srgb(lab...)
end

# -----------------------------------------------------------------------------
# The "tuned" variant: exactly-linear lightness.
#
# Walk the piecewise-linear OKLab path of the original stops; L is monotone
# along it (verified below), so for each target lightness we can solve for the
# path position carrying it, then read hue/chroma there. Resampled to NEW_N
# evenly spaced stops whose L values are an arithmetic progression.
# -----------------------------------------------------------------------------
function tuned_stops(stops_lab; new_n = 8)
    Ls = [lab[1] for (_, lab) in stops_lab]
    @assert issorted(Ls) "lightness along the ramp must be monotone"
    L0, L1 = Ls[1], Ls[end]
    out = Vector{Tuple{Float64,NTuple{3,Float64}}}(undef, new_n)
    for k in 1:new_n
        t = (k - 1) / (new_n - 1)
        Lt = L0 + t * (L1 - L0)
        # Find the path segment containing lightness Lt and lerp inside it.
        i = findlast(L -> L ≤ Lt + 1e-12, Ls)
        i = min(i, length(Ls) - 1)
        s = (Lt - Ls[i]) / max(Ls[i + 1] - Ls[i], 1e-12)
        lab = stops_lab[i][2] .+ s .* (stops_lab[i + 1][2] .- stops_lab[i][2])
        out[k] = (t, clamp_chroma(lab...))
    end
    return out
end

# -----------------------------------------------------------------------------
# Build everything.
# -----------------------------------------------------------------------------
stops_lab = [(p, srgb_to_oklab(c...)) for (p, c) in STOPS]
tuned = tuned_stops(stops_lab)

root = normpath(joinpath(@__DIR__, "..", ".."))
mkpath(joinpath(root, "assets"))
mkpath(joinpath(root, "gallery", "palettes"))

# --- palettes.json -----------------------------------------------------------
ramp_json(positions, srgb, lab) =
    (; positions, srgb = [collect(c) for c in srgb], oklab = [collect(c) for c in lab])

json = (;
    ramps = (;
        accretion = ramp_json([p for (p, _) in STOPS],
                              [c for (_, c) in STOPS],
                              [lab for (_, lab) in stops_lab]),
        accretion_tuned = ramp_json([p for (p, _) in tuned],
                                    [oklab_to_srgb(lab...) for (_, lab) in tuned],
                                    [lab for (_, lab) in tuned]),
    ),
    phase = (; L = PHASE_L, C = PHASE_C, h0 = PHASE_H0),
)
open(joinpath(root, "assets", "palettes.json"), "w") do io
    JSON3.pretty(io, json)
end

# --- comparison sheets -------------------------------------------------------
const W, STRIP_H, LROW_H, GAP = 1024, 96, 24, 14

"Render one strip + its lightness profile row into an image column list.
`colorf(t) -> (r,g,b)` in gamma sRGB."
function strip_with_lightness(colorf)
    img = Matrix{RGB{N0f8}}(undef, STRIP_H + LROW_H, W)
    for x in 1:W
        t = (x - 1) / (W - 1)
        r, g, b = clamp.(colorf(t), 0.0, 1.0)
        c = RGB{N0f8}(r, g, b)
        for y in 1:STRIP_H
            img[y, x] = c
        end
        Lv = srgb_to_oklab(r, g, b)[1]          # measured perceptual lightness
        cg = RGB{N0f8}(clamp(Lv, 0, 1), clamp(Lv, 0, 1), clamp(Lv, 0, 1))
        for y in (STRIP_H + 1):(STRIP_H + LROW_H)
            img[y, x] = cg
        end
    end
    return img
end

"Stack images vertically with black gaps."
function stack(imgs)
    h = sum(size.(imgs, 1)) + GAP * (length(imgs) - 1)
    out = fill(RGB{N0f8}(0, 0, 0), h, W)
    y = 1
    for img in imgs
        out[y:(y + size(img, 1) - 1), :] = img
        y += size(img, 1) + GAP
    end
    return out
end

# Ramps sheet: prototype sRGB-lerp / OKLab-lerp / tuned.
ramps_sheet = stack([
    strip_with_lightness(t -> ramp_srgb(STOPS, t)),
    strip_with_lightness(t -> ramp_oklab(stops_lab, t)),
    strip_with_lightness(t -> ramp_oklab(tuned, t)),
])
PNGFiles.save(joinpath(root, "gallery", "palettes", "ramps.png"), ramps_sheet)

# Phase sheet: prototype HSV wheel / constant-lightness OKLCH wheel.
function hsv_to_rgb(h, s, v)     # h in degrees — the prototype's phase coloring
    c = v * s
    x = c * (1 - abs(mod(h / 60, 2) - 1))
    m = v - c
    r, g, b = h < 60 ? (c, x, 0.0) : h < 120 ? (x, c, 0.0) : h < 180 ? (0.0, c, x) :
              h < 240 ? (0.0, x, c) : h < 300 ? (x, 0.0, c) : (c, 0.0, x)
    return (r + m, g + m, b + m)
end
phase_sheet = stack([
    strip_with_lightness(t -> hsv_to_rgb(360t, 0.95, 1.0)),
    strip_with_lightness(t -> oklab_to_srgb(PHASE_L,
                                            PHASE_C * cos(2π * t + PHASE_H0),
                                            PHASE_C * sin(2π * t + PHASE_H0))),
])
PNGFiles.save(joinpath(root, "gallery", "palettes", "phase.png"), phase_sheet)

println("wrote assets/palettes.json, gallery/palettes/{ramps,phase}.png")
