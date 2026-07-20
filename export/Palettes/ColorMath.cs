// =============================================================================
// ColorMath.cs — sRGB↔OKLab conversion + the custom-ramp codec.
// =============================================================================
//
// Mirrors web/lib/color.ts (Björn Ottosson's OKLab constants, also duplicated
// in shaders/common.glsl and lab/src/color.jl). Used to turn the web palette
// editor's `rampStops=hex@pos,…` codec into a Ramp with stops in both spaces,
// exactly like the baked palettes.json entries.
// =============================================================================

using System.Globalization;

namespace Hydrogen.Export.Palettes;

public static class ColorMath
{
    public static float[] SrgbToOklab(float r, float g, float b)
    {
        static double Lin(double c) =>
            c <= 0.04045 ? c / 12.92 : Math.Pow((c + 0.055) / 1.055, 2.4);
        double rl = Lin(r), gl = Lin(g), bl = Lin(b);
        double l = Math.Cbrt(0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl);
        double m = Math.Cbrt(0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl);
        double s = Math.Cbrt(0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl);
        return
        [
            (float)(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s),
            (float)(1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s),
            (float)(0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s),
        ];
    }

    /// <summary>Parse "hex@pos,hex@pos,…" (hex without '#', pos ∈ [0,1]) into
    /// a Ramp carrying both sRGB and OKLab stops, sorted by position.</summary>
    public static Ramp ParseRampStops(string spec)
    {
        var entries = spec.Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(part =>
            {
                string[] halves = part.Split('@');
                if (halves.Length != 2 || halves[0].TrimStart('#').Length != 6)
                    throw new ArgumentException($"bad ramp stop '{part}' (want hex@pos)");
                int v = int.Parse(halves[0].TrimStart('#'), NumberStyles.HexNumber);
                float pos = float.Parse(halves[1], CultureInfo.InvariantCulture);
                var srgb = new[] { ((v >> 16) & 0xff) / 255f, ((v >> 8) & 0xff) / 255f,
                                   (v & 0xff) / 255f };
                return (pos: Math.Clamp(pos, 0f, 1f), srgb);
            })
            .OrderBy(e => e.pos)
            .ToArray();
        if (entries.Length is < 2 or > 8)
            throw new ArgumentException("custom ramp needs 2–8 stops");
        return new Ramp(
            entries.Select(e => e.pos).ToArray(),
            entries.Select(e => e.srgb).ToArray(),
            entries.Select(e => SrgbToOklab(e.srgb[0], e.srgb[1], e.srgb[2])).ToArray());
    }
}
