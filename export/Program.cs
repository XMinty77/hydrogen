// =============================================================================
// Program.cs — smoke test for the offline export host.
// =============================================================================
//
// Purpose: prove out the three assumptions the whole export architecture rests
// on, before any real rendering code is written:
//
//   1. We can create an OpenGL context headlessly (an invisible GLFW window on
//      the workstation's X display) and it lands on the NVIDIA GPU, not on a
//      software rasterizer.
//   2. The desktop driver accepts shaders written in GLSL ES 3.00 ("#version
//      300 es", via GL_ARB_ES3_compatibility) — the exact dialect WebGL2 uses.
//      This is what lets the web demo and this exporter share identical shader
//      files.
//   3. We can render to an offscreen framebuffer, read the pixels back, and
//      encode a correct (not vertically flipped) PNG.
//
// It renders a deliberately asymmetric test pattern — a hue wheel with radial
// rings and a white marker square in the top-left corner — so that any
// row-order or channel-order mistake is immediately visible in the output.
//
// Run:  dotnet run          (writes smoke_test.png next to the project)
// =============================================================================

using Silk.NET.Maths;
using Silk.NET.OpenGL;
using Silk.NET.Windowing;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

// Render size for the offscreen framebuffer. The window itself stays tiny and
// invisible — it exists only to own a GL context.
const int Width = 800;
const int Height = 800;

// --- Shaders (GLSL ES 3.00, the WebGL2 dialect) ------------------------------

// Fullscreen triangle generated from gl_VertexID — no vertex buffer needed.
// Vertices: (-1,-1), (3,-1), (-1,3) cover the whole viewport with one triangle.
const string VertexSrc = @"#version 300 es
void main() {
    vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0,
                  gl_VertexID == 2 ? 3.0 : -1.0);
    gl_Position = vec4(p, 0.0, 1.0);
}";

// Test pattern: hue encodes azimuth (a stand-in for the future phase wheel),
// cosine rings encode radius, and a white square sits in the *top-left* corner
// so a vertical flip in the readback path cannot go unnoticed.
const string FragmentSrc = @"#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec2 uRes;

vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes * 2.0 - 1.0;
    float r = length(uv);
    float a = atan(uv.y, uv.x);                       // azimuth in (-pi, pi]
    float hue = a / 6.28318530718 + 0.5;              // -> [0, 1)
    vec3 col = hsv2rgb(vec3(hue, 1.0, smoothstep(1.0, 0.98, r)));
    col *= 0.75 + 0.25 * cos(20.0 * r);               // radial rings
    // Orientation marker: white square in the top-left corner of the *image*
    // (gl_FragCoord's y axis points up, PNG rows go down — hence uRes.y - y).
    if (gl_FragCoord.x < 40.0 && uRes.y - gl_FragCoord.y < 40.0)
        col = vec3(1.0);
    fragColor = vec4(col, 1.0);
}";

// --- Invisible window / GL context -------------------------------------------

var opts = WindowOptions.Default with
{
    IsVisible = false,
    Size = new Vector2D<int>(64, 64),
    Title = "hydrogen export smoke test",
};

var window = Window.Create(opts);
int exitCode = 1;

// All GL work happens in Load (context is current there); then we close.
window.Load += () =>
{
    var gl = GL.GetApi(window);

    // --- 1. Report what we actually got: driver, GPU, GLSL version. ---------
    string renderer = gl.GetStringS(StringName.Renderer);
    string version = gl.GetStringS(StringName.Version);
    string glsl = gl.GetStringS(StringName.ShadingLanguageVersion);
    Console.WriteLine($"RENDERER: {renderer}");
    Console.WriteLine($"VERSION:  {version}");
    Console.WriteLine($"GLSL:     {glsl}");

    // --- 2. Compile the ES 3.00 shader pair on the desktop driver. ----------
    uint Compile(ShaderType type, string src)
    {
        uint s = gl.CreateShader(type);
        gl.ShaderSource(s, src);
        gl.CompileShader(s);
        gl.GetShader(s, ShaderParameterName.CompileStatus, out int ok);
        if (ok == 0)
            throw new Exception($"{type} compile failed:\n{gl.GetShaderInfoLog(s)}");
        return s;
    }

    uint program = gl.CreateProgram();
    gl.AttachShader(program, Compile(ShaderType.VertexShader, VertexSrc));
    gl.AttachShader(program, Compile(ShaderType.FragmentShader, FragmentSrc));
    gl.LinkProgram(program);
    gl.GetProgram(program, ProgramPropertyARB.LinkStatus, out int linked);
    if (linked == 0)
        throw new Exception($"link failed:\n{gl.GetProgramInfoLog(program)}");
    Console.WriteLine("ES 3.00 shader compiled and linked on desktop GL: OK");

    // --- 3. Offscreen framebuffer at the target resolution. -----------------
    uint fbo = gl.GenFramebuffer();
    gl.BindFramebuffer(FramebufferTarget.Framebuffer, fbo);
    uint tex = gl.GenTexture();
    gl.BindTexture(TextureTarget.Texture2D, tex);
    unsafe
    {
        gl.TexImage2D(TextureTarget.Texture2D, 0, InternalFormat.Rgba8,
                      Width, Height, 0, PixelFormat.Rgba,
                      PixelType.UnsignedByte, null);
    }
    gl.FramebufferTexture2D(FramebufferTarget.Framebuffer,
                            FramebufferAttachment.ColorAttachment0,
                            TextureTarget.Texture2D, tex, 0);
    if (gl.CheckFramebufferStatus(FramebufferTarget.Framebuffer)
        != GLEnum.FramebufferComplete)
        throw new Exception("framebuffer incomplete");

    // --- Draw the fullscreen triangle. ---------------------------------------
    // Core profile requires *some* VAO to be bound even with no attributes.
    gl.BindVertexArray(gl.GenVertexArray());
    gl.Viewport(0, 0, Width, Height);
    gl.UseProgram(program);
    gl.Uniform2(gl.GetUniformLocation(program, "uRes"), (float)Width, (float)Height);
    gl.DrawArrays(PrimitiveType.Triangles, 0, 3);

    // --- 4. Read back and save as PNG. ---------------------------------------
    var pixels = new byte[Width * Height * 4];
    gl.ReadPixels(0, 0, Width, Height, PixelFormat.Rgba,
                  PixelType.UnsignedByte, (Span<byte>)pixels);

    // glReadPixels returns rows bottom-up; PNG stores them top-down. Flip.
    var flipped = new byte[pixels.Length];
    int stride = Width * 4;
    for (int y = 0; y < Height; y++)
        Array.Copy(pixels, y * stride,
                   flipped, (Height - 1 - y) * stride, stride);

    using var image = Image.LoadPixelData<Rgba32>(flipped, Width, Height);
    string outPath = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "smoke_test.png"));
    image.SaveAsPng(outPath);
    Console.WriteLine($"WROTE: {outPath}");

    exitCode = renderer.Contains("NVIDIA", StringComparison.OrdinalIgnoreCase)
        ? 0
        : 2; // context works but landed on the wrong device — investigate
    window.Close();
};

window.Run();
return exitCode;
