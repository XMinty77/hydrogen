// =============================================================================
// OrbitalRenderer.cs — shared machinery for every render pass.
// =============================================================================
//
// Both view renderers (2D slice, 3D volume) differ only in geometry uniforms;
// everything else — table textures, display-normalization stats, palette
// upload, draw + readback — is identical and lives here. Uniform semantics
// are documented in shaders/common.glsl.
// =============================================================================

using Hydrogen.Export.Gl;
using Hydrogen.Export.Horb;
using Hydrogen.Export.Palettes;
using Silk.NET.OpenGL;

namespace Hydrogen.Export.Render;

/// <summary>Parameters shared by every render pass: which state, how to map it
/// to brightness, and how to color it. View-specific geometry lives in the
/// derived records.</summary>
public record CommonParams
{
    public required int N { get; init; }
    public required int L { get; init; }
    public required int M { get; init; }
    public required bool RealMode { get; init; }
    /// <summary>0 ramp, 1 signed (real mode), 2 phase (complex mode).</summary>
    public required int ColorMode { get; init; }
    public required int Width { get; init; }
    public required int Height { get; init; }
    public string RampName { get; init; } = "accretion_tuned";
    /// <summary>Interpolate ramp stops in gamma sRGB (prototype reproduction)
    /// instead of OKLab.</summary>
    public bool RampSpaceSrgb { get; init; } = false;
    public double Gamma { get; init; } = 0.45;
    /// <summary>0: brightness from |ψ|² (density), 1: from |ψ| (amplitude).</summary>
    public int ValueMode { get; init; } = 0;
    public bool Dither { get; init; } = true;
    /// <summary>Phase wheel: per-hue max chroma ("vivid") vs constant chroma.
    /// Vivid + persistence 0.6 is the project default (user sign-off).</summary>
    public bool PhaseVivid { get; init; } = true;
    public double PhaseChromaPow { get; init; } = 0.6;
}

public abstract class OrbitalRenderer
{
    protected readonly OffscreenGl Ctx;
    protected readonly HorbAsset Asset;
    protected readonly PaletteSet Palettes;
    protected readonly uint Program;
    private readonly uint _phaseCmaxTex;
    private readonly Dictionary<(int n, int l), uint> _radialTex = new();
    private readonly Dictionary<(int l, int m), uint> _angularTex = new();

    protected OrbitalRenderer(OffscreenGl ctx, HorbAsset asset, PaletteSet palettes,
                              string viewFragFile)
    {
        Ctx = ctx;
        Asset = asset;
        Palettes = palettes;
        Program = ctx.CreateProgram("fullscreen.vert", viewFragFile);
        _phaseCmaxTex = ctx.CreateTableTexture(palettes.PhaseCmax);
    }

    protected int Loc(string name) => Ctx.Gl.GetUniformLocation(Program, name);

    /// <summary>Bind the state's tables and upload every common uniform.</summary>
    protected void UploadCommon(CommonParams p)
    {
        var gl = Ctx.Gl;
        gl.UseProgram(Program);

        // --- table textures (cached per state component) ---------------------
        if (!_radialTex.TryGetValue((p.N, p.L), out uint radTex))
            _radialTex[(p.N, p.L)] = radTex =
                Ctx.CreateTableTexture(Asset.Radial[(p.N, p.L)].Values);
        int am = Math.Abs(p.M);
        if (!_angularTex.TryGetValue((p.L, am), out uint angTex))
            _angularTex[(p.L, am)] = angTex =
                Ctx.CreateTableTexture(Asset.Angular[(p.L, am)].Values);

        gl.ActiveTexture(TextureUnit.Texture0);
        gl.BindTexture(TextureTarget.Texture2D, radTex);
        gl.Uniform1(Loc("uRadialTab"), 0);
        gl.ActiveTexture(TextureUnit.Texture1);
        gl.BindTexture(TextureTarget.Texture2D, angTex);
        gl.Uniform1(Loc("uAngularTab"), 1);
        gl.ActiveTexture(TextureUnit.Texture2);
        gl.BindTexture(TextureTarget.Texture2D, _phaseCmaxTex);
        gl.Uniform1(Loc("uPhaseCmaxTab"), 2);

        gl.Uniform1(Loc("uRMax"), (float)Asset.Radial[(p.N, p.L)].RMax);
        gl.Uniform1(Loc("uM"), p.M);
        gl.Uniform1(Loc("uRealMode"), p.RealMode ? 1 : 0);

        // --- display mapping -------------------------------------------------
        var stats = Asset.Stats[(p.N, p.L, am, p.RealMode)];
        gl.Uniform1(Loc("uQ999"), (float)stats.Q999);
        gl.Uniform1(Loc("uGamma"), (float)p.Gamma);
        gl.Uniform1(Loc("uValueMode"), p.ValueMode);

        // --- palette ---------------------------------------------------------
        var ramp = Palettes.Ramps[p.RampName];
        var stops = p.RampSpaceSrgb ? ramp.Srgb : ramp.Oklab;
        var flat = new float[stops.Length * 3];
        for (int i = 0; i < stops.Length; i++)
            (flat[3 * i], flat[3 * i + 1], flat[3 * i + 2]) =
                (stops[i][0], stops[i][1], stops[i][2]);
        unsafe
        {
            fixed (float* fp = flat)
                gl.Uniform3(Loc("uRampColor[0]"), (uint)stops.Length, fp);
            fixed (float* pp = ramp.Positions)
                gl.Uniform1(Loc("uRampPos[0]"), (uint)ramp.Positions.Length, pp);
        }
        gl.Uniform1(Loc("uRampN"), ramp.Positions.Length);
        gl.Uniform1(Loc("uRampSpaceSrgb"), p.RampSpaceSrgb ? 1 : 0);
        gl.Uniform1(Loc("uPhaseL"), Palettes.PhaseL);
        gl.Uniform1(Loc("uPhaseC"), Palettes.PhaseC);
        gl.Uniform1(Loc("uPhaseH0"), Palettes.PhaseH0);
        gl.Uniform1(Loc("uPhaseVivid"), p.PhaseVivid ? 1 : 0);
        gl.Uniform1(Loc("uPhaseChromaPow"), (float)p.PhaseChromaPow);
        gl.Uniform1(Loc("uDitherAmp"), p.Dither ? 1.0f / 255.0f : 0.0f);
        gl.Uniform1(Loc("uColorMode"), p.ColorMode);
    }

    /// <summary>Render the bound program into a fresh target and read it back
    /// (top-down RGBA8).</summary>
    protected byte[] DrawAndRead(int width, int height)
    {
        var gl = Ctx.Gl;
        var (fbo, tex) = Ctx.CreateRenderTarget(width, height);
        gl.Viewport(0, 0, (uint)width, (uint)height);
        gl.DrawArrays(PrimitiveType.Triangles, 0, 3);
        var pixels = Ctx.ReadPixelsTopDown(width, height);
        gl.BindFramebuffer(FramebufferTarget.Framebuffer, 0);
        gl.DeleteFramebuffer(fbo);
        gl.DeleteTexture(tex);
        return pixels;
    }
}
