// =============================================================================
// VolumeRenderer.cs — 3D volumetric renders of ψ via shaders/volume.frag.
// =============================================================================
//
// Adds the perspective camera, integrator selection, and up to two half-space
// clip planes on top of the shared machinery. Camera vectors must be
// orthonormal (Program.cs builds them from orbit angles; the web demo will
// build them from its interactive cameras — same uniforms either way).
// =============================================================================

using Hydrogen.Export.Gl;
using Hydrogen.Export.Horb;
using Hydrogen.Export.Palettes;

namespace Hydrogen.Export.Render;

public sealed record VolumeParams
{
    public required CommonParams Common { get; init; }
    public required (double x, double y, double z) CamPos { get; init; }
    public required (double x, double y, double z) CamRight { get; init; }
    public required (double x, double y, double z) CamUp { get; init; }
    public required (double x, double y, double z) CamFwd { get; init; }
    public double FovYDeg { get; init; } = 40.0;
    /// <summary>0 MIP, 1 emission–absorption, 2 shadowed scattering (EA plus
    /// a self-shadowed directional key light — integrator 1's look is exactly
    /// recoverable by LightGain = 0).</summary>
    public int Integrator { get; init; } = 0;
    /// <summary>Ray samples inside the domain. 600 is clean at 1–2K preview;
    /// push into the thousands for supersampled stills.</summary>
    public int Steps { get; init; } = 600;
    // EA transfer defaults below are the user-tuned values (2026-07-19, found
    // interactively in the web demo; previous 300 / 2.2 / 1.6 in git history).
    // Densities beyond ~50 read as fog — useful only for bulk-structure looks.
    /// <summary>Emission–absorption extinction: optical depth per domain
    /// radius at unit brightness.</summary>
    public double DensityScale { get; init; } = 5.0;
    /// <summary>Opacity curve exponent (see uOpacityPow in volume.frag).</summary>
    public double OpacityPow { get; init; } = 2.15;
    /// <summary>Emission multiplier; dense cores bloom toward white.</summary>
    public double EmissionGain { get; init; } = 6.7;
    /// <summary>Display transform for the volumetric integrators: 0 = plain
    /// linearToSrgb clamp (the original look), 1 = AgX filmic (highlight
    /// rolloff). MIP output is LDR and unaffected.</summary>
    public int Tonemap { get; init; } = 0;
    /// <summary>Exposure in stops (2^EV) applied to the HDR accumulation
    /// before the display transform.</summary>
    public double ExposureEv { get; init; } = 0.0;
    /// <summary>Key-light direction for the scatter integrator — azimuth and
    /// elevation in degrees, the orbit camera's spherical convention.</summary>
    public double LightAzDeg { get; init; } = -30.0;
    public double LightElDeg { get; init; } = 50.0;
    /// <summary>Scattered-light gain; the glow (EmissionGain) is separate, so
    /// the emission/scatter balance is the shadow-contrast control.</summary>
    public double LightGain { get; init; } = 8.0;
    /// <summary>Samples along each shadow ray (scatter integrator).</summary>
    public int ShadowSteps { get; init; } = 24;
    /// <summary>Extinction scale for shadow rays, decoupled from
    /// DensityScale: at the tuned viewing density the medium is optically
    /// thin (the look is glow-dominated), so shadow rays reuse the same
    /// opacity curve but with their own, much larger scale — otherwise
    /// self-shadowing tops out around 10% and the key light reads as a
    /// flat brightness boost.</summary>
    public double ShadowDensity { get; init; } = 120.0;
    /// <summary>Up to two world-space half-spaces (nx, ny, nz, d); the kept
    /// side satisfies n·p + d ≥ 0. For camera-locked cutaways the host
    /// recomputes these from the camera each frame.</summary>
    public IReadOnlyList<(double nx, double ny, double nz, double d)> ClipPlanes { get; init; } =
        Array.Empty<(double, double, double, double)>();
}

public sealed class VolumeRenderer(OffscreenGl ctx, HorbAsset asset, PaletteSet palettes)
    : OrbitalRenderer(ctx, asset, palettes, "volume.frag")
{
    /// <summary>Render one volumetric frame; returns top-down RGBA8 bytes.</summary>
    public byte[] Render(VolumeParams p)
    {
        if (p.ClipPlanes.Count > 2)
            throw new ArgumentException("at most two clip planes are supported");

        UploadCommon(p.Common);
        var gl = Ctx.Gl;
        gl.Uniform3(Loc("uCamPos"), (float)p.CamPos.x, (float)p.CamPos.y, (float)p.CamPos.z);
        gl.Uniform3(Loc("uCamRight"), (float)p.CamRight.x, (float)p.CamRight.y, (float)p.CamRight.z);
        gl.Uniform3(Loc("uCamUp"), (float)p.CamUp.x, (float)p.CamUp.y, (float)p.CamUp.z);
        gl.Uniform3(Loc("uCamFwd"), (float)p.CamFwd.x, (float)p.CamFwd.y, (float)p.CamFwd.z);
        gl.Uniform1(Loc("uTanHalfFov"), (float)Math.Tan(p.FovYDeg * Math.PI / 360.0));
        gl.Uniform1(Loc("uAspect"), (float)p.Common.Width / p.Common.Height);
        gl.Uniform1(Loc("uIntegrator"), p.Integrator);
        gl.Uniform1(Loc("uSteps"), p.Steps);
        gl.Uniform1(Loc("uDensityScale"), (float)p.DensityScale);
        gl.Uniform1(Loc("uOpacityPow"), (float)p.OpacityPow);
        gl.Uniform1(Loc("uEmissionGain"), (float)p.EmissionGain);
        gl.Uniform1(Loc("uTonemap"), p.Tonemap);
        gl.Uniform1(Loc("uExposure"), (float)p.ExposureEv);
        double laz = p.LightAzDeg * Math.PI / 180, lel = p.LightElDeg * Math.PI / 180;
        gl.Uniform3(Loc("uLightDir"),
            (float)(Math.Cos(lel) * Math.Cos(laz)),
            (float)(Math.Cos(lel) * Math.Sin(laz)),
            (float)Math.Sin(lel));
        gl.Uniform1(Loc("uLightGain"), (float)p.LightGain);
        gl.Uniform1(Loc("uShadowSteps"), p.ShadowSteps);
        gl.Uniform1(Loc("uShadowDensity"), (float)p.ShadowDensity);

        var planes = new float[8];
        for (int i = 0; i < p.ClipPlanes.Count; i++)
        {
            var (nx, ny, nz, d) = p.ClipPlanes[i];
            // Normalize so the shader's signed distances are in world units.
            double len = Math.Sqrt(nx * nx + ny * ny + nz * nz);
            (planes[4 * i], planes[4 * i + 1], planes[4 * i + 2], planes[4 * i + 3]) =
                ((float)(nx / len), (float)(ny / len), (float)(nz / len), (float)(d / len));
        }
        unsafe
        {
            fixed (float* pp = planes)
                gl.Uniform4(Loc("uClipPlane[0]"), 2, pp);
        }
        gl.Uniform1(Loc("uClipCount"), p.ClipPlanes.Count);

        return DrawAndRead(p.Common.Width, p.Common.Height);
    }
}
