// =============================================================================
// SliceRenderer.cs — 2D cross-sections of ψ via shaders/slice.frag.
// =============================================================================
//
// All physics/color live in the shared GLSL; the base class uploads everything
// common. This class only adds the cutting-plane geometry.
// =============================================================================

using Hydrogen.Export.Gl;
using Hydrogen.Export.Horb;
using Hydrogen.Export.Palettes;

namespace Hydrogen.Export.Render;

/// <summary>Slice geometry: the plane is Origin + u·AxisU + v·AxisV with
/// u, v ∈ [−1, 1] (half-extent vectors, Bohr radii). Arbitrary rotated or
/// offset planes are just different vectors.</summary>
public sealed record SliceParams
{
    public required CommonParams Common { get; init; }
    public required (double x, double y, double z) Origin { get; init; }
    public required (double x, double y, double z) AxisU { get; init; }
    public required (double x, double y, double z) AxisV { get; init; }
}

public class SliceRenderer(OffscreenGl ctx, HorbAsset asset, PaletteSet palettes)
    : OrbitalRenderer(ctx, asset, palettes, "slice.frag")
{
    /// <summary>Render one slice; returns top-down RGBA8 bytes.</summary>
    public byte[] Render(SliceParams p)
    {
        UploadSlice(p);
        return DrawAndRead(p.Common.Width, p.Common.Height);
    }

    /// <summary>Render one slice into a framebuffer the caller owns and keeps;
    /// no allocation, no readback. The interop entry point.</summary>
    public void RenderInto(uint framebuffer, SliceParams p)
    {
        UploadSlice(p);
        DrawInto(framebuffer, p.Common.Width, p.Common.Height);
    }

    /// <summary>Bind the program and upload every uniform a slice needs,
    /// without drawing.</summary>
    protected void UploadSlice(SliceParams p)
    {
        UploadCommon(p.Common);
        var gl = Ctx.Gl;
        gl.Uniform3(Loc("uOrigin"), (float)p.Origin.x, (float)p.Origin.y, (float)p.Origin.z);
        gl.Uniform3(Loc("uAxisU"), (float)p.AxisU.x, (float)p.AxisU.y, (float)p.AxisU.z);
        gl.Uniform3(Loc("uAxisV"), (float)p.AxisV.x, (float)p.AxisV.y, (float)p.AxisV.z);
    }
}
