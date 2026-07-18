# =============================================================================
# bake.jl — CLI: bake the production orbital asset.
# =============================================================================
#
# Usage:
#     julia --project=lab -t auto lab/scripts/bake.jl [n_max] [output_path]
#
# Defaults: n_max = 10, output = assets/orbitals.bin (relative to repo root).
# Table sizes are fixed at the production values certified by the validation
# study (lab/validation_report.md): 8192 radial / 4096 angular samples keep the
# worst-case FP32 reconstruction error below a third of a 16-bit output step.
# =============================================================================

using HydrogenLab

n_max = length(ARGS) ≥ 1 ? parse(Int, ARGS[1]) : 10
out = length(ARGS) ≥ 2 ? ARGS[2] :
      normpath(joinpath(@__DIR__, "..", "..", "assets", "orbitals.bin"))

asset = bake_asset(; n_max)
mkpath(dirname(out))
write_asset(out, asset)

sz = filesize(out)
@info "Asset written" path = out size_MiB = round(sz / 2^20; digits = 2) states =
    sum(n^2 for n in 1:n_max) radial_tables = length(asset.radial) angular_tables =
    length(asset.angular)
