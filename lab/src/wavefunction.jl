# =============================================================================
# wavefunction.jl — the physics: hydrogen bound-state wavefunctions.
# =============================================================================
#
# This is the project's single authoritative implementation of
#
#     ψ_nlm(r, θ, φ) = R_nl(r) · Y_lm(θ, φ),
#
# the analytic bound eigenstates of one electron in the Coulomb potential
# V(r) = −1/r (fixed proton, atomic units a₀ = 1). Everything downstream —
# the baked GPU tables, the validation harness, the reference renders the GPU
# output is diffed against — derives from the functions in this file.
#
# Quantum numbers:  n = 1, 2, 3, …  ;  l = 0, …, n−1  ;  m = −l, …, +l.
#
# Design rules
# ------------
# • Every function is generic over the float type T, so the *same code* runs in
#   Float64 (fast reference) and BigFloat (256-bit ground truth for baking and
#   validation). There are no separate "precise" and "fast" implementations to
#   drift apart.
# • Numerically delicate formulations are chosen for unconditional stability:
#     – the associated Legendre part uses the fully *normalized* recurrence
#       (all intermediate values O(1); no factorials, no overflow at any l),
#     – normalization constants use exact BigInt factorials regardless of T,
#     – the Laguerre part uses the standard stable upward recurrence.
#
# Conventions (documented once, used everywhere)
# ----------------------------------------------
# • Complex mode uses the physics-standard Condon–Shortley (CS) phase:
#       Y_lm = P̄_l^m(cosθ) e^{imφ},   with CS (−1)^m folded into P̄,
#   and Y_{l,−m} = (−1)^m conj(Y_{l,m}) for negative m.
# • Real mode uses the textbook real spherical harmonics, which *cancel* the
#   CS phase so that e.g. the p_x lobe is positive along +x (matching every
#   chemistry text and the Wikipedia orbital images):
#       m > 0:  √2 (−1)^m P̄_l^m cos(mφ)
#       m = 0:  P̄_l^0
#       m < 0:  √2 (−1)^m P̄_l^|m| sin(|m|φ)
#   This convention makes signed/diverging color agree with textbook lobe
#   orientation; a global sign is invisible in |ψ| but not in signed color.
# • P̄ is 4π-orthonormalized: ∫ |P̄_l^m(cosθ) e^{imφ}|² dΩ = 1.
# =============================================================================

"""
    check_qn(n, l, m)

Validate the quantum-number triple, throwing a descriptive `ArgumentError` for
anything unphysical. Called at every public API boundary so bad inputs fail
loudly at the edge instead of producing silent garbage.
"""
function check_qn(n::Integer, l::Integer, m::Integer)
    n ≥ 1 || throw(ArgumentError("principal quantum number must satisfy n ≥ 1 (got n = $n)"))
    0 ≤ l < n || throw(ArgumentError("azimuthal quantum number must satisfy 0 ≤ l < n (got l = $l for n = $n)"))
    abs(m) ≤ l || throw(ArgumentError("magnetic quantum number must satisfy |m| ≤ l (got m = $m for l = $l)"))
    return nothing
end

# -----------------------------------------------------------------------------
# Generalized (associated) Laguerre polynomial  L_p^(α)(x).
#
# Stable three-term upward recurrence:
#
#     L_0^(α) = 1
#     L_1^(α) = 1 + α − x
#     (k+1) L_{k+1}^(α) = (2k+1+α−x) L_k^(α) − (k+α) L_{k−1}^(α)
#
# For hydrogen, p = n−l−1 and α = 2l+1, both small non-negative integers.
# -----------------------------------------------------------------------------
"""
    laguerre(p, α, x::T) -> T

Generalized Laguerre polynomial ``L_p^{(α)}(x)`` for integer `p ≥ 0`, `α ≥ 0`.
"""
function laguerre(p::Integer, α::Integer, x::T) where {T<:AbstractFloat}
    Lprev = one(T)                       # L_0
    p == 0 && return Lprev
    Lcur = one(T) + α - x                # L_1
    for k in 1:(p - 1)
        Lnext = ((T(2k + 1 + α) - x) * Lcur - (k + α) * Lprev) / (k + 1)
        Lprev, Lcur = Lcur, Lnext
    end
    return Lcur                          # L_p
end

# -----------------------------------------------------------------------------
# Fully normalized associated Legendre function  P̄_l^m(u),  m ≥ 0,  u = cosθ.
#
# "Fully normalized" means the spherical-harmonic normalization is built into
# the recurrence itself, so that Y_lm = P̄_l^m(cosθ)·e^{imφ} is orthonormal
# over the sphere. Every intermediate value stays O(1) — unlike the classic
# unnormalized `plgndr` recurrence, whose values span many orders of magnitude
# and eventually overflow — which is what makes this formulation safe at any l.
#
# Recurrences (Condon–Shortley phase carried by the minus sign in the seed):
#
#     P̄_0^0        = 1/√(4π)
#     P̄_m^m        = −√((2m+1)/(2m)) · sinθ · P̄_{m−1}^{m−1}
#     P̄_{m+1}^m    = √(2m+3) · u · P̄_m^m
#     P̄_l^m        = a_l^m · ( u·P̄_{l−1}^m − b_l^m·P̄_{l−2}^m )
#       a_l^m = √( (4l²−1) / (l²−m²) )
#       b_l^m = √( ((l−1)²−m²) / (4(l−1)²−1) )
# -----------------------------------------------------------------------------
"""
    plm_norm(l, m, u::T) -> T

Orthonormalized associated Legendre function ``P̄_l^m(u)`` for `0 ≤ m ≤ l`,
`u = cosθ ∈ [−1, 1]`, with the Condon–Shortley phase included.
Satisfies ``2π ∫_{−1}^{1} P̄_l^m(u)² du = 1``.
"""
function plm_norm(l::Integer, m::Integer, u::T) where {T<:AbstractFloat}
    0 ≤ m ≤ l || throw(ArgumentError("need 0 ≤ m ≤ l (got l = $l, m = $m)"))
    # sinθ from u, guarded against |u| marginally above 1 from float roundoff.
    s = sqrt(max(one(T) - u * u, zero(T)))

    # Seed: diagonal term P̄_m^m.
    p_a = one(T) / sqrt(4 * T(π))                 # P̄_0^0
    for k in 1:m
        p_a *= -sqrt((2k + 1) / T(2k)) * s
    end
    l == m && return p_a

    # First off-diagonal term P̄_{m+1}^m.
    p_b = sqrt(T(2m + 3)) * u * p_a
    l == m + 1 && return p_b

    # March l upward: (p_a, p_b) hold P̄_{ll−2}^m and P̄_{ll−1}^m.
    p_c = zero(T)
    for ll in (m + 2):l
        a = sqrt((4ll^2 - 1) / T(ll^2 - m^2))
        b = sqrt(((ll - 1)^2 - m^2) / T(4(ll - 1)^2 - 1))
        p_c = a * (u * p_b - b * p_a)
        p_a, p_b = p_b, p_c
    end
    return p_c
end

# -----------------------------------------------------------------------------
# Radial part  R_nl(r) = N_nl · e^{−ρ/2} · ρ^l · L_{n−l−1}^{(2l+1)}(ρ),  ρ = 2r/n.
# -----------------------------------------------------------------------------
"""
    radial_norm(T, n, l) -> T

Radial normalization constant

``N_{nl} = √( (2/n)³ · (n−l−1)! / (2n·(n+l)!) )``

computed with exact BigInt factorials and 256-bit intermediate arithmetic, then
rounded once to `T`. This confines every factorial in the project to one
host-side function that is exact by construction.
"""
function radial_norm(::Type{T}, n::Integer, l::Integer) where {T<:AbstractFloat}
    check_qn(n, l, 0)
    num = BigFloat(factorial(big(n - l - 1)))
    den = BigFloat(2n) * BigFloat(factorial(big(n + l)))
    return T(sqrt((BigFloat(2) / n)^3 * num / den))
end

"""
    radial(n, l, r::T[, N]) -> T

Radial wavefunction ``R_{nl}(r)`` at radius `r` (in Bohr radii). The
normalization `N` defaults to `radial_norm(T, n, l)`; pass it explicitly when
evaluating many points of the same state to avoid recomputing it.
Satisfies ``∫_0^∞ R_{nl}(r)² r² dr = 1``.
"""
function radial(n::Integer, l::Integer, r::T,
                N::T = radial_norm(T, n, l)) where {T<:AbstractFloat}
    ρ = 2r / n
    return N * exp(-ρ / 2) * ρ^l * laguerre(n - l - 1, 2l + 1, ρ)
end

# -----------------------------------------------------------------------------
# Angular part: spherical harmonics, complex (CS convention) or real (textbook).
# -----------------------------------------------------------------------------
"""
    sphharm(l, m, u::T, φ::T; real_mode) -> Complex{T}

Spherical harmonic ``Y_{lm}`` at `u = cosθ`, azimuth `φ`.

- `real_mode = false`: the complex harmonic ``P̄_l^{|m|} e^{imφ}`` in the
  Condon–Shortley convention (negative m via ``Y_{l,−m} = (−1)^m Y_{lm}^*``).
- `real_mode = true`: the textbook *real* harmonic (CS phase cancelled; see the
  conventions block at the top of this file). Imaginary part is exactly zero.
"""
function sphharm(l::Integer, m::Integer, u::T, φ::T;
                 real_mode::Bool) where {T<:AbstractFloat}
    am = abs(m)
    P = plm_norm(l, am, u)
    # (−1)^m appears in both conventions: cancelling CS in real mode, and
    # implementing Y_{l,−m} = (−1)^m conj(Y_{lm}) for negative m in complex mode.
    sign_flip = isodd(am) ? -one(T) : one(T)

    if real_mode
        if m == 0
            return Complex{T}(P, zero(T))
        end
        azim = m > 0 ? cos(am * φ) : sin(am * φ)
        return Complex{T}(sign_flip * sqrt(T(2)) * P * azim, zero(T))
    else
        sgn = m < 0 ? sign_flip : one(T)
        sφ, cφ = sincos(m * φ)               # e^{imφ}, sign of m included
        return Complex{T}(sgn * P * cφ, sgn * P * sφ)
    end
end

# -----------------------------------------------------------------------------
# The full wavefunction.
# -----------------------------------------------------------------------------
"""
    psi(n, l, m, r::T, u::T, φ::T; real_mode[, Nr]) -> Complex{T}

Full wavefunction ``ψ_{nlm}`` in spherical coordinates: radius `r`, `u = cosθ`,
azimuth `φ`. In real mode the imaginary part is exactly zero (a complex return
type is kept so both modes share one interface: magnitude = `abs`, phase =
`angle`). `Nr` may be passed in to amortize the normalization over many points.
"""
function psi(n::Integer, l::Integer, m::Integer, r::T, u::T, φ::T;
             real_mode::Bool, Nr::T = radial_norm(T, n, l)) where {T<:AbstractFloat}
    check_qn(n, l, m)
    return radial(n, l, r, Nr) * sphharm(l, m, u, φ; real_mode)
end

"""
    psi_cartesian(n, l, m, x::T, y::T, z::T; real_mode[, Nr]) -> Complex{T}

`psi` at a Cartesian point. This mirrors exactly the coordinate transform the
GPU shaders perform (u = z/r guarded at the origin, two-argument atan for φ),
so reference renders built on it are directly comparable to shader output.
"""
function psi_cartesian(n::Integer, l::Integer, m::Integer, x::T, y::T, z::T;
                       real_mode::Bool, Nr::T = radial_norm(T, n, l)) where {T<:AbstractFloat}
    r = sqrt(x * x + y * y + z * z)
    u = r > zero(T) ? clamp(z / r, -one(T), one(T)) : one(T)
    φ = atan(y, x)
    return psi(n, l, m, r, u, φ; real_mode, Nr)
end
