// =============================================================================
// SliceRenderer.cs — renders 2D cross-sections of ψ via shaders/slice.frag.
// =============================================================================
//
// One instance owns the compiled slice program and a texture cache for the
// current asset; Render() draws any state/plane/palette combination and hands
// back top-down RGBA bytes. All physics and color happen in the shared GLSL
// (shaders/common.glsl) — this class only marshals uniforms.
// =============================================================================

using Hydrogen.Export.Gl;
using Hydrogen.Export.Horb;
using Hydrogen.Export.Palettes;
using Silk.NET.OpenGL;

namespace Hydrogen.Export.Render;

/// <summary>Everything one slice render needs. World geometry: the cutting
/// plane is Origin + u·AxisU + v·AxisV with u, v ∈ [−1, 1] (AxisU/AxisV are
/// half-extent vectors, in Bohr radii).</summary>
public sealed record SliceParams
{
    public required int N { get; init; }
    public required int L { get; init; }
    public required int M { get; init; }
    public required bool RealMode { get; init; }
    /// <summary>0 ramp, 1 signed (real mode), 2 phase (complex mode).</summary>
    public required int ColorMode { get; init; }
    public required (double x, double y, double z) Origin { get; init; }
    public required (double x, double y, double z) AxisU { get; init; }
    public required (double x, double y, double z) AxisV { get; init; }
    public required int Width { get; init; }
    public required int Height { get; init; }
    public string RampName { get; init; } = "accretion_tuned";
    /// <summary>Interpolate ramp stops in OKLab (default) or gamma sRGB (the
    /// prototype's exact behavior, for comparisons).</summary>
    public bool RampSpaceSrgb { get; init; } = false;
    public double Gamma { get; init; } = 0.45;
    /// <summary>0: brightness from |ψ|² (density), 1: from |ψ| (amplitude).</summary>
    public int ValueMode { get; init; } = 0;
    public bool Dither { get; init; } = true;
}

public sealed class SliceRenderer
{
    private readonly OffscreenGl _ctx;
    private readonly HorbAsset _asset;
    private readonly PaletteSet _palettes;
    private readonly uint _program;
    private readonly Dictionary<(int n, int l), uint> _radialTex = new();
    private readonly Dictionary<(int l, int m), uint> _angularTex = new();

    public SliceRenderer(OffscreenGl ctx, HorbAsset asset, PaletteSet palettes)
    {
        _ctx = ctx;
        _asset = asset;
        _palettes = palettes;
        _program = ctx.CreateProgram("fullscreen.vert", "slice.frag");
    }

    /// <summary>Render one slice; returns top-down RGBA8 bytes.</summary>
    public byte[] Render(SliceParams p)
    {
        var gl = _ctx.Gl;

        // --- table textures (cached per state component) ---------------------
        if (!_radialTex.TryGetValue((p.N, p.L), out uint radTex))
        {
            radTex = _ctx.CreateTableTexture(_asset.Radial[(p.N, p.L)].Values);
            _radialTex[(p.N, p.L)] = radTex;
        }
        int am = Math.Abs(p.M);
        if (!_angularTex.TryGetValue((p.L, am), out uint angTex))
        {
            angTex = _ctx.CreateTableTexture(_asset.Angular[(p.L, am)].Values);
            _angularTex[(p.L, am)] = angTex;
        }

        var (fbo, targetTex) = _ctx.CreateRenderTarget(p.Width, p.Height);
        gl.Viewport(0, 0, (uint)p.Width, (uint)p.Height);
        gl.UseProgram(_program);

        int Loc(string name) => gl.GetUniformLocation(_program, name);

        // --- state + tables --------------------------------------------------
        gl.ActiveTexture(TextureUnit.Texture0);
        gl.BindTexture(TextureTarget.Texture2D, radTex);
        gl.Uniform1(Loc("uRadialTab"), 0);
        gl.ActiveTexture(TextureUnit.Texture1);
        gl.BindTexture(TextureTarget.Texture2D, angTex);
        gl.Uniform1(Loc("uAngularTab"), 1);
        gl.Uniform1(Loc("uRMax"), (float)_asset.Radial[(p.N, p.L)].RMax);
        gl.Uniform1(Loc("uM"), p.M);
        gl.Uniform1(Loc("uRealMode"), p.RealMode ? 1 : 0);

        // --- display mapping -------------------------------------------------
        var stats = _asset.Stats[(p.N, p.L, am, p.RealMode)];
        gl.Uniform1(Loc("uQ999"), (float)stats.Q999);
        gl.Uniform1(Loc("uGamma"), (float)p.Gamma);
        gl.Uniform1(Loc("uValueMode"), p.ValueMode);

        // --- palette ---------------------------------------------------------
        var ramp = _palettes.Ramps[p.RampName];
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
        gl.Uniform1(Loc("uPhaseL"), _palettes.PhaseL);
        gl.Uniform1(Loc("uPhaseC"), _palettes.PhaseC);
        gl.Uniform1(Loc("uPhaseH0"), _palettes.PhaseH0);
        gl.Uniform1(Loc("uDitherAmp"), p.Dither ? 1.0f / 255.0f : 0.0f);

        // --- plane geometry --------------------------------------------------
        gl.Uniform3(Loc("uOrigin"), (float)p.Origin.x, (float)p.Origin.y, (float)p.Origin.z);
        gl.Uniform3(Loc("uAxisU"), (float)p.AxisU.x, (float)p.AxisU.y, (float)p.AxisU.z);
        gl.Uniform3(Loc("uAxisV"), (float)p.AxisV.x, (float)p.AxisV.y, (float)p.AxisV.z);
        gl.Uniform1(Loc("uColorMode"), p.ColorMode);

        // --- draw + read back ------------------------------------------------
        gl.DrawArrays(PrimitiveType.Triangles, 0, 3);
        var pixels = _ctx.ReadPixelsTopDown(p.Width, p.Height);

        gl.BindFramebuffer(FramebufferTarget.Framebuffer, 0);
        gl.DeleteFramebuffer(fbo);
        gl.DeleteTexture(targetTex);
        return pixels;
    }
}
