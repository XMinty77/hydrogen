# =============================================================================
# color.jl — OKLab color machinery for palette design and reference rendering.
# =============================================================================
#
# Why hand-rolled instead of Colors.jl: the GLSL renderers implement these
# exact conversions in-shader (shaders/common.glsl), and reference renders must
# match GPU output bit-for-bit at Float32. Owning the ~30 lines guarantees the
# constants are literally identical on both sides. The matrices are Björn
# Ottosson's published OKLab definition (https://bottosson.github.io/posts/oklab/).
#
# Conventions: sRGB components in [0,1] (gamma-encoded unless "lin" in the
# name); OKLab as (L, a, b) with L ∈ [0,1] perceptual lightness.
#
#   WARNING: any constant edited here must be edited in shaders/common.glsl too.
# =============================================================================

"sRGB electro-optical transfer: gamma-encoded component -> linear."
srgb_to_linear(c::Real) = c ≤ 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055)^2.4

"Inverse transfer: linear component -> gamma-encoded sRGB."
linear_to_srgb(c::Real) = c ≤ 0.0031308 ? 12.92c : 1.055 * c^(1 / 2.4) - 0.055

"""
    srgb_to_oklab(r, g, b) -> (L, a, b)

Gamma-encoded sRGB in [0,1] to OKLab.
"""
function srgb_to_oklab(r::Real, g::Real, b::Real)
    rl, gl, bl = srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b)
    # linear sRGB -> LMS cone response
    l = 0.4122214708rl + 0.5363325363gl + 0.0514459929bl
    m = 0.2119034982rl + 0.6806995451gl + 0.1073969566bl
    s = 0.0883024619rl + 0.2817188376gl + 0.6299787005bl
    l_, m_, s_ = cbrt(l), cbrt(m), cbrt(s)
    return (0.2104542553l_ + 0.7936177850m_ - 0.0040720468s_,
            1.9779984951l_ - 2.4285922050m_ + 0.4505937099s_,
            0.0259040371l_ + 0.7827717662m_ - 0.8086757660s_)
end

"""
    oklab_to_linsrgb(L, a, b) -> (r, g, b)

OKLab to *linear* sRGB. May return components outside [0,1] — that is the
out-of-gamut signal `in_gamut` relies on, so no clamping here.
"""
function oklab_to_linsrgb(L::Real, a::Real, b::Real)
    l_ = L + 0.3963377774a + 0.2158037573b
    m_ = L - 0.1055613458a - 0.0638541728b
    s_ = L - 0.0894841775a - 1.2914855480b
    l, m, s = l_^3, m_^3, s_^3
    return (4.0767416621l - 3.3077115913m + 0.2309699292s,
            -1.2684380046l + 2.6097574011m - 0.3413193965s,
            -0.0041960863l - 0.7034186147m + 1.7076147010s)
end

"""
    oklab_to_srgb(L, a, b) -> (r, g, b)

OKLab to gamma-encoded sRGB, clamped to [0,1] (display-ready).
"""
function oklab_to_srgb(L::Real, a::Real, b::Real)
    rl, gl, bl = oklab_to_linsrgb(L, a, b)
    cl(c) = clamp(linear_to_srgb(clamp(c, 0.0, 1.0)), 0.0, 1.0)
    return (cl(rl), cl(gl), cl(bl))
end

"True when the OKLab color lies inside the sRGB gamut (all linear components
within [0,1], with a hair of tolerance for float noise)."
function in_gamut(L::Real, a::Real, b::Real; tol::Real = 1e-6)
    rl, gl, bl = oklab_to_linsrgb(L, a, b)
    return -tol ≤ rl ≤ 1 + tol && -tol ≤ gl ≤ 1 + tol && -tol ≤ bl ≤ 1 + tol
end

"""
    max_chroma(L, hue) -> Float64

Largest chroma C such that OKLCH(L, C, hue) is inside sRGB, by bisection.
`hue` in radians.
"""
function max_chroma(L::Real, hue::Real; hi::Real = 0.5, iters::Int = 40)
    lo = 0.0
    for _ in 1:iters
        mid = (lo + hi) / 2
        if in_gamut(L, mid * cos(hue), mid * sin(hue))
            lo = mid
        else
            hi = mid
        end
    end
    return lo
end

"""
    wheel_chroma(L; steps) -> Float64

Largest chroma usable at *every* hue for lightness L — the limit for a
constant-(L,C) cyclic phase wheel that stays inside sRGB. (The binding hue is
essentially always the blue region.)
"""
wheel_chroma(L::Real; steps::Int = 720) =
    minimum(max_chroma(L, 2π * k / steps) for k in 0:(steps - 1))

"""
    clamp_chroma(L, a, b) -> (L, a, b)

Project an out-of-gamut OKLab color back into sRGB by shrinking chroma at
constant lightness and hue — the standard perceptual gamut-mapping choice
(hue shifts are far more objectionable than slight desaturation).
"""
function clamp_chroma(L::Real, a::Real, b::Real)
    in_gamut(L, a, b) && return (float(L), float(a), float(b))
    C = hypot(a, b)
    Cmax = max_chroma(L, atan(b, a); hi = C)
    return (float(L), a * Cmax / C, b * Cmax / C)
end
