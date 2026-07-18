// =============================================================================
// PaletteSet.cs — reader for assets/palettes.json (designed in lab/scripts/
// palettes.jl). Ramps carry their stops in both sRGB and OKLab so the host can
// upload whichever space the render is configured to interpolate in.
// =============================================================================

using System.Text.Json;

namespace Hydrogen.Export.Palettes;

public sealed record Ramp(float[] Positions, float[][] Srgb, float[][] Oklab);

public sealed class PaletteSet
{
    public required Dictionary<string, Ramp> Ramps { get; init; }
    // Settable so the CLI can override the phase wheel for palette exploration.
    public required float PhaseL { get; set; }
    public required float PhaseC { get; set; }
    public required float PhaseH0 { get; set; }

    public static PaletteSet Load(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var root = doc.RootElement;

        static float[][] Vec3Array(JsonElement e) =>
            e.EnumerateArray()
             .Select(v => v.EnumerateArray().Select(x => x.GetSingle()).ToArray())
             .ToArray();

        var ramps = new Dictionary<string, Ramp>();
        foreach (var prop in root.GetProperty("ramps").EnumerateObject())
        {
            ramps[prop.Name] = new Ramp(
                prop.Value.GetProperty("positions").EnumerateArray()
                    .Select(x => x.GetSingle()).ToArray(),
                Vec3Array(prop.Value.GetProperty("srgb")),
                Vec3Array(prop.Value.GetProperty("oklab")));
        }

        var phase = root.GetProperty("phase");
        return new PaletteSet
        {
            Ramps = ramps,
            PhaseL = phase.GetProperty("L").GetSingle(),
            PhaseC = phase.GetProperty("C").GetSingle(),
            PhaseH0 = phase.GetProperty("h0").GetSingle(),
        };
    }
}
