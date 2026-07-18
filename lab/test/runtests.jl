# =============================================================================
# runtests.jl — unit tests for HydrogenLab.
# =============================================================================
#
# Testing strategy, from strongest to weakest guarantee:
#
#   1. Closed forms      — a handful of states have simple textbook expressions;
#                          the code must reproduce them to machine precision.
#   2. Independent
#      implementations   — the Laguerre recurrence is checked against the
#                          explicit binomial series (different algorithm, exact
#                          BigInt coefficients); the normalized Legendre
#                          recurrence against the classic unnormalized `plgndr`
#                          recurrence times an exact factorial normalization.
#   3. Orthonormality    — ∫R_nl R_n'l r²dr = δ_nn' and the spherical-harmonic
#                          normalization, by quadrature over all n ≤ 10. Wrong
#                          normalization or recurrence coefficients cannot pass.
#   4. Symmetries        — conjugation for ±m, azimuthal rotations, parity.
#   5. Pipeline accuracy — the baked-Float32-table + FP32-interpolation lookup
#                          (exactly what the GPU does) stays within the error
#                          budget against BigFloat truth.
#   6. Round-trip        — the HORB asset survives write → read bit-exactly.
# =============================================================================

using HydrogenLab
using Test

# Error metric used throughout: absolute error relative to the factor's global
# scale. Pointwise relative error is meaningless near a wavefunction's nodes
# (the true value passes through zero), and what the eye sees in a rendering is
# error relative to the brightest features — i.e. exactly this metric.
scaled_err(approx, truth, scale) = Float64(abs(approx - truth) / scale)

@testset "HydrogenLab" begin

@testset "quantum number validation" begin
    @test_throws ArgumentError psi(0, 0, 0, 1.0, 0.0, 0.0; real_mode = true)
    @test_throws ArgumentError psi(2, 2, 0, 1.0, 0.0, 0.0; real_mode = true)
    @test_throws ArgumentError psi(3, 1, 2, 1.0, 0.0, 0.0; real_mode = true)
    @test_throws ArgumentError plm_norm(2, 3, 0.5)
    @test_throws ArgumentError plm_norm(2, -1, 0.5)
end

@testset "closed forms (machine precision)" begin
    # Radial functions (atomic units), e.g. Griffiths Table 4.7:
    #   R_10 = 2e^{-r}
    #   R_20 = (1/√2)(1 − r/2)e^{-r/2}
    #   R_21 = (1/√24) r e^{-r/2}
    #   R_32 = (2√2/(81√15)) r² e^{-r/3}
    for r in (0.0, 0.3, 1.0, 4.7, 20.0)
        @test radial(1, 0, r) ≈ 2exp(-r) atol = 1e-15
        @test radial(2, 0, r) ≈ (1 - r / 2) * exp(-r / 2) / sqrt(2) atol = 1e-15
        @test radial(2, 1, r) ≈ r * exp(-r / 2) / sqrt(24) atol = 1e-15
        @test radial(3, 2, r) ≈ 2sqrt(2) / (81sqrt(15)) * r^2 * exp(-r / 3) atol = 1e-15
    end

    # Normalized associated Legendre values (CS phase included):
    #   P̄_0^0 = 1/√(4π)          P̄_1^0 = √(3/4π)·u     P̄_1^1 = −√(3/8π)·sinθ
    #   P̄_2^0 = √(5/16π)(3u²−1)  P̄_2^2 = √(15/32π)(1−u²)
    for u in (-1.0, -0.42, 0.0, 0.42, 1.0)
        s = sqrt(1 - u^2)
        @test plm_norm(0, 0, u) ≈ 1 / sqrt(4π) atol = 1e-16
        @test plm_norm(1, 0, u) ≈ sqrt(3 / 4π) * u atol = 1e-16
        @test plm_norm(1, 1, u) ≈ -sqrt(3 / 8π) * s atol = 1e-16
        @test plm_norm(2, 0, u) ≈ sqrt(5 / 16π) * (3u^2 - 1) atol = 1e-15
        @test plm_norm(2, 2, u) ≈ sqrt(15 / 32π) * (1 - u^2) atol = 1e-15
    end

    # Ground state: ψ_100 = e^{-r}/√π, spherically symmetric, both modes.
    for mode in (true, false)
        p = psi_cartesian(1, 0, 0, 0.3, 0.4, 0.5; real_mode = mode)
        @test real(p) ≈ exp(-sqrt(0.5)) / sqrt(π) atol = 1e-15
        @test imag(p) == 0.0
    end

    # Textbook real-orbital signs (CS phase cancelled in real mode):
    # p_x ∝ +x, p_y ∝ +y, p_z ∝ +z — positive lobes on positive axes.
    @test real(psi_cartesian(2, 1, 1, 1.0, 0.0, 0.0; real_mode = true)) > 0   # p_x
    @test real(psi_cartesian(2, 1, -1, 0.0, 1.0, 0.0; real_mode = true)) > 0  # p_y
    @test real(psi_cartesian(2, 1, 0, 0.0, 0.0, 1.0; real_mode = true)) > 0   # p_z
end

@testset "independent implementation cross-checks (BigFloat)" begin
    # Laguerre via the explicit series L_p^α(x) = Σ_k (−1)^k C(p+α, p−k) x^k/k!
    # with exact BigInt binomials — a different algorithm with exact coefficients.
    laguerre_series(p, α, x::BigFloat) =
        sum((-1)^k * binomial(big(p + α), big(p - k)) * x^k / factorial(big(k))
            for k in 0:p)
    for p in (0, 1, 3, 9), α in (1, 5, 19), xf in (0.1, 1.7, 12.0, 44.0)
        x = BigFloat(xf)
        @test scaled_err(laguerre(p, α, x), laguerre_series(p, α, x),
                         abs(laguerre_series(p, α, x)) + 1) < 1e-70
    end

    # Normalized Legendre via the classic unnormalized recurrence (Numerical
    # Recipes plgndr, CS phase included) times the exact factorial norm.
    function plgndr(l, m, x::BigFloat)
        pmm = one(BigFloat)
        if m > 0
            somx2 = sqrt((1 - x) * (1 + x))
            fact = one(BigFloat)
            for _ in 1:m
                pmm *= -fact * somx2
                fact += 2
            end
        end
        l == m && return pmm
        pmmp1 = x * (2m + 1) * pmm
        l == m + 1 && return pmmp1
        pll = zero(BigFloat)
        for ll in (m + 2):l
            pll = ((2ll - 1) * x * pmmp1 - (ll + m - 1) * pmm) / (ll - m)
            pmm, pmmp1 = pmmp1, pll
        end
        return pll
    end
    norm_lm(l, m) = sqrt((2l + 1) / (4 * BigFloat(π)) *
                         factorial(big(l - m)) / factorial(big(l + m)))
    for l in 0:9, m in 0:l, uf in (-0.9, -0.3, 0.2, 0.77)
        u = BigFloat(uf)
        @test scaled_err(plm_norm(l, m, u), norm_lm(l, m) * plgndr(l, m, u),
                         Float64(norm_lm(l, 0))) < 1e-70
    end
end

@testset "orthonormality by quadrature (all n ≤ 10)" begin
    # Radial: ∫_0^∞ R_nl R_n'l r² dr = δ_nn'. Trapezoid on a dense uniform grid
    # out to beyond both classical turning points. Float64; the quadrature
    # itself limits accuracy, hence the 1e-6 tolerance.
    function radial_overlap(n1, n2, l)
        # 2.0× the framing radius, with a 20n floor for low n: R_nl decays as
        # e^{-r/n}, so r = 20n puts the truncated tail below e^{-40}. (Without
        # the floor, n = 1 would stop at 8.4 a₀ and miss ~8e-6 of probability.)
        nmax = max(n1, n2)
        rmax = max(2.0 * r_max_for(nmax), 20.0 * nmax)
        npts = 60_000
        dr = rmax / npts
        N1, N2 = radial_norm(Float64, n1, l), radial_norm(Float64, n2, l)
        acc = 0.0
        for i in 1:npts   # trapezoid; integrand is 0 at both ends (r² kills r=0)
            r = i * dr
            acc += radial(n1, l, r, N1) * radial(n2, l, r, N2) * r^2
        end
        return acc * dr
    end
    for n in 1:10, l in 0:(n - 1)
        @test radial_overlap(n, n, l) ≈ 1.0 atol = 1e-6
    end
    # A representative sample of off-diagonal pairs (full set is slow):
    for (n1, n2, l) in ((1, 2, 0), (2, 3, 1), (3, 10, 2), (9, 10, 0), (5, 7, 4))
        @test abs(radial_overlap(n1, n2, l)) < 1e-6
    end

    # Angular: 2π ∫ P̄_l^m(u)² du = 1 (complex-harmonic normalization) and
    # cross-l orthogonality at fixed m.
    function angular_overlap(l1, l2, m)
        npts = 20_000
        du = 2.0 / npts
        acc = 0.0
        for i in 1:npts
            u = -1 + (i - 0.5) * du             # midpoint rule
            acc += plm_norm(l1, m, u) * plm_norm(l2, m, u)
        end
        return 2π * acc * du
    end
    for l in 0:9, m in 0:l
        @test angular_overlap(l, l, m) ≈ 1.0 atol = 1e-6
    end
    for (l1, l2, m) in ((0, 2, 0), (1, 3, 1), (7, 9, 5), (8, 9, 8))
        @test abs(angular_overlap(l1, l2, m)) < 1e-6
    end
end

@testset "symmetries" begin
    u, φ = 0.37, 1.1
    for l in 0:6, m in 1:l
        # Complex mode: Y_{l,−m} = (−1)^m conj(Y_{l,m}).
        Yp = sphharm(l, m, u, φ; real_mode = false)
        Ym = sphharm(l, -m, u, φ; real_mode = false)
        @test Ym ≈ (-1)^m * conj(Yp) atol = 1e-15

        # Real mode: the −m (sine) harmonic is the +m (cosine) one rotated by
        # π/(2m) in azimuth.
        Rp = sphharm(l, m, u, φ; real_mode = true)
        Rm = sphharm(l, -m, u, φ + π / 2m; real_mode = true)
        @test real(Rm) ≈ real(Rp) atol = 1e-14
    end
    # Parity: Y_lm(−u, φ+π) = (−1)^l Y_lm(u, φ).
    for l in 0:6, m in -l:l
        @test sphharm(l, m, -u, φ + π; real_mode = false) ≈
              (-1)^l * sphharm(l, m, u, φ; real_mode = false) atol = 1e-14
    end
end

@testset "display stats" begin
    # 1s: |ψ|² = e^{-2r}/π, max at the origin = 1/π; the 0.999 volume quantile
    # must sit below the max and above zero.
    st = display_stats(1, 0, 0, true)
    @test st.max_density ≈ 1 / π rtol = 1e-2   # grid max ≈ true max (r=0 is a
    @test 0 < st.q999 < st.q9999 < st.max_density   # midpoint away from node 1)
    # Real vs complex mode differ for m ≠ 0 (√2·cos vs unit-modulus azimuth):
    @test display_stats(3, 2, 2, true).max_density ≈
          2 * display_stats(3, 2, 2, false).max_density rtol = 1e-12
end

@testset "FP32 GPU pipeline accuracy (worst states, production sizes)" begin
    # The certification test: Float32 tables at production resolution, looked
    # up with the exact FP32 arithmetic the shaders will use, evaluated at
    # inter-node points (worst case for linear interpolation), compared against
    # BigFloat truth. Budget: 5e-5 of each factor's global scale — comfortably
    # below a 16-bit output LSB once factors combine (measured much tighter in
    # scripts/validate.jl; the bound here is deliberately loose to stay stable).
    budget = 5e-5

    for (n, l) in ((10, 0), (10, 9), (7, 3))    # worst oscillation / extent
        tab = bake_radial(n, l, 8192)
        scale = maximum(abs, tab.values)
        worst = 0.0
        for i in 1:(length(tab.values) - 1)     # midpoints between nodes
            r = (radial_node(i, 8192, tab.r_max) + radial_node(i + 1, 8192, tab.r_max)) / 2
            truth = radial(n, l, BigFloat(r))
            worst = max(worst, scaled_err(lookup_radial(tab, Float32(r)), truth, scale))
        end
        @test worst < budget
    end

    for (l, m) in ((9, 0), (9, 4), (9, 9))
        tab = bake_angular(l, m, 4096)
        scale = maximum(abs, tab.values)
        worst = 0.0
        for i in 1:(length(tab.values) - 1)
            θ = π * (i - 0.5) / 4095
            truth = plm_norm(l, m, cos(BigFloat(θ)))
            worst = max(worst, scaled_err(lookup_angular(tab, Float32(θ)), truth, scale))
        end
        @test worst < budget
    end

    # Beyond the table's (data-driven) r_max the lookup clips ψ to 0. The
    # invariant that justifies this: at the clip radius, the *displayed*
    # brightness under the default mapping ((|ψ|²/q999)^0.45, worst-case
    # angular factor) is below one 8-bit step — an invisible discontinuity.
    for (n, l) in ((10, 0), (4, 0), (2, 1))
        tab = bake_radial(n, l, 8192)
        @test tab.r_max > r_max_for(n)          # extends past the framing ball
        q999 = display_stats(n, l, 0, true).q999
        Ymax2 = (2l + 1) / (4π)
        brightness = (radial(n, l, tab.r_max)^2 * Ymax2 / q999)^0.45
        @test brightness < 1 / 255
    end
end

@testset "asset round-trip" begin
    asset = bake_asset(; n_max = 3, radial_samples = 256, angular_samples = 128,
                       verbose = false)
    path = joinpath(mktempdir(), "test.horb")
    write_asset(path, asset)
    back = read_asset(path)

    @test back.n_max == 3
    @test back.radial_samples == 256 && back.angular_samples == 128
    @test keys(back.radial) == keys(asset.radial)
    @test keys(back.angular) == keys(asset.angular)
    @test keys(back.stats) == keys(asset.stats)
    for k in keys(asset.radial)
        @test back.radial[k].values == asset.radial[k].values      # bit-exact
        @test back.radial[k].r_max == asset.radial[k].r_max
    end
    for k in keys(asset.angular)
        @test back.angular[k].values == asset.angular[k].values
    end
    for k in keys(asset.stats)
        @test back.stats[k].q999 == asset.stats[k].q999
        @test back.stats[k].max_density == asset.stats[k].max_density
    end
    # Determinism: same bake parameters → byte-identical file.
    path2 = joinpath(mktempdir(), "test2.horb")
    write_asset(path2, bake_asset(; n_max = 3, radial_samples = 256,
                                  angular_samples = 128, verbose = false))
    @test read(path) == read(path2)
end

end # top-level testset
