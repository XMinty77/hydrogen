// =============================================================================
// VolumeRenderer.cs — 3D volumetric renders of ψ via shaders/volume.frag.
// =============================================================================
//
// Covers the raymarched integrator family: 0 MIP, 1 emission–absorption,
// 2 anisotropic ambient multi-scattering, 3 MIDA, 4 emissive isosurfaces —
// plus the optional local-illumination overlay (uShade*). The progressive
// path tracer and the eikonal renderer have their own classes (same shared
// upload machinery, different view shaders).
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
    /// <summary>0 MIP, 1 emission–absorption, 2 ambient multi-scattering,
    /// 3 MIDA, 4 emissive isosurfaces.</summary>
    public int Integrator { get; init; } = 0;
    /// <summary>Ray samples inside the domain. 600 is clean at 1–2K preview;
    /// push into the thousands for supersampled stills.</summary>
    public int Steps { get; init; } = 600;
    // EA transfer defaults below are the user-tuned values (2026-07-19, found
    // interactively in the web demo).
    /// <summary>Emission–absorption extinction: optical depth per domain
    /// radius at unit brightness.</summary>
    public double DensityScale { get; init; } = 5.0;
    /// <summary>Opacity curve exponent (see uOpacityPow in volume.frag).</summary>
    public double OpacityPow { get; init; } = 2.15;
    /// <summary>Emission multiplier; dense cores bloom toward white.</summary>
    public double EmissionGain { get; init; } = 6.7;
    /// <summary>0 = plain linearToSrgb clamp, 1 = AgX filmic.</summary>
    public int Tonemap { get; init; } = 0;
    public double ExposureEv { get; init; } = 0.0;

    // --- key light (scatter, shading overlay, lit isosurfaces) ---------------
    public double LightAzDeg { get; init; } = -30.0;
    public double LightElDeg { get; init; } = 50.0;
    public double LightGain { get; init; } = 6.0;
    /// <summary>Henyey–Greenstein anisotropy g ∈ (−1, 1); 0 isotropic.</summary>
    public double HgG { get; init; } = 0.35;

    // --- multi-scattering (integrator 2) -------------------------------------
    public int ShadowSteps { get; init; } = 24;
    public double ShadowDensity { get; init; } = 120.0;
    /// <summary>Wrenninge octaves along the one shadow ray.</summary>
    public int Octaves { get; init; } = 3;
    public double OctaveGain { get; init; } = 0.5;
    public double OctaveExt { get; init; } = 0.4;
    /// <summary>Fibonacci-direction ambient-occlusion field.</summary>
    public double AmbientGain { get; init; } = 2.0;
    public int AmbientDirs { get; init; } = 6;
    public double AmbientRadius { get; init; } = 0.25;
    public double AmbientDensity { get; init; } = 250.0;

    // --- MIDA (integrator 3) -------------------------------------------------
    /// <summary>γ ∈ [−1, 1]: −1 plain EA … 0 MIDA … +1 MIP.</summary>
    public double MidaGamma { get; init; } = 0.0;

    // --- emissive isosurfaces (integrator 4) ---------------------------------
    public double IsoLevel { get; init; } = 0.5;
    public int IsoCount { get; init; } = 3;
    public double IsoSpacing { get; init; } = 0.5;
    public double IsoAlpha { get; init; } = 0.4;
    public double IsoEmission { get; init; } = 2.5;
    public double IsoRim { get; init; } = 1.5;

    // --- local illumination overlay ------------------------------------------
    /// <summary>0 off, 1 Lambert, 2 Blinn–Phong, 3 GGX/Fresnel.</summary>
    public int ShadeModel { get; init; } = 0;
    public double ShadeDiffuse { get; init; } = 0.5;
    public double ShadeSpec { get; init; } = 2.0;
    public double ShadeRough { get; init; } = 0.3;
    public double ShadeF0 { get; init; } = 0.05;
    public double ShadeConf { get; init; } = 1.5;
    /// <summary>Finite-difference half-step, fraction of rMax.</summary>
    public double GradDelta { get; init; } = 0.004;

    /// <summary>Up to two world-space half-spaces (nx, ny, nz, d); the kept
    /// side satisfies n·p + d ≥ 0.</summary>
    public IReadOnlyList<(double nx, double ny, double nz, double d)> ClipPlanes { get; init; } =
        Array.Empty<(double, double, double, double)>();
}

public sealed class VolumeRenderer(OffscreenGl ctx, HorbAsset asset, PaletteSet palettes)
    : OrbitalRenderer(ctx, asset, palettes, "volume.frag")
{
    /// <summary>Render one volumetric frame; returns top-down RGBA8 bytes.</summary>
    public byte[] Render(VolumeParams p)
    {
        UploadCommon(p.Common);
        UploadCamera(p.CamPos, p.CamRight, p.CamUp, p.CamFwd, p.FovYDeg,
                     (double)p.Common.Width / p.Common.Height,
                     p.Tonemap, p.ExposureEv, p.ClipPlanes);
        var gl = Ctx.Gl;
        gl.Uniform1(Loc("uIntegrator"), p.Integrator);
        gl.Uniform1(Loc("uSteps"), p.Steps);
        gl.Uniform1(Loc("uDensityScale"), (float)p.DensityScale);
        gl.Uniform1(Loc("uOpacityPow"), (float)p.OpacityPow);
        gl.Uniform1(Loc("uEmissionGain"), (float)p.EmissionGain);

        double laz = p.LightAzDeg * Math.PI / 180, lel = p.LightElDeg * Math.PI / 180;
        gl.Uniform3(Loc("uLightDir"),
            (float)(Math.Cos(lel) * Math.Cos(laz)),
            (float)(Math.Cos(lel) * Math.Sin(laz)),
            (float)Math.Sin(lel));
        gl.Uniform1(Loc("uLightGain"), (float)p.LightGain);
        gl.Uniform1(Loc("uHgG"), (float)p.HgG);
        gl.Uniform1(Loc("uShadowSteps"), p.ShadowSteps);
        gl.Uniform1(Loc("uShadowDensity"), (float)p.ShadowDensity);
        gl.Uniform1(Loc("uOctaves"), p.Octaves);
        gl.Uniform1(Loc("uOctaveGain"), (float)p.OctaveGain);
        gl.Uniform1(Loc("uOctaveExt"), (float)p.OctaveExt);
        gl.Uniform1(Loc("uAmbientGain"), (float)p.AmbientGain);
        gl.Uniform1(Loc("uAmbientDirs"), p.AmbientDirs);
        gl.Uniform1(Loc("uAmbientRadius"), (float)p.AmbientRadius);
        gl.Uniform1(Loc("uAmbientDensity"), (float)p.AmbientDensity);

        gl.Uniform1(Loc("uMidaGamma"), (float)p.MidaGamma);

        gl.Uniform1(Loc("uIsoLevel"), (float)p.IsoLevel);
        gl.Uniform1(Loc("uIsoCount"), p.IsoCount);
        gl.Uniform1(Loc("uIsoSpacing"), (float)p.IsoSpacing);
        gl.Uniform1(Loc("uIsoAlpha"), (float)p.IsoAlpha);
        gl.Uniform1(Loc("uIsoEmission"), (float)p.IsoEmission);
        gl.Uniform1(Loc("uIsoRim"), (float)p.IsoRim);

        gl.Uniform1(Loc("uShadeModel"), p.ShadeModel);
        gl.Uniform1(Loc("uShadeDiffuse"), (float)p.ShadeDiffuse);
        gl.Uniform1(Loc("uShadeSpec"), (float)p.ShadeSpec);
        gl.Uniform1(Loc("uShadeRough"), (float)p.ShadeRough);
        gl.Uniform1(Loc("uShadeF0"), (float)p.ShadeF0);
        gl.Uniform1(Loc("uShadeConf"), (float)p.ShadeConf);
        gl.Uniform1(Loc("uGradDelta"), (float)p.GradDelta);

        return DrawAndRead(p.Common.Width, p.Common.Height);
    }
}
