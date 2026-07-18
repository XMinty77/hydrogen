// =============================================================================
// Program.cs — CLI entry point for the offline export host.
// =============================================================================
//
// Usage:
//   dotnet run -- slice [options]        render one 2D cross-section PNG
//
// Slice options (all optional):
//   --state N,L,M       quantum numbers            (default 4,2,1)
//   --mode real|complex                            (default real)
//   --color ramp|signed|phase   (default: ramp for real, phase for complex)
//   --plane xz|xy|yz    cutting plane              (default xz)
//   --offset F          out-of-plane offset, a₀    (default 0)
//   --extent F          half-width, a₀             (default: framing radius)
//   --size W[xH]        output pixels              (default 1024)
//   --gamma F           brightening exponent       (default 0.45)
//   --value density|amplitude                      (default density)
//   --ramp NAME         palette ramp name          (default accretion_tuned)
//   --ramp-space oklab|srgb   stop interpolation   (default oklab)
//   --no-dither         disable output dithering
//   --out PATH          output file (default gallery/slices/<auto-name>.png)
//
// Paths are resolved from the repo root (found by walking up to the directory
// containing shaders/), so this works from any working directory.
// =============================================================================

using Hydrogen.Export;
using Hydrogen.Export.Gl;
using Hydrogen.Export.Horb;
using Hydrogen.Export.Palettes;
using Hydrogen.Export.Render;

// ---------------------------------------------------------------------------
// Locate the repo root and shared resources.
// ---------------------------------------------------------------------------
string root = AppContext.BaseDirectory;
while (!Directory.Exists(Path.Combine(root, "shaders")))
{
    var parent = Directory.GetParent(root)
        ?? throw new InvalidOperationException("repo root (shaders/) not found");
    root = parent.FullName;
}

if (args.Length == 0 || args[0] != "slice")
{
    Console.Error.WriteLine("usage: dotnet run -- slice [options]   (see Program.cs header)");
    return 1;
}

// ---------------------------------------------------------------------------
// Parse options into a mutable bag, then validate.
// ---------------------------------------------------------------------------
var opt = new Dictionary<string, string>();
var flags = new HashSet<string>();
for (int i = 1; i < args.Length; i++)
{
    if (!args[i].StartsWith("--"))
        throw new ArgumentException($"unexpected argument '{args[i]}'");
    string key = args[i][2..];
    if (key == "no-dither") flags.Add(key);
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

// ---------------------------------------------------------------------------
// Load resources and render.
// ---------------------------------------------------------------------------
var asset = HorbAsset.Load(Path.Combine(root, "assets", "orbitals.bin"));
var palettes = PaletteSet.Load(Path.Combine(root, "assets", "palettes.json"));

// Optional phase-wheel overrides (--phase-L / --phase-C / --phase-h0-deg),
// for palette exploration without re-baking palettes.json.
if (opt.TryGetValue("phase-L", out var pl)) palettes.PhaseL = float.Parse(pl);
if (opt.TryGetValue("phase-C", out var pc)) palettes.PhaseC = float.Parse(pc);
if (opt.TryGetValue("phase-h0-deg", out var ph))
    palettes.PhaseH0 = float.Parse(ph) * MathF.PI / 180f;

double extent = opt.TryGetValue("extent", out var extStr)
    ? double.Parse(extStr)
    : asset.FramingRadius(n);
double offset = double.Parse(Get("offset", "0"));

// Plane basis: axis-aligned planes here; arbitrary rotated planes are the same
// three uniforms with rotated vectors (exercised by the web demo later).
var (origin, axisU, axisV) = Get("plane", "xz") switch
{
    "xz" => ((0.0, offset, 0.0), (extent, 0.0, 0.0), (0.0, 0.0, extent)),
    "xy" => ((0.0, 0.0, offset), (extent, 0.0, 0.0), (0.0, extent, 0.0)),
    "yz" => ((offset, 0.0, 0.0), (0.0, extent, 0.0), (0.0, 0.0, extent)),
    var s => throw new ArgumentException($"unknown plane '{s}'"),
};

var sliceParams = new SliceParams
{
    N = n, L = l, M = m,
    RealMode = realMode,
    ColorMode = colorMode,
    Origin = origin, AxisU = axisU, AxisV = axisV,
    Width = width, Height = height,
    RampName = Get("ramp", "accretion_tuned"),
    RampSpaceSrgb = Get("ramp-space", "oklab") == "srgb",
    Gamma = double.Parse(Get("gamma", "0.45")),
    ValueMode = Get("value", "density") == "amplitude" ? 1 : 0,
    Dither = !flags.Contains("no-dither"),
};

string outPath = Get("out", Path.Combine(root, "gallery", "slices",
    $"n{n}_l{l}_m{m}_{(realMode ? "real" : "complex")}_{Get("plane", "xz")}.png"));

using var ctx = new OffscreenGl(Path.Combine(root, "shaders"));
var renderer = new SliceRenderer(ctx, asset, palettes);
var pixels = renderer.Render(sliceParams);
Png.Write(outPath, pixels, width, height);
Console.WriteLine($"wrote {outPath}");
return 0;
