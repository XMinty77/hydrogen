// =============================================================================
// Program.cs — CLI entry point for the offline export host.
// =============================================================================
//
// Usage:
//   dotnet run -- slice  [options]       render one 2D cross-section PNG
//   dotnet run -- volume [options]       render one 3D volumetric PNG
//
// Common options:
//   --state N,L,M       quantum numbers            (default 4,2,1)
//   --mode real|complex                            (default real)
//   --color ramp|signed|phase   (default: ramp for real, phase for complex)
//   --size W[xH]        output pixels              (default 1024)
//   --gamma F           brightening exponent       (default 0.71)
//   --value density|amplitude                      (default density)
//   --ramp NAME         palette ramp name          (default accretion_tuned)
//   --ramp-space oklab|srgb   stop interpolation   (default oklab)
//   --phase-constant    constant-chroma wheel instead of the vivid default
//   --phase-chroma-pow F                           (default 0.6)
//   --phase-L/--phase-C/--phase-h0-deg   wheel overrides (exploration)
//   --no-dither         disable output dithering
//   --out PATH          output file (default under gallery/)
//
// Slice options:
//   --plane xz|xy|yz    cutting plane              (default xz)
//   --offset F          out-of-plane offset, a₀    (default 0)
//   --extent F          half-width, a₀             (default: framing radius)
//
// Volume options:
//   --camera AZ,EL,DIST  orbit camera: azimuth/elevation degrees, distance in
//                        multiples of the framing radius (default 35,25,2.6)
//   --fov F              vertical field of view, degrees (default 40)
//   --integrator mip|ea                            (default mip)
//   --steps N            ray samples               (default 600)
//   --density F          EA extinction scale       (default 5)
//   --opacity-pow F      EA opacity exponent       (default 2.15)
//   --emission F         EA emission gain          (default 6.7)
//   --clip nx,ny,nz,d    half-space clip plane, repeatable up to twice;
//                        keeps the side where n·p + d ≥ 0
// =============================================================================

using Hydrogen.Export;
using Hydrogen.Export.Gl;
using Hydrogen.Export.Horb;
using Hydrogen.Export.Palettes;
using Hydrogen.Export.Render;

string root = AppContext.BaseDirectory;
while (!Directory.Exists(Path.Combine(root, "shaders")))
{
    var parent = Directory.GetParent(root)
        ?? throw new InvalidOperationException("repo root (shaders/) not found");
    root = parent.FullName;
}

if (args.Length == 0 || (args[0] != "slice" && args[0] != "volume" && args[0] != "gallery"))
{
    Console.Error.WriteLine("usage: dotnet run -- slice|volume|gallery [options]   (see Program.cs header)");
    return 1;
}
string command = args[0];

// ---------------------------------------------------------------------------
// Parse options.
// ---------------------------------------------------------------------------
var opt = new Dictionary<string, string>();
var flags = new HashSet<string>();
var clips = new List<(double, double, double, double)>();
for (int i = 1; i < args.Length; i++)
{
    if (!args[i].StartsWith("--"))
        throw new ArgumentException($"unexpected argument '{args[i]}'");
    string key = args[i][2..];
    if (key is "no-dither" or "phase-constant") flags.Add(key);
    else if (key == "clip")
    {
        var v = args[++i].Split(',').Select(double.Parse).ToArray();
        if (v.Length != 4) throw new ArgumentException("--clip needs nx,ny,nz,d");
        clips.Add((v[0], v[1], v[2], v[3]));
    }
    else opt[key] = args[++i];
}
string Get(string key, string fallback) => opt.GetValueOrDefault(key, fallback);

int[] state = Get("state", "4,2,1").Split(',').Select(int.Parse).ToArray();
if (state.Length != 3)
    throw new ArgumentException("--state must be N,L,M");
(int n, int l, int m) = (state[0], state[1], state[2]);

bool realMode = Get("mode", "real") switch
{
    "real" => true,
    "complex" => false,
    var s => throw new ArgumentException($"unknown mode '{s}'"),
};
int colorMode = Get("color", realMode ? "ramp" : "phase") switch
{
    "ramp" => 0,
    "signed" => 1,
    "phase" => 2,
    var s => throw new ArgumentException($"unknown color mode '{s}'"),
};

string[] size = Get("size", "1024").Split('x');
int width = int.Parse(size[0]);
int height = size.Length > 1 ? int.Parse(size[1]) : width;

var asset = HorbAsset.Load(Path.Combine(root, "assets", "orbitals.bin"));
var palettes = PaletteSet.Load(Path.Combine(root, "assets", "palettes.json"));

// Phase-wheel overrides for palette exploration.
if (opt.TryGetValue("phase-L", out var pl)) palettes.PhaseL = float.Parse(pl);
if (opt.TryGetValue("phase-C", out var pc)) palettes.PhaseC = float.Parse(pc);
if (opt.TryGetValue("phase-h0-deg", out var ph))
    palettes.PhaseH0 = float.Parse(ph) * MathF.PI / 180f;

// The gallery batch owns its own GL context and render loop (see
// GalleryCommand.cs / docs/gallery-spec.md).
if (command == "gallery")
    return GalleryCommand.Run(root, asset, palettes, opt);

// The base record every command extends with its geometry.
var common = new CommonParams
{
    N = n, L = l, M = m,
    RealMode = realMode,
    ColorMode = colorMode,
    Width = width, Height = height,
    RampName = Get("ramp", "accretion_tuned"),
    RampSpaceSrgb = Get("ramp-space", "oklab") == "srgb",
    Gamma = double.Parse(Get("gamma", "0.71")),
    ValueMode = Get("value", "density") == "amplitude" ? 1 : 0,
    Dither = !flags.Contains("no-dither"),
    PhaseVivid = !flags.Contains("phase-constant"),
    PhaseChromaPow = double.Parse(Get("phase-chroma-pow", "0.6")),
};

using var ctx = new OffscreenGl(Path.Combine(root, "shaders"));
byte[] pixels;
string defaultOut;

if (command == "slice")
{
    double extent = opt.TryGetValue("extent", out var extStr)
        ? double.Parse(extStr)
        : asset.FramingRadius(n);
    double offset = double.Parse(Get("offset", "0"));
    // Non-square outputs keep square pixels: U spans the width, V the height,
    // so U carries the aspect factor (the vertical extent is the anchor — the
    // same convention as the volume renderer's vertical FOV).
    double extentU = extent * width / height;
    var (origin, axisU, axisV) = Get("plane", "xz") switch
    {
        "xz" => ((0.0, offset, 0.0), (extentU, 0.0, 0.0), (0.0, 0.0, extent)),
        "xy" => ((0.0, 0.0, offset), (extentU, 0.0, 0.0), (0.0, extent, 0.0)),
        "yz" => ((offset, 0.0, 0.0), (0.0, extentU, 0.0), (0.0, 0.0, extent)),
        var s => throw new ArgumentException($"unknown plane '{s}'"),
    };

    var renderer = new SliceRenderer(ctx, asset, palettes);
    pixels = renderer.Render(new SliceParams
    {
        Common = common,
        Origin = origin, AxisU = axisU, AxisV = axisV,
    });
    defaultOut = Path.Combine("gallery", "slices",
        $"n{n}_l{l}_m{m}_{(realMode ? "real" : "complex")}_{Get("plane", "xz")}.png");
}
else
{
    // Orbit camera: azimuth around +z from +x, elevation above the xy-plane,
    // distance in framing radii, always looking at the origin with world-up z.
    double[] cam = Get("camera", "35,25,2.6").Split(',').Select(double.Parse).ToArray();
    if (cam.Length != 3) throw new ArgumentException("--camera needs AZ,EL,DIST");
    double az = cam[0] * Math.PI / 180, el = cam[1] * Math.PI / 180;
    double dist = cam[2] * asset.FramingRadius(n);

    var pos = (x: dist * Math.Cos(el) * Math.Cos(az),
               y: dist * Math.Cos(el) * Math.Sin(az),
               z: dist * Math.Sin(el));
    static (double x, double y, double z) Norm((double x, double y, double z) v)
    {
        double len = Math.Sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        return (v.x / len, v.y / len, v.z / len);
    }
    static (double x, double y, double z) Cross((double x, double y, double z) a,
                                                (double x, double y, double z) b) =>
        (a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

    var fwd = Norm((-pos.x, -pos.y, -pos.z));
    // World-up +z, with an x-axis fallback when looking straight up/down.
    var upRef = Math.Abs(el) > 89.0 * Math.PI / 180 ? (1.0, 0.0, 0.0) : (0.0, 0.0, 1.0);
    var right = Norm(Cross(fwd, upRef));
    var up = Cross(right, fwd);

    var renderer = new VolumeRenderer(ctx, asset, palettes);
    pixels = renderer.Render(new VolumeParams
    {
        Common = common,
        CamPos = pos, CamRight = right, CamUp = up, CamFwd = fwd,
        FovYDeg = double.Parse(Get("fov", "40")),
        Integrator = Get("integrator", "mip") switch
        {
            "mip" => 0,
            "ea" => 1,
            var s => throw new ArgumentException($"unknown integrator '{s}'"),
        },
        Steps = int.Parse(Get("steps", "600")),
        DensityScale = double.Parse(Get("density", "5")),
        OpacityPow = double.Parse(Get("opacity-pow", "2.15")),
        EmissionGain = double.Parse(Get("emission", "6.7")),
        ClipPlanes = clips,
    });
    defaultOut = Path.Combine("gallery", "volumes",
        $"n{n}_l{l}_m{m}_{(realMode ? "real" : "complex")}_{Get("integrator", "mip")}.png");
}

string outPath = Get("out", Path.Combine(root, defaultOut));
Png.Write(outPath, pixels, width, height);
Console.WriteLine($"wrote {outPath}");
return 0;
