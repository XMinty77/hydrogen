// =============================================================================
// OffscreenGl.cs — the GL foundation of the export host.
// =============================================================================
//
// Owns an invisible GLFW window (context only; nothing is ever shown), and
// provides the small set of primitives every render pass needs: shader
// assembly from the shared shaders/ directory, float-table textures,
// offscreen render targets, and PNG-ready pixel readback.
//
// Shader assembly contract (mirrored by the web host): a fragment shader is
// the concatenation  prelude.glsl + common.glsl + <view>.frag  — GLSL ES 3.00
// throughout, which the desktop NVIDIA driver compiles natively via
// GL_ARB_ES3_compatibility.
// =============================================================================

using Silk.NET.Maths;
using Silk.NET.OpenGL;
using Silk.NET.Windowing;

namespace Hydrogen.Export.Gl;

public sealed class OffscreenGl : IDisposable
{
    private readonly IWindow _window;
    public GL Gl { get; }
    public string ShaderDir { get; }

    public OffscreenGl(string shaderDir)
    {
        ShaderDir = shaderDir;
        var opts = WindowOptions.Default with
        {
            IsVisible = false,
            Size = new Vector2D<int>(64, 64),
            Title = "hydrogen export",
        };
        _window = Window.Create(opts);
        _window.Initialize();               // creates the context, makes it current
        Gl = GL.GetApi(_window);

        string renderer = Gl.GetStringS(StringName.Renderer);
        if (!renderer.Contains("NVIDIA", StringComparison.OrdinalIgnoreCase))
            Console.Error.WriteLine(
                $"warning: GL context is on '{renderer}', not the NVIDIA GPU");

        // Core profile requires a bound VAO even for bufferless draws.
        Gl.BindVertexArray(Gl.GenVertexArray());
        // Table/readback rows are tightly packed; don't let 4-byte row
        // alignment corrupt odd-width uploads.
        Gl.PixelStore(PixelStoreParameter.UnpackAlignment, 1);
        Gl.PixelStore(PixelStoreParameter.PackAlignment, 1);
    }

    // -------------------------------------------------------------------------
    // Shader assembly.
    // -------------------------------------------------------------------------

    /// <summary>Compile a program from files in shaders/: a standalone vertex
    /// shader plus a fragment shader assembled as prelude + common + view.</summary>
    public uint CreateProgram(string vertFile, string viewFragFile)
    {
        string Read(string name) => File.ReadAllText(Path.Combine(ShaderDir, name));
        string frag = Read("prelude.glsl") + "\n" + Read("common.glsl") + "\n" +
                      Read(viewFragFile);

        uint Compile(ShaderType type, string src, string label)
        {
            uint s = Gl.CreateShader(type);
            Gl.ShaderSource(s, src);
            Gl.CompileShader(s);
            Gl.GetShader(s, ShaderParameterName.CompileStatus, out int ok);
            if (ok == 0)
                throw new InvalidOperationException(
                    $"{label} failed to compile:\n{Gl.GetShaderInfoLog(s)}");
            return s;
        }

        uint vs = Compile(ShaderType.VertexShader, Read(vertFile), vertFile);
        uint fs = Compile(ShaderType.FragmentShader, frag,
                          $"prelude+common+{viewFragFile}");
        uint program = Gl.CreateProgram();
        Gl.AttachShader(program, vs);
        Gl.AttachShader(program, fs);
        Gl.LinkProgram(program);
        Gl.GetProgram(program, ProgramPropertyARB.LinkStatus, out int linked);
        if (linked == 0)
            throw new InvalidOperationException(
                $"program link failed:\n{Gl.GetProgramInfoLog(program)}");
        Gl.DeleteShader(vs);
        Gl.DeleteShader(fs);
        return program;
    }

    // -------------------------------------------------------------------------
    // Textures and render targets.
    // -------------------------------------------------------------------------

    /// <summary>Upload a baked 1D table as a width×1 R32F texture. Filtering is
    /// NEAREST by design: shaders interpolate manually via texelFetch so results
    /// are bit-identical across native GL and WebGL2.</summary>
    public unsafe uint CreateTableTexture(float[] values)
    {
        uint tex = Gl.GenTexture();
        Gl.BindTexture(TextureTarget.Texture2D, tex);
        fixed (float* p = values)
        {
            Gl.TexImage2D(TextureTarget.Texture2D, 0, InternalFormat.R32f,
                          (uint)values.Length, 1, 0, PixelFormat.Red,
                          PixelType.Float, p);
        }
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureMinFilter,
                        (int)TextureMinFilter.Nearest);
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureMagFilter,
                        (int)TextureMagFilter.Nearest);
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureWrapS,
                        (int)TextureWrapMode.ClampToEdge);
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureWrapT,
                        (int)TextureWrapMode.ClampToEdge);
        return tex;
    }

    /// <summary>Upload several equal-width tables as one width×rows R32F
    /// texture (row k = table k) — the superposition term layout. Same
    /// NEAREST/manual-interpolation contract as CreateTableTexture.</summary>
    public unsafe uint CreateRowTableTexture(float[] packed, int width, int rows)
    {
        uint tex = Gl.GenTexture();
        Gl.ActiveTexture(TextureUnit.Texture7);   // scratch unit; see below
        Gl.BindTexture(TextureTarget.Texture2D, tex);
        fixed (float* p = packed)
        {
            Gl.TexImage2D(TextureTarget.Texture2D, 0, InternalFormat.R32f,
                          (uint)width, (uint)rows, 0, PixelFormat.Red,
                          PixelType.Float, p);
        }
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureMinFilter,
                        (int)TextureMinFilter.Nearest);
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureMagFilter,
                        (int)TextureMagFilter.Nearest);
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureWrapS,
                        (int)TextureWrapMode.ClampToEdge);
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureWrapT,
                        (int)TextureWrapMode.ClampToEdge);
        return tex;
    }

    /// <summary>Create an RGBA32F framebuffer (HDR accumulation target for the
    /// progressive path tracer). NEAREST, clamped, no mipmaps.</summary>
    public unsafe (uint fbo, uint tex) CreateFloatRenderTarget(int width, int height)
    {
        uint fbo = Gl.GenFramebuffer();
        Gl.BindFramebuffer(FramebufferTarget.Framebuffer, fbo);
        uint tex = Gl.GenTexture();
        Gl.ActiveTexture(TextureUnit.Texture7);
        Gl.BindTexture(TextureTarget.Texture2D, tex);
        Gl.TexImage2D(TextureTarget.Texture2D, 0, InternalFormat.Rgba32f,
                      (uint)width, (uint)height, 0, PixelFormat.Rgba,
                      PixelType.Float, null);
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureMinFilter,
                        (int)TextureMinFilter.Nearest);
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureMagFilter,
                        (int)TextureMagFilter.Nearest);
        Gl.FramebufferTexture2D(FramebufferTarget.Framebuffer,
                                FramebufferAttachment.ColorAttachment0,
                                TextureTarget.Texture2D, tex, 0);
        if (Gl.CheckFramebufferStatus(FramebufferTarget.Framebuffer)
            != GLEnum.FramebufferComplete)
            throw new InvalidOperationException("float framebuffer incomplete");
        return (fbo, tex);
    }

    /// <summary>Create an RGBA8 framebuffer of the given size and bind it.
    /// The target texture is bound on a reserved scratch unit so creating a
    /// render target can never silently replace a sampler binding made by a
    /// renderer (units 0–2 carry the orbital/palette tables).</summary>
    public unsafe (uint fbo, uint tex) CreateRenderTarget(int width, int height)
    {
        uint fbo = Gl.GenFramebuffer();
        Gl.BindFramebuffer(FramebufferTarget.Framebuffer, fbo);
        uint tex = Gl.GenTexture();
        Gl.ActiveTexture(TextureUnit.Texture7);
        Gl.BindTexture(TextureTarget.Texture2D, tex);
        Gl.TexImage2D(TextureTarget.Texture2D, 0, InternalFormat.Rgba8,
                      (uint)width, (uint)height, 0, PixelFormat.Rgba,
                      PixelType.UnsignedByte, null);
        Gl.FramebufferTexture2D(FramebufferTarget.Framebuffer,
                                FramebufferAttachment.ColorAttachment0,
                                TextureTarget.Texture2D, tex, 0);
        if (Gl.CheckFramebufferStatus(FramebufferTarget.Framebuffer)
            != GLEnum.FramebufferComplete)
            throw new InvalidOperationException("framebuffer incomplete");
        return (fbo, tex);
    }

    /// <summary>Read the bound framebuffer as RGBA bytes, top row first
    /// (GL's bottom-up rows are flipped here, ready for PNG encoding).</summary>
    public byte[] ReadPixelsTopDown(int width, int height)
    {
        var pixels = new byte[width * height * 4];
        Gl.ReadPixels(0, 0, (uint)width, (uint)height, PixelFormat.Rgba,
                      PixelType.UnsignedByte, (Span<byte>)pixels);
        var flipped = new byte[pixels.Length];
        int stride = width * 4;
        for (int y = 0; y < height; y++)
            Array.Copy(pixels, y * stride, flipped, (height - 1 - y) * stride, stride);
        return flipped;
    }

    public void Dispose() => _window.Dispose();
}
