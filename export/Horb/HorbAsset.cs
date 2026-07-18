// =============================================================================
// HorbAsset.cs — reader for the baked orbital asset (HORB v1).
// =============================================================================
//
// Mirrors the reference reader in lab/src/asset.jl. Format:
//
//   bytes 0..3   magic "HORB"
//   bytes 4..7   UInt32 version (= 1), little-endian
//   bytes 8..11  UInt32 JSON header length H
//   12..12+H-1   UTF-8 JSON header (table offsets in Float32 *elements*)
//   rest         one contiguous little-endian Float32 blob
//
// Table semantics (fixed by the format; see lab/src/tables.jl):
//   radial[(n,l)]  — R_nl sampled uniformly in √(r/r_max), r_max per table
//   angular[(l,m)] — P̄_lm sampled uniformly in θ ∈ [0, π], m = |m| ≥ 0
//   stats          — per (n, l, |m|, mode) display-normalization quantiles
// =============================================================================

using System.Text;
using System.Text.Json;

namespace Hydrogen.Export.Horb;

public sealed record RadialTable(int N, int L, double RMax, float[] Values);

public sealed record AngularTable(int L, int M, float[] Values);

/// <summary>Volume-weighted |ψ|² statistics used for display normalization.
/// Baked (rather than computed per frame) so every render of a state — any
/// cross-section, any camera, any animation frame — shares one fixed
/// normalization and nothing flickers.</summary>
public sealed record DisplayStats(int N, int L, int M, bool RealMode,
                                  double MaxDensity, double Q999, double Q9999);

public sealed class HorbAsset
{
    public required int NMax { get; init; }
    public required double ExtentFactor { get; init; }
    public required double ExtentPad { get; init; }
    public required Dictionary<(int n, int l), RadialTable> Radial { get; init; }
    public required Dictionary<(int l, int m), AngularTable> Angular { get; init; }
    public required Dictionary<(int n, int l, int m, bool real), DisplayStats> Stats { get; init; }

    /// <summary>Display/framing radius for principal quantum number n — the
    /// default half-extent for slices and camera framing. The radial tables
    /// themselves extend farther (to their per-state safe clip radius).</summary>
    public double FramingRadius(int n) => ExtentFactor * n * n + ExtentPad;

    public static HorbAsset Load(string path)
    {
        using var stream = File.OpenRead(path);
        using var reader = new BinaryReader(stream);

        if (!reader.ReadBytes(4).AsSpan().SequenceEqual("HORB"u8))
            throw new InvalidDataException($"{path}: not a HORB asset (bad magic)");
        uint version = reader.ReadUInt32();
        if (version != 1)
            throw new InvalidDataException($"{path}: unsupported HORB version {version}");

        uint headerLen = reader.ReadUInt32();
        using var header = JsonDocument.Parse(
            Encoding.UTF8.GetString(reader.ReadBytes(checked((int)headerLen))));
        var root = header.RootElement;

        // The rest of the file is one Float32 blob; slice tables out of it.
        byte[] blobBytes = reader.ReadBytes(checked((int)(stream.Length - stream.Position)));
        float[] Take(int offset, int count)
        {
            var vals = new float[count];
            Buffer.BlockCopy(blobBytes, offset * sizeof(float), vals, 0,
                             count * sizeof(float));
            return vals;
        }

        int radialSamples = root.GetProperty("radial_samples").GetInt32();
        int angularSamples = root.GetProperty("angular_samples").GetInt32();

        var radial = new Dictionary<(int, int), RadialTable>();
        foreach (var t in root.GetProperty("radial_tables").EnumerateArray())
        {
            var tab = new RadialTable(
                t.GetProperty("n").GetInt32(), t.GetProperty("l").GetInt32(),
                t.GetProperty("r_max").GetDouble(),
                Take(t.GetProperty("offset").GetInt32(), radialSamples));
            radial[(tab.N, tab.L)] = tab;
        }

        var angular = new Dictionary<(int, int), AngularTable>();
        foreach (var t in root.GetProperty("angular_tables").EnumerateArray())
        {
            var tab = new AngularTable(
                t.GetProperty("l").GetInt32(), t.GetProperty("m").GetInt32(),
                Take(t.GetProperty("offset").GetInt32(), angularSamples));
            angular[(tab.L, tab.M)] = tab;
        }

        var stats = new Dictionary<(int, int, int, bool), DisplayStats>();
        foreach (var s in root.GetProperty("stats").EnumerateArray())
        {
            var st = new DisplayStats(
                s.GetProperty("n").GetInt32(), s.GetProperty("l").GetInt32(),
                s.GetProperty("m").GetInt32(),
                s.GetProperty("mode").GetString() == "real",
                s.GetProperty("max").GetDouble(), s.GetProperty("q999").GetDouble(),
                s.GetProperty("q9999").GetDouble());
            stats[(st.N, st.L, st.M, st.RealMode)] = st;
        }

        var extent = root.GetProperty("extent");
        return new HorbAsset
        {
            NMax = root.GetProperty("n_max").GetInt32(),
            ExtentFactor = extent.GetProperty("factor").GetDouble(),
            ExtentPad = extent.GetProperty("pad").GetDouble(),
            Radial = radial,
            Angular = angular,
            Stats = stats,
        };
    }
}
