# =============================================================================
# asset.jl — the binary asset every renderer host loads.
# =============================================================================
#
# One file carries everything the GPU side needs for all states up to n_max:
# radial tables, angular tables, and display statistics. Both the C# export
# host and the TypeScript web demo implement this same tiny reader; the Julia
# reader below is the reference implementation (and powers the round-trip test).
#
# Format ("HORB" v1), little-endian throughout:
#
#   bytes 0..3    magic "HORB"
#   bytes 4..7    UInt32 format version (= 1)
#   bytes 8..11   UInt32 header length H (bytes of UTF-8 JSON)
#   bytes 12..12+H-1   JSON header (schema below)
#   remaining     one contiguous Float32[] blob; all tables concatenated
#
# JSON header schema:
#   {
#     "n_max":            int,
#     "radial_samples":   int,        // samples per radial table
#     "angular_samples":  int,        // samples per angular table
#     "extent":           {"factor": f, "pad": f},   // r_max = factor·n² + pad
#     "radial_tables":  [ {"n","l","r_max","offset"} ... ],   // one per (n,l), l<n
#     "angular_tables": [ {"l","m","offset"} ... ],           // one per (l,m), 0≤m≤l
#     "stats":          [ {"n","l","m","mode","max","q999","q9999"} ... ]
#   }
# `offset` counts Float32 elements (not bytes) from the start of the blob.
# Sample-point mappings are fixed by the format (radial: uniform in √(r/r_max);
# angular: uniform in θ) — see tables.jl — so readers need no extra metadata.
# =============================================================================

using JSON3

"Magic bytes + version identifying the format."
const ASSET_MAGIC = b"HORB"
const ASSET_VERSION = UInt32(1)

"""
Everything in one baked asset, as read back by `read_asset`. `radial[(n,l)]`
and `angular[(l,m)]` are dictionaries for direct lookup; `stats[(n,l,m,mode)]`
uses `mode::Symbol` ∈ (:real, :complex) with m = |m|.
"""
struct OrbitalAsset
    n_max::Int
    radial_samples::Int
    angular_samples::Int
    radial::Dict{Tuple{Int,Int},RadialTable}
    angular::Dict{Tuple{Int,Int},AngularTable}
    stats::Dict{Tuple{Int,Int,Int,Symbol},DisplayStats}
end

"""
    bake_asset(; n_max, radial_samples, angular_samples, verbose) -> OrbitalAsset

Bake every table and statistic for all states with n ≤ n_max. BigFloat table
evaluation is embarrassingly parallel, so tables and stats are baked on all
available threads.
"""
function bake_asset(; n_max::Int, radial_samples::Int = 8192,
                    angular_samples::Int = 4096, verbose::Bool = true)
    n_max ≥ 1 || throw(ArgumentError("n_max must be ≥ 1"))

    # Enumerate the independent work items up front, then fan out.
    rad_keys = [(n, l) for n in 1:n_max for l in 0:(n - 1)]
    ang_keys = [(l, m) for l in 0:(n_max - 1) for m in 0:l]
    stat_keys = [(n, l, m, mode) for n in 1:n_max for l in 0:(n - 1)
                 for m in 0:l for mode in (:real, :complex)]

    verbose && @info "Baking asset" n_max radial_tables = length(rad_keys) angular_tables =
        length(ang_keys) stats = length(stat_keys) threads = Threads.nthreads()

    # Stats first: each radial table's extent (safe_clip_radius) needs its
    # state's q999, so baking them in this order avoids recomputing stats.
    stat_out = Vector{DisplayStats}(undef, length(stat_keys))
    t = @elapsed begin
        Threads.@threads for i in eachindex(stat_keys)
            n, l, m, mode = stat_keys[i]
            stat_out[i] = display_stats(n, l, m, mode === :real)
        end
    end
    verbose && @info "Display stats computed" seconds = round(t; digits = 1)
    stats = Dict((s.n, s.l, s.m, s.real_mode ? :real : :complex) => s
                 for s in stat_out)

    rad_out = Vector{RadialTable}(undef, length(rad_keys))
    t = @elapsed begin
        Threads.@threads for i in eachindex(rad_keys)
            n, l = rad_keys[i]
            rmax = safe_clip_radius(n, l; q999 = stats[(n, l, 0, :real)].q999)
            rad_out[i] = bake_radial(n, l, radial_samples; r_max = rmax)
        end
    end
    verbose && @info "Radial tables baked" seconds = round(t; digits = 1)

    ang_out = Vector{AngularTable}(undef, length(ang_keys))
    t = @elapsed begin
        Threads.@threads for i in eachindex(ang_keys)
            ang_out[i] = bake_angular(ang_keys[i]..., angular_samples)
        end
    end
    verbose && @info "Angular tables baked" seconds = round(t; digits = 1)

    return OrbitalAsset(n_max, radial_samples, angular_samples,
                        Dict((t.n, t.l) => t for t in rad_out),
                        Dict((t.l, t.m) => t for t in ang_out),
                        stats)
end

"""
    write_asset(path, asset::OrbitalAsset)

Serialize to the HORB v1 format. Tables are written in deterministic key order
so identical bakes produce byte-identical files (nice for git and for caching).
"""
function write_asset(path::AbstractString, asset::OrbitalAsset)
    rad_keys = sort!(collect(keys(asset.radial)))
    ang_keys = sort!(collect(keys(asset.angular)))
    stat_keys = sort!(collect(keys(asset.stats)); by = k -> (k[1], k[2], k[3], String(k[4])))

    # Lay out the blob: radial tables first, then angular; record offsets.
    offset = 0
    rad_meta = map(rad_keys) do k
        tab = asset.radial[k]
        entry = (; n = tab.n, l = tab.l, r_max = tab.r_max, offset)
        offset += length(tab.values)
        entry
    end
    ang_meta = map(ang_keys) do k
        tab = asset.angular[k]
        entry = (; l = tab.l, m = tab.m, offset)
        offset += length(tab.values)
        entry
    end
    stat_meta = map(stat_keys) do k
        s = asset.stats[k]
        (; n = s.n, l = s.l, m = s.m, mode = s.real_mode ? "real" : "complex",
         max = s.max_density, q999 = s.q999, q9999 = s.q9999)
    end

    header = JSON3.write((; n_max = asset.n_max,
                          radial_samples = asset.radial_samples,
                          angular_samples = asset.angular_samples,
                          extent = (; factor = EXTENT_FACTOR, pad = EXTENT_PAD),
                          radial_tables = rad_meta,
                          angular_tables = ang_meta,
                          stats = stat_meta))

    open(path, "w") do io
        write(io, ASSET_MAGIC)
        write(io, htol(ASSET_VERSION))
        write(io, htol(UInt32(sizeof(header))))
        write(io, header)
        for k in rad_keys
            write(io, htol.(asset.radial[k].values))
        end
        for k in ang_keys
            write(io, htol.(asset.angular[k].values))
        end
    end
    return path
end

"""
    read_asset(path) -> OrbitalAsset

Reference reader for HORB v1 (mirrors what the C#/TypeScript loaders do).
"""
function read_asset(path::AbstractString)
    open(path, "r") do io
        read(io, 4) == ASSET_MAGIC || error("not a HORB asset: bad magic")
        version = ltoh(read(io, UInt32))
        version == ASSET_VERSION || error("unsupported HORB version $version")
        header = JSON3.read(read(io, ltoh(read(io, UInt32))))
        blob = reinterpret(Float32, read(io))
        ltoh.(blob)   # no-op on little-endian hosts

        nrad = header.radial_samples
        nang = header.angular_samples
        take(offset, count) = Vector{Float32}(blob[(offset + 1):(offset + count)])

        radial = Dict((t.n, t.l) => RadialTable(t.n, t.l, t.r_max, take(t.offset, nrad))
                      for t in header.radial_tables)
        angular = Dict((t.l, t.m) => AngularTable(t.l, t.m, take(t.offset, nang))
                       for t in header.angular_tables)
        stats = Dict((s.n, s.l, s.m, Symbol(s.mode)) =>
                         DisplayStats(s.n, s.l, s.m, s.mode == "real",
                                      s.max, s.q999, s.q9999)
                     for s in header.stats)
        return OrbitalAsset(header.n_max, nrad, nang, radial, angular, stats)
    end
end
