// =============================================================================
// OrbitalRenderer.cs — shared machinery for every render pass.
// =============================================================================
//
// The view renderers (2D slice, 3D volume, path tracer, eikonal) differ only
// in geometry/integration uniforms; everything else — table textures, display
// normalization, palettes, superposition state, camera upload, draw + readback
// — is identical and lives here. Uniform semantics are documented once, in
// shaders/common.glsl.
// =============================================================================

using Hydrogen.Export.Gl;
using Hydrogen.Export.Horb;
using Hydrogen.Export.Palettes;
using Silk.NET.OpenGL;

namespace Hydrogen.Export.Render;

/// <summary>One superposition term c·|n,l,m⟩ (amplitude + phase in degrees).
/// Mirrors lib/superposition.ts in the web host.</summary>
public readonly record struct SuperTerm(int N, int L, int M, double Amp, double PhaseDeg)
{
    /// <summary>Bound-state energy Eₙ = −1/(2n²), hartree.</summary>
    public double Energy => -0.5 / ((double)N * N);

    /// <summary>Parse "n,l,m[,amp[,phaseDeg]];…" (the web's `terms=` codec).</summary>
    public static List<SuperTerm> ParseList(string spec)
    {
        var terms = new List<SuperTerm>();
        foreach (string part in spec.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            double[] v = part.Split(',').Select(double.Parse).ToArray();
            if (v.Length < 3) throw new ArgumentException($"bad term '{part}'");
            terms.Add(new SuperTerm((int)v[0], (int)v[1], (int)v[2],
                                    v.Length > 3 ? v[3] : 1.0,
                                    v.Length > 4 ? v[4] : 0.0));
        }
        if (terms.Count is < 1 or > 8)
            throw new ArgumentException("superposition needs 1–8 terms");
        return terms;
    }
}

/// <summary>Parameters shared by every render pass: which state (or
/// superposition), how to map it to brightness, and how to color it.
/// View-specific geometry lives in the derived records.</summary>
public record CommonParams
{
    public required int N { get; init; }
    public required int L { get; init; }
    public required int M { get; init; }
    public required bool RealMode { get; init; }
    /// <summary>0 ramp, 1 signed, 2 phase, 3 palette-relative phase.</summary>
    public required int ColorMode { get; init; }
    public required int Width { get; init; }
    public required int Height { get; init; }

    /// <summary>Superposition terms; empty ⇒ the certified single-state path.
    /// The time factor e^{−iEₙ·TimeAu} is folded into the coefficients.</summary>
    public IReadOnlyList<SuperTerm> Terms { get; init; } = Array.Empty<SuperTerm>();
    /// <summary>Scale coefficients to unit Σ|c|² (the web default).</summary>
    public bool SuperNormalize { get; init; } = true;
    /// <summary>Simulated time, atomic units.</summary>
    public double TimeAu { get; init; } = 0.0;

    public string RampName { get; init; } = "accretion_tuned";
    /// <summary>User-supplied ramp used when RampName == "custom"
    /// (--ramp-stops hex@pos,… — the web palette editor's URL codec).</summary>
    public Ramp? CustomRamp { get; init; } = null;
    /// <summary>Interpolate ramp stops in gamma sRGB instead of OKLab.</summary>
    public bool RampSpaceSrgb { get; init; } = false;
    public double Gamma { get; init; } = 0.45;
    /// <summary>0: brightness from |ψ|² (density), 1: from |ψ| (amplitude).</summary>
    public int ValueMode { get; init; } = 0;
    /// <summary>Range compression before gamma: 0 off, 1 log, 2 asinh.</summary>
    public int CompressMode { get; init; } = 0;
    public double CompressK { get; init; } = 20.0;
    /// <summary>Value in q999 multiples that maps to display white.</summary>
    public double CompressWhite { get; init; } = 1.0;
    public bool Dither { get; init; } = true;
    /// <summary>Phase wheel: per-hue max chroma ("vivid") vs constant chroma.
    /// Vivid + persistence 0.6 is the project default.</summary>
    public bool PhaseVivid { get; init; } = true;
    public double PhaseChromaPow { get; init; } = 0.6;
    public bool OkPhaseSigned { get; init; } = false;
}

public abstract class OrbitalRenderer : IDisposable
{
    protected readonly OffscreenGl Ctx;
    protected readonly HorbAsset Asset;
    protected readonly PaletteSet Palettes;
    protected readonly uint Program;
    private readonly uint _phaseCmaxTex;
    private readonly Dictionary<(int n, int l), uint> _radialTex = new();
    private readonly Dictionary<(int l, int m), uint> _angularTex = new();

    // Superposition row textures (one term per row) + their content key.
    private uint _supRadialTex;
    private uint _supAngularTex;
    private string _supKey = "";
    private readonly double[] _supRMax = new double[8];

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

    /// <summary>The linked location of a uniform in this renderer's program, or
    /// −1 when the linker eliminated it.</summary>
    /// <remarks>
    /// Public so a host can audit the uniforms it drives. glUniform*(−1, …) is a
    /// specified silent no-op, so a uniform dropped by a shader edit becomes a
    /// dead control with no error and an image that still looks plausible —
    /// which, with ~80 uniforms declared across prelude + common + a view
    /// shader, is the most likely way this renderer goes quietly wrong. Some
    /// uniforms are legitimately dead in some configurations, so this reports
    /// rather than throws; deciding which absences matter is the caller's.
    /// </remarks>
    public int UniformLocation(string name) => Loc(name);

    /// <summary>Framing radius covering the state — or every superposition
    /// term (drives cameras/extents exactly like the web host).</summary>
    public double Framing(CommonParams p) =>
        p.Terms.Count > 0 ? p.Terms.Max(t => Asset.FramingRadius(t.N))
                          : Asset.FramingRadius(p.N);

    /// <summary>Bind the state's tables and upload every common uniform.</summary>
    protected void UploadCommon(CommonParams p)
    {
        var gl = Ctx.Gl;
        gl.UseProgram(Program);

        // --- single-state table textures (cached per state component) --------
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

        gl.Uniform1(Loc("uM"), p.M);
        gl.Uniform1(Loc("uRealMode"), p.RealMode ? 1 : 0);

        // --- superposition ---------------------------------------------------
        double rMax = Asset.Radial[(p.N, p.L)].RMax;
        var stats = Asset.Stats[(p.N, p.L, am, p.RealMode)];
        double q999 = stats.Q999;
        int termCount = Math.Min(p.Terms.Count, 8);
        if (termCount > 0)
        {
            EnsureSuperTextures(p.Terms);
            gl.ActiveTexture(TextureUnit.Texture3);
            gl.BindTexture(TextureTarget.Texture2D, _supRadialTex);
            gl.Uniform1(Loc("uSupRadialTab"), 3);
            gl.ActiveTexture(TextureUnit.Texture4);
            gl.BindTexture(TextureTarget.Texture2D, _supAngularTex);
            gl.Uniform1(Loc("uSupAngularTab"), 4);

            // c_k(t) = norm·amp·e^{i(φ₀ − E·t)}; q999 = Σ|c|²-weighted quantile;
            // domain = max term extent (mirror of lib/superposition.ts).
            double sumA2 = p.Terms.Sum(t => t.Amp * t.Amp);
            double scale = p.SuperNormalize && sumA2 > 0 ? 1.0 / Math.Sqrt(sumA2) : 1.0;
            var mArr = new int[8];
            var rMaxArr = new float[8];
            var coef = new float[16];
            rMax = 0;
            q999 = 0;
            for (int k = 0; k < termCount; k++)
            {
                var t = p.Terms[k];
                double phase = t.PhaseDeg * Math.PI / 180.0 - t.Energy * p.TimeAu;
                coef[2 * k] = (float)(scale * t.Amp * Math.Cos(phase));
                coef[2 * k + 1] = (float)(scale * t.Amp * Math.Sin(phase));
                mArr[k] = t.M;
                rMaxArr[k] = (float)_supRMax[k];
                rMax = Math.Max(rMax, _supRMax[k]);
                double w = scale * scale * t.Amp * t.Amp;
                q999 += w * Asset.Stats[(t.N, t.L, Math.Abs(t.M), p.RealMode)].Q999;
            }
            if (q999 <= 0) q999 = 1;
            unsafe
            {
                fixed (int* mp = mArr) gl.Uniform1(Loc("uSupM[0]"), 8, mp);
                fixed (float* rp = rMaxArr) gl.Uniform1(Loc("uSupRMax[0]"), 8, rp);
                fixed (float* cp = coef) gl.Uniform2(Loc("uSupCoef[0]"), 8, cp);
            }
        }
        gl.Uniform1(Loc("uSupCount"), termCount);
        gl.Uniform1(Loc("uRMax"), (float)rMax);

        // --- display mapping -------------------------------------------------
        gl.Uniform1(Loc("uQ999"), (float)q999);
        gl.Uniform1(Loc("uGamma"), (float)p.Gamma);
        gl.Uniform1(Loc("uValueMode"), p.ValueMode);
        gl.Uniform1(Loc("uCompressMode"), p.CompressMode);
        gl.Uniform1(Loc("uCompressK"), (float)p.CompressK);
        gl.Uniform1(Loc("uCompressWhite"), (float)p.CompressWhite);

        // --- palette ---------------------------------------------------------
        var ramp = p.RampName == "custom" && p.CustomRamp != null
            ? p.CustomRamp
            : Palettes.Ramps[p.RampName];
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
        gl.Uniform1(Loc("uOkPhaseSigned"), p.OkPhaseSigned ? 1 : 0);
        gl.Uniform1(Loc("uDitherAmp"), p.Dither ? 1.0f / 255.0f : 0.0f);
        gl.Uniform1(Loc("uColorMode"), p.ColorMode);
        // The offline host renders the analytic base without a web flow layer.
        gl.Uniform1(Loc("uFlowOverlayEnabled"), 0);
        gl.Uniform1(Loc("uFlowBase"), 1.0f);
    }

    /// <summary>Rebuild the row textures when the term list's states change.</summary>
    private void EnsureSuperTextures(IReadOnlyList<SuperTerm> terms)
    {
        string key = string.Join(";", terms.Select(t => $"{t.N},{t.L},{t.M}"));
        if (key == _supKey) return;

        int radW = Asset.Radial.Values.First().Values.Length;
        int angW = Asset.Angular.Values.First().Values.Length;
        var radData = new float[radW * 8];
        var angData = new float[angW * 8];
        for (int k = 0; k < Math.Min(terms.Count, 8); k++)
        {
            var t = terms[k];
            var radial = Asset.Radial[(t.N, t.L)];
            var angular = Asset.Angular[(t.L, Math.Abs(t.M))];
            radial.Values.CopyTo(radData, k * radW);
            angular.Values.CopyTo(angData, k * angW);
            _supRMax[k] = radial.RMax;
        }

        var gl = Ctx.Gl;
        if (_supRadialTex != 0) gl.DeleteTexture(_supRadialTex);
        if (_supAngularTex != 0) gl.DeleteTexture(_supAngularTex);
        _supRadialTex = Ctx.CreateRowTableTexture(radData, radW, 8);
        _supAngularTex = Ctx.CreateRowTableTexture(angData, angW, 8);
        _supKey = key;
    }

    /// <summary>Upload the shared 3D-view uniforms (camera basis, projection,
    /// display transform, clip planes) — used by every volumetric pass.</summary>
    protected void UploadCamera(
        (double x, double y, double z) pos, (double x, double y, double z) right,
        (double x, double y, double z) up, (double x, double y, double z) fwd,
        double fovYDeg, double aspect, int tonemap, double exposureEv,
        IReadOnlyList<(double nx, double ny, double nz, double d)> clipPlanes)
    {
        if (clipPlanes.Count > 2)
            throw new ArgumentException("at most two clip planes are supported");
        var gl = Ctx.Gl;
        gl.Uniform3(Loc("uCamPos"), (float)pos.x, (float)pos.y, (float)pos.z);
        gl.Uniform3(Loc("uCamRight"), (float)right.x, (float)right.y, (float)right.z);
        gl.Uniform3(Loc("uCamUp"), (float)up.x, (float)up.y, (float)up.z);
        gl.Uniform3(Loc("uCamFwd"), (float)fwd.x, (float)fwd.y, (float)fwd.z);
        gl.Uniform1(Loc("uTanHalfFov"), (float)Math.Tan(fovYDeg * Math.PI / 360.0));
        gl.Uniform1(Loc("uAspect"), (float)aspect);
        gl.Uniform1(Loc("uTonemap"), tonemap);
        gl.Uniform1(Loc("uExposure"), (float)exposureEv);

        var planes = new float[8];
        for (int i = 0; i < clipPlanes.Count; i++)
        {
            var (nx, ny, nz, d) = clipPlanes[i];
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
        gl.Uniform1(Loc("uClipCount"), clipPlanes.Count);
    }

    /// <summary>Draw the fullscreen triangle into a framebuffer the caller owns
    /// and keeps. Nothing is allocated, read back, or deleted.</summary>
    /// <param name="framebuffer">The target FBO. 0 is the default framebuffer.</param>
    /// <remarks>
    /// This is the interop half of <see cref="DrawAndRead"/>. A host that hands
    /// its texture to another API needs the texture to persist across frames and
    /// the pixels to stay on the GPU, so allocating a target, reading it back
    /// and deleting it every frame — which is exactly the right thing for a CLI
    /// writing a PNG — is exactly the wrong thing for it. Uniforms must already
    /// be uploaded; the view renderers' RenderInto methods do both.
    /// </remarks>
    protected void DrawInto(uint framebuffer, int width, int height)
    {
        var gl = Ctx.Gl;
        gl.BindFramebuffer(FramebufferTarget.Framebuffer, framebuffer);
        gl.Viewport(0, 0, (uint)width, (uint)height);
        gl.DrawArrays(PrimitiveType.Triangles, 0, 3);
    }

    /// <summary>Render the bound program into a fresh target and read it back
    /// (top-down RGBA8).</summary>
    protected byte[] DrawAndRead(int width, int height)
    {
        var gl = Ctx.Gl;
        var (fbo, tex) = Ctx.CreateRenderTarget(width, height);
        DrawInto(fbo, width, height);
        var pixels = Ctx.ReadPixelsTopDown(width, height);
        gl.BindFramebuffer(FramebufferTarget.Framebuffer, 0);
        gl.DeleteFramebuffer(fbo);
        gl.DeleteTexture(tex);
        return pixels;
    }

    /// <summary>Delete the program and the table textures this renderer created.
    /// The context must be current on the calling thread.</summary>
    /// <remarks>
    /// The CLI does not need this — it exits, and the context goes with it. A
    /// host that outlives its renderers does: a renderer holds a linked program
    /// plus one R32F texture per (n,l) and (l,|m|) it has been asked for, and
    /// leaking those across a long-lived session adds up.
    /// </remarks>
    public virtual void Dispose()
    {
        var gl = Ctx.Gl;
        gl.DeleteProgram(Program);
        gl.DeleteTexture(_phaseCmaxTex);
        foreach (uint tex in _radialTex.Values) gl.DeleteTexture(tex);
        foreach (uint tex in _angularTex.Values) gl.DeleteTexture(tex);
        _radialTex.Clear();
        _angularTex.Clear();
        if (_supRadialTex != 0) gl.DeleteTexture(_supRadialTex);
        if (_supAngularTex != 0) gl.DeleteTexture(_supAngularTex);
        _supRadialTex = 0;
        _supAngularTex = 0;
        _supKey = "";
        GC.SuppressFinalize(this);
    }
}
