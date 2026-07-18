# =============================================================================
# HydrogenLab — physics, baking, and validation for the hydrogen visualizer.
# =============================================================================
#
# This package is the numerical foundation of hydrogen2. It owns:
#
#   • wavefunction.jl — the single authoritative ψ_nlm implementation, generic
#     over Float64 (fast reference) and BigFloat (ground truth);
#   • tables.jl      — baking ψ's separable factors into the 1D Float32 tables
#     the GPU renderers sample, plus display-normalization statistics;
#   • asset.jl       — the "HORB" binary asset format those renderers load.
#
# The validation study lives in ../scripts/validate.jl and the asset bake CLI
# in ../scripts/bake.jl; both are thin drivers over this package.
# =============================================================================
module HydrogenLab

export check_qn, laguerre, plm_norm, radial_norm, radial, sphharm, psi, psi_cartesian
export RadialTable, AngularTable, DisplayStats,
       r_max_for, safe_clip_radius, radial_node, angular_node,
       bake_radial, bake_angular, display_stats,
       lookup_radial, lookup_angular
export OrbitalAsset, bake_asset, write_asset, read_asset
export srgb_to_linear, linear_to_srgb, srgb_to_oklab, oklab_to_linsrgb,
       oklab_to_srgb, in_gamut, max_chroma, wheel_chroma, clamp_chroma

include("wavefunction.jl")
include("tables.jl")
include("asset.jl")
include("color.jl")

end # module
