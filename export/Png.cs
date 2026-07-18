// =============================================================================
// Png.cs — the host's only image-encoding surface.
// =============================================================================
//
// Every PNG the exporter writes goes through this wrapper, so the encoding
// dependency (currently SixLabors.ImageSharp 3.1.x — pinned below 4.x, whose
// build-time license gate we deliberately avoid) can be swapped by editing
// exactly one file. 16-bit output will be added here when the still-export
// pipeline needs it.
// =============================================================================

using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

namespace Hydrogen.Export;

public static class Png
{
    /// <summary>Write top-down RGBA8 bytes as a PNG.</summary>
    public static void Write(string path, byte[] rgbaTopDown, int width, int height)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        using var image = Image.LoadPixelData<Rgba32>(rgbaTopDown, width, height);
        image.SaveAsPng(path);
    }
}
