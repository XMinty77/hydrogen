// =============================================================================
// OffscreenGl.cs — the GL foundation of the export host.
// =============================================================================
//
// Provides the small set of primitives every render pass needs: shader
// assembly from the shared shaders/ directory, float-table textures, offscreen
// render targets, and PNG-ready pixel readback.
//
// The context underneath comes from one of two places:
//
//   * new OffscreenGl(shaderDir)  — this class creates and owns an invisible
//     GLFW window (context only; nothing is ever shown). This is what the CLI
//     uses.
//   * new OffscreenGl(gl, shaderDir) — the context already exists and belongs
//     to someone else: an engine, a compositor, a test harness. Everything
//     above this class then works unchanged on that context, which is the only
//     way to hand a rendered texture to another API (a wrapper can only see a
//     texture that lives on its own context).
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
    /// <summary>The window this class created, or null when the context was
    /// supplied by a host (in which case nothing here owns it).</summary>
    private readonly IWindow? _window;

    public GL Gl { get; }
    public string ShaderDir { get; }

    /// <summary>The vertex array object every bufferless draw runs under.
    /// Core profile requires one to be bound even when the draw sources no
    /// attributes; see <see cref="RestoreState"/>.</summary>
    public uint Vao { get; }

    /// <summary>True when this instance created the GL context and will
    /// destroy it on Dispose.</summary>
    public bool OwnsContext => _window is not null;

    /// <summary>Create a private offscreen context on an invisible GLFW window
    /// and make it current on the calling thread.</summary>
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

        Vao = Gl.GenVertexArray();
        RestoreState();
    }

    /// <summary>Adopt a GL context that already exists and belongs to someone
    /// else — an engine, a compositor, a test harness.</summary>
    /// <param name="gl">A binding for a context that is current on the calling
    /// thread. It stays current for the lifetime of every renderer built over
    /// this instance; nothing here makes a context current or moves one
    /// between threads.</param>
    /// <param name="shaderDir">The shaders/ directory to assemble GLSL from.</param>
    /// <remarks>
    /// <para>
    /// The host keeps ownership: <see cref="Dispose"/> deletes only the objects
    /// this class created, never the context.
    /// </para>
    /// <para>
    /// There is no renderer warning on this path. The CLI warns when it lands
    /// on something other than the NVIDIA GPU because it picked the context and
    /// could have picked wrong; a host that supplies its own has already made
    /// that decision deliberately.
    /// </para>
    /// <para>
    /// Constructing this <em>does</em> mutate the context: it binds a VAO and
    /// sets both pixel-store alignments (see <see cref="RestoreState"/>). Any
    /// host sharing the context with another library must expect that, and must
    /// call <see cref="RestoreState"/> again before each hydrogen pass.
    /// </para>
    /// </remarks>
    public OffscreenGl(GL gl, string shaderDir)
    {
        ArgumentNullException.ThrowIfNull(gl);
        Gl = gl;
        ShaderDir = shaderDir;
        _window = null;
        Vao = Gl.GenVertexArray();
        RestoreState();
    }

    /// <summary>Re-establish the two pieces of context-wide state every draw and
    /// upload in this library assumes.</summary>
    /// <remarks>
    /// Both are set once at construction and then simply relied upon, which is
    /// safe while hydrogen is the only thing touching the context. It is not
    /// safe when the context is shared: Skia/Ganesh, Qt, ImGui and friends all
    /// unbind the vertex array and reset the pixel store. A shared-context host
    /// should call this immediately before each hydrogen pass — it is two GL
    /// calls and a bind, and the failure it prevents (an INVALID_OPERATION draw,
    /// or a row-misaligned table upload that quietly produces a plausible but
    /// wrong image) is expensive to diagnose.
    /// </remarks>
    public void RestoreState()
    {
        // Core profile requires a bound VAO even for bufferless draws.
        Gl.BindVertexArray(Vao);
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
    /// <remarks>
    /// The texture is left sampler-complete — LINEAR, clamped, no mipmaps — so
    /// it can be handed to another API and sampled, not merely read back. The
    /// default GL sampler state (NEAREST_MIPMAP_LINEAR, REPEAT) would make a
    /// mipmap-less texture incomplete and sample as black; the CLI never
    /// noticed because it only ever calls ReadPixels on it.
    /// </remarks>
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
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureMinFilter,
                        (int)TextureMinFilter.Linear);
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureMagFilter,
                        (int)TextureMagFilter.Linear);
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureWrapS,
                        (int)TextureWrapMode.ClampToEdge);
        Gl.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureWrapT,
                        (int)TextureWrapMode.ClampToEdge);
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

    /// <summary>Release what this instance created. When it owns the context,
    /// that means the window (which takes the context and everything on it with
    /// it). When the context was adopted, only the VAO is deleted, and the
    /// context must still be current on the calling thread.</summary>
    public void Dispose()
    {
        if (_window is not null)
        {
            _window.Dispose();
            return;
        }

        Gl.DeleteVertexArray(Vao);
    }
}
