# =============================================================================
# render_reference.jl — CPU reference renders + pixel-diff against GPU output.
# =============================================================================
#
# Re-implements the slice pipeline (shaders/common.glsl + slice.frag) on the
# CPU in Float32 — the same baked tables, the same θ-indexed lookups, the same
# display mapping and OKLab palette math — renders reference frames, and diffs
# them against undithered GPU PNGs produced by the C# host.
#
# Expected agreement: ≤ 1 output LSB (1/255) per channel. The GPU is not
# bit-identical to the CPU (pow/atan are correctly-rounded on neither, and the
# reference does its color conversion in Float64), but everything upstream of
# color — tables, lookups, ψ reconstruction — is the same Float32 arithmetic,
# so any real defect (wrong table, wrong index mapping, wrong uniform, wrong
# row order) shows up as gross, structured error, not ±1 quantization noise.
#
# Usage (paths relative to repo root):
#   julia --project=lab lab/scripts/render_reference.jl compare \
#         <gpu.png> <n> <l> <m> <mode> <color> <plane> <extent>
# Prints per-channel stats and exits nonzero if max diff > 2 LSB.
# =============================================================================

using HydrogenLab
using PNGFiles
using Colors: RGB, N0f8

# --- Float32 pipeline mirror -------------------------------------------------

"Reference slice render: returns H×W matrix of (r,g,b) in [0,1] Float64
(color math in Float64; ψ pipeline strictly Float32, matching the GPU)."
function render_slice(asset, palettes, n, l, m, real_mode, color_mode,
                      origin, axisU, axisV, W, H;
                      gamma = 0.45, value_mode = 0)
    rt = asset.radial[(n, l)]
    at = asset.angular[(l, abs(m))]
    stats = asset.stats[(n, l, abs(m), real_mode ? :real : :complex)]
    q999 = Float32(stats.q999)
    γ = Float32(gamma)

    ramp = palettes.ramps[:accretion_tuned]
    positions = Float32.(ramp.positions)
    labs = [Float32.(c) for c in ramp.oklab]
    phase_L, phase_C, phase_h0 =
        Float32(palettes.phase.L), Float32(palettes.phase.C), Float32(palettes.phase.h0)

    # Piecewise-linear ramp in OKLab (mirror of rampStops in common.glsl).
    function ramp_lab(t::Float32)
        t = clamp(t, 0.0f0, 1.0f0)
        t ≤ positions[1] && return labs[1]
        for i in 2:length(positions)
            if t ≤ positions[i]
                s = (t - positions[i - 1]) / max(positions[i] - positions[i - 1], 1.0f-6)
                return labs[i - 1] .+ s .* (labs[i] .- labs[i - 1])
            end
        end
        return labs[end]
    end

    img = Matrix{NTuple{3,Float64}}(undef, H, W)
    Threads.@threads for row in 1:H
        # PNG row 1 is the top; GL's v runs bottom-up — flip here to match the
        # C# host's top-down readback.
        v = (H - row + 0.5f0) / Float32(H)
        for col in 1:W
            u = (col - 0.5f0) / Float32(W)
            px = Float32.(origin .+ (2u - 1) .* axisU .+ (2v - 1) .* axisV)

            # ψ, exactly as evalPsi does it (θ-indexed tables, Float32).
            rc = sqrt(px[1]^2 + px[2]^2)
            r = sqrt(rc^2 + px[3]^2)
            ψre, ψim = 0.0f0, 0.0f0
            if r ≤ rt.r_max
                R = lookup_radial(rt, r)
                θ = atan(rc, px[3])
                P = lookup_angular(at, θ)
                φ = atan(px[2], px[1])
                am = abs(m)
                flip = isodd(am) ? -1.0f0 : 1.0f0
                if real_mode
                    azim = m == 0 ? 1.0f0 :
                           m > 0 ? sqrt(2.0f0) * flip * cos(am * φ) :
                                   sqrt(2.0f0) * flip * sin(am * φ)
                    ψre = R * P * azim
                else
                    sgn = m < 0 ? flip : 1.0f0
                    s, c = sincos(m * φ)
                    ψre, ψim = sgn * R * P * c, sgn * R * P * s
                end
            end

            # Display mapping (brightnessOf).
            d = ψre^2 + ψim^2
            val = value_mode == 0 ? d / q999 : sqrt(d / q999)
            bright = clamp(val, 0.0f0, 1.0f0)^γ

            # Color (Float64 conversion; ≤1 LSB from the GPU's Float32 path).
            if color_mode == 2
                phase = atan(ψim, ψre)
                lab = (phase_L, phase_C * cos(phase + phase_h0),
                       phase_C * sin(phase + phase_h0)) .* bright
                img[row, col] = oklab_to_srgb(lab...)
            elseif color_mode == 1
                lab = ramp_lab(bright)
                lab = ψre < 0 ? (lab[1], -lab[2], -lab[3]) : Tuple(lab)
                img[row, col] = oklab_to_srgb(lab...)
            else
                img[row, col] = oklab_to_srgb(ramp_lab(bright)...)
            end
        end
    end
    return img
end

# --- CLI ---------------------------------------------------------------------

function main(args)
    args[1] == "compare" || error("only 'compare' is supported")
    gpu_png = args[2]
    n, l, m = parse.(Int, args[3:5])
    real_mode = args[6] == "real"
    color_mode = args[7] == "phase" ? 2 : args[7] == "signed" ? 1 : 0
    plane = args[8]
    extent = parse(Float64, args[9])

    origin = (0.0, 0.0, 0.0)
    axisU, axisV = plane == "xz" ? ((extent, 0.0, 0.0), (0.0, 0.0, extent)) :
                   plane == "xy" ? ((extent, 0.0, 0.0), (0.0, extent, 0.0)) :
                                   ((0.0, extent, 0.0), (0.0, 0.0, extent))

    root = normpath(joinpath(@__DIR__, "..", ".."))
    asset = read_asset(joinpath(root, "assets", "orbitals.bin"))
    palettes = JSON3.read(read(joinpath(root, "assets", "palettes.json")))

    gpu = PNGFiles.load(gpu_png)
    H, W = size(gpu)
    ref = render_slice(asset, palettes, n, l, m, real_mode, color_mode,
                       origin, axisU, axisV, W, H)

    # Per-channel diff in 8-bit steps.
    maxd = 0.0
    sumd = 0.0
    off = 0
    for row in 1:H, col in 1:W
        g = gpu[row, col]
        for (ch, gv) in ((1, g.r), (2, g.g), (3, g.b))
            d = abs(Float64(gv) - ref[row, col][ch]) * 255
            maxd = max(maxd, d)
            sumd += d
            d > 0.5 && (off += 1)
        end
    end
    npx = 3 * H * W
    println("GPU vs reference  ($gpu_png):")
    println("  max diff  : ", round(maxd, digits = 2), " LSB (8-bit steps)")
    println("  mean diff : ", round(sumd / npx, digits = 4), " LSB")
    println("  channels >0.5 LSB off: ", round(100off / npx, digits = 2), " %")
    return maxd ≤ 2.0 ? 0 : 1
end

using JSON3
exit(main(ARGS))
