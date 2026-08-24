// =============================================================================
// EikonalRenderer.cs — refraction rendering via shaders/eikonal.frag.
// =============================================================================
//
// ψ is mapped to a gradient-index medium (power or log compressive map) and
// rays are bent by the eikonal equation, with spherical environment
// illumination, absorption, palette glow, and optional chromatic dispersion.
// Uniform semantics are documented in the shader.
// =============================================================================

using Hydrogen.Export.Gl;
using Hydrogen.Export.Horb;
using Hydrogen.Export.Palettes;

namespace Hydrogen.Export.Render;

public sealed record EikonalParams
{
    public required CommonParams Common { get; init; }
    public required (double x, double y, double z) CamPos { get; init; }
    public required (double x, double y, double z) CamRight { get; init; }
    public required (double x, double y, double z) CamUp { get; init; }
    public required (double x, double y, double z) CamFwd { get; init; }
    public double FovYDeg { get; init; } = 40.0;
    public int Tonemap { get; init; } = 0;
    public double ExposureEv { get; init; } = 0.0;

    /// <summary>Curved-ray integration steps (2·rMax / Steps per Euler step).</summary>
    public int Steps { get; init; } = 300;
    /// <summary>Peak index contrast Δn (n = 1 + Δn·map(brightness)).</summary>
    public double IorScale { get; init; } = 0.25;
    /// <summary>0 power map, 1 logarithmic map.</summary>
    public int EikMap { get; init; } = 1;
    public double EikPow { get; init; } = 0.5;
    public double EikLogK { get; init; } = 10.0;
    public double Absorb { get; init; } = 1.0;
    public double Emission { get; init; } = 3.0;
    /// <summary>Per-channel Δn spread (3 traces at Δn·(1 ∓ dispersion)).</summary>
    public double Dispersion { get; init; } = 0.05;
    /// <summary>0 black, 1 uniform, 2 studio, 3 hue sphere, 4 checker.</summary>
    public int EnvMode { get; init; } = 2;
    public double EnvGain { get; init; } = 1.0;
    /// <summary>Finite-difference half-step, fraction of rMax.</summary>
    public double GradDelta { get; init; } = 0.004;
    public IReadOnlyList<(double nx, double ny, double nz, double d)> ClipPlanes { get; init; } =
        Array.Empty<(double, double, double, double)>();
}

public class EikonalRenderer(OffscreenGl ctx, HorbAsset asset, PaletteSet palettes)
    : OrbitalRenderer(ctx, asset, palettes, "eikonal.frag")
{
    /// <summary>Render one refraction frame; returns top-down RGBA8 bytes.</summary>
    public byte[] Render(EikonalParams p)
    {
        UploadEikonal(p);
        return DrawAndRead(p.Common.Width, p.Common.Height);
    }

    /// <summary>Render one refraction frame into a framebuffer the caller owns
    /// and keeps; no allocation, no readback. The interop entry point.</summary>
    public void RenderInto(uint framebuffer, EikonalParams p)
    {
        UploadEikonal(p);
        DrawInto(framebuffer, p.Common.Width, p.Common.Height);
    }

    /// <summary>Bind the program and upload every uniform a refraction frame
    /// needs, without drawing.</summary>
    protected void UploadEikonal(EikonalParams p)
    {
        UploadCommon(p.Common);
        UploadCamera(p.CamPos, p.CamRight, p.CamUp, p.CamFwd, p.FovYDeg,
                     (double)p.Common.Width / p.Common.Height,
                     p.Tonemap, p.ExposureEv, p.ClipPlanes);
        var gl = Ctx.Gl;
        gl.Uniform1(Loc("uSteps"), p.Steps);
        gl.Uniform1(Loc("uIorScale"), (float)p.IorScale);
        gl.Uniform1(Loc("uEikMap"), p.EikMap);
        gl.Uniform1(Loc("uEikPow"), (float)p.EikPow);
        gl.Uniform1(Loc("uEikLogK"), (float)p.EikLogK);
        gl.Uniform1(Loc("uEikAbsorb"), (float)p.Absorb);
        gl.Uniform1(Loc("uEikEmission"), (float)p.Emission);
        gl.Uniform1(Loc("uDispersion"), (float)p.Dispersion);
        gl.Uniform1(Loc("uEnvMode"), p.EnvMode);
        gl.Uniform1(Loc("uEnvGain"), (float)p.EnvGain);
        gl.Uniform1(Loc("uGradDelta"), (float)p.GradDelta);
    }
}
