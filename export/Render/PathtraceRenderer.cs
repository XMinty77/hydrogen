// =============================================================================
// PathtraceRenderer.cs — progressive volumetric path tracing for stills, via
// shaders/pathtrace.frag + shaders/display.frag.
// =============================================================================
//
// The C# twin of the web host's accumulation pipeline: two RGBA32F targets
// ping-pong per sample pass (read previous sum, write previous + new sample;
// count rides in alpha), then display.frag resolves the running mean through
// exposure + tonemap + dither into the RGBA8 readback target. Offline there
// is no interactivity to worry about, so Render simply loops Spp passes.
// =============================================================================

using Hydrogen.Export.Gl;
using Hydrogen.Export.Horb;
using Hydrogen.Export.Palettes;
using Silk.NET.OpenGL;

namespace Hydrogen.Export.Render;

public sealed record PathtraceParams
{
    public required CommonParams Common { get; init; }
    public required (double x, double y, double z) CamPos { get; init; }
    public required (double x, double y, double z) CamRight { get; init; }
    public required (double x, double y, double z) CamUp { get; init; }
    public required (double x, double y, double z) CamFwd { get; init; }
    public double FovYDeg { get; init; } = 40.0;
    public int Tonemap { get; init; } = 0;
    public double ExposureEv { get; init; } = 0.0;
    /// <summary>Samples per pixel to accumulate (one pass each).</summary>
    public int Spp { get; init; } = 64;

    public double DensityScale { get; init; } = 5.0;
    public double OpacityPow { get; init; } = 2.15;
    public double EmissionGain { get; init; } = 6.7;
    public double LightAzDeg { get; init; } = -30.0;
    public double LightElDeg { get; init; } = 50.0;
    public double LightGain { get; init; } = 6.0;
    public double HgG { get; init; } = 0.35;
    public int MaxBounces { get; init; } = 4;
    public double Albedo { get; init; } = 0.85;
    /// <summary>0 white scattering … 1 palette-colored multiple scattering.</summary>
    public double ScatterTint { get; init; } = 0.7;
    /// <summary>Thin-lens aperture radius, world a₀ (0 = pinhole).</summary>
    public double Aperture { get; init; } = 0.0;
    /// <summary>Focal distance along the view axis, world a₀.</summary>
    public double FocusDist { get; init; } = 1.0;
    /// <summary>0 black, 1 uniform, 2 studio, 3 hue sphere, 4 checker.</summary>
    public int EnvMode { get; init; } = 0;
    public double EnvGain { get; init; } = 1.0;
    public IReadOnlyList<(double nx, double ny, double nz, double d)> ClipPlanes { get; init; } =
        Array.Empty<(double, double, double, double)>();
}

/// <remarks>
/// Alone among the view renderers this one has no RenderInto: its Render is a
/// multi-pass accumulation over two RGBA32F ping-pong targets allocated per
/// call, and the useful interop shape for it is progressive — accumulate across
/// calls and let the host resolve when it wants a frame — not one-shot. That is
/// a different change from adding an entry point, so it is not made here.
/// </remarks>
public sealed class PathtraceRenderer : OrbitalRenderer
{
    private readonly uint _displayProgram;

    public PathtraceRenderer(OffscreenGl ctx, HorbAsset asset, PaletteSet palettes)
        : base(ctx, asset, palettes, "pathtrace.frag")
    {
        _displayProgram = ctx.CreateProgram("fullscreen.vert", "display.frag");
    }

    /// <summary>Accumulate Spp sample passes and resolve; returns top-down
    /// RGBA8 bytes.</summary>
    public byte[] Render(PathtraceParams p)
    {
        var gl = Ctx.Gl;
        int w = p.Common.Width, h = p.Common.Height;

        // The sample passes must not dither (they write HDR sums; the display
        // resolve dithers the 8-bit output instead).
        UploadCommon(p.Common with { Dither = false });
        UploadCamera(p.CamPos, p.CamRight, p.CamUp, p.CamFwd, p.FovYDeg,
                     (double)w / h, p.Tonemap, p.ExposureEv, p.ClipPlanes);
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
        gl.Uniform1(Loc("uMaxBounces"), p.MaxBounces);
        gl.Uniform1(Loc("uAlbedo"), (float)p.Albedo);
        gl.Uniform1(Loc("uScatterTint"), (float)p.ScatterTint);
        gl.Uniform1(Loc("uAperture"), (float)p.Aperture);
        gl.Uniform1(Loc("uFocusDist"), (float)p.FocusDist);
        gl.Uniform1(Loc("uEnvMode"), p.EnvMode);
        gl.Uniform1(Loc("uEnvGain"), (float)p.EnvGain);
        gl.Uniform1(Loc("uSppFrame"), 1);
        gl.Uniform2(Loc("uResolution"), (float)w, (float)h);

        // Accumulation ping-pong. Fresh desktop-GL textures hold garbage
        // (unlike WebGL's zero-fill), so clear both before the first pass.
        var (fboA, texA) = Ctx.CreateFloatRenderTarget(w, h);
        var (fboB, texB) = Ctx.CreateFloatRenderTarget(w, h);
        foreach (uint fbo in new[] { fboA, fboB })
        {
            gl.BindFramebuffer(FramebufferTarget.Framebuffer, fbo);
            gl.ClearColor(0f, 0f, 0f, 0f);
            gl.Clear(ClearBufferMask.ColorBufferBit);
        }

        gl.Viewport(0, 0, (uint)w, (uint)h);
        (uint fbo, uint tex) read = (fboA, texA), write = (fboB, texB);
        for (int frame = 0; frame < p.Spp; frame++)
        {
            gl.UseProgram(Program);
            gl.BindFramebuffer(FramebufferTarget.Framebuffer, write.fbo);
            gl.ActiveTexture(TextureUnit.Texture5);
            gl.BindTexture(TextureTarget.Texture2D, read.tex);
            gl.Uniform1(Loc("uPrevAccum"), 5);
            gl.Uniform1(Loc("uFrameIndex"), frame);
            gl.DrawArrays(PrimitiveType.Triangles, 0, 3);
            (read, write) = (write, read);
        }

        // Resolve the mean to RGBA8 (display.frag divides by the sample count).
        gl.UseProgram(_displayProgram);
        int DLoc(string name) => gl.GetUniformLocation(_displayProgram, name);
        gl.ActiveTexture(TextureUnit.Texture5);
        gl.BindTexture(TextureTarget.Texture2D, read.tex);
        gl.Uniform1(DLoc("uAccum"), 5);
        gl.Uniform1(DLoc("uTonemap"), p.Tonemap);
        gl.Uniform1(DLoc("uExposure"), (float)p.ExposureEv);
        gl.Uniform1(DLoc("uDitherAmp"), p.Common.Dither ? 1.0f / 255.0f : 0.0f);
        var (outFbo, outTex) = Ctx.CreateRenderTarget(w, h);
        gl.Viewport(0, 0, (uint)w, (uint)h);
        gl.DrawArrays(PrimitiveType.Triangles, 0, 3);
        var pixels = Ctx.ReadPixelsTopDown(w, h);

        gl.BindFramebuffer(FramebufferTarget.Framebuffer, 0);
        gl.DeleteFramebuffer(outFbo);
        gl.DeleteTexture(outTex);
        gl.DeleteFramebuffer(fboA);
        gl.DeleteFramebuffer(fboB);
        gl.DeleteTexture(texA);
        gl.DeleteTexture(texB);
        return pixels;
    }

    /// <inheritdoc/>
    public override void Dispose()
    {
        Ctx.Gl.DeleteProgram(_displayProgram);
        base.Dispose();
    }
}
