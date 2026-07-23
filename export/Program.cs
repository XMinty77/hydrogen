// =============================================================================
// Program.cs — CLI entry point for the offline export host.
// =============================================================================
//
// Usage:
//   dotnet run -- slice  [options]       render one 2D cross-section PNG
//   dotnet run -- volume [options]       render one 3D volumetric PNG
//   dotnet run -- gallery [options]      the exhaustive still batch
//   dotnet run -- url "<link>" [options] reproduce a web-demo URL offline
//                                        (view inferred; options override)
//
// Common options:
//   --url LINK          seed every option from a web-demo URL (CLI flags win)
//   --state N,L,M       quantum numbers            (default 4,2,1)
//   --terms SPEC        superposition "n,l,m[,amp[,phase°]];…" (≤ 8 terms;
//                       overrides --state for the rendered field)
//   --no-normalize      keep raw amplitudes (default normalizes Σ|c|² = 1)
//   --time T            simulated time, atomic units (phase e^{−iEₙt})
//   --mode real|complex                            (default real)
//   --color ramp|signed|phase|okphase  (default: ramp real, phase complex)
//   --size W[xH]        output pixels              (default 1024)
//   --gamma F           brightening exponent       (default 0.71)
//   --value density|amplitude                      (default density)
//   --compress off|log|asinh   pre-gamma range compression (default off)
//   --compress-k F      compression strength       (default 20)
//   --compress-white F  white point in q999 multiples (default 1)
//   --ramp NAME         palette ramp name          (default accretion_tuned)
//   --ramp-stops S      custom ramp "hex@pos,…" (implies --ramp custom)
//   --ramp-space oklab|srgb   stop interpolation   (default oklab)
//   --phase-constant    constant-chroma wheel instead of the vivid default
//   --phase-chroma-pow F                           (default 0.6)
//   --phase-L/--phase-C/--phase-h0-deg   wheel overrides (exploration)
//   --okphase-signed    reflect negative-real hues in okphase mode
//   --no-dither         disable output dithering
//   --post              enable display-referred finishing
//   --no-bloom          disable bloom while keeping other post effects
//   --bloom-threshold/-knee/-intensity/-radius/-iterations/-scale/-saturation
//   --bloom-tint RRGGBB, --bloom-composite screen|additive
//   --post-exposure/-contrast/-saturation/-vibrance
//   --post-aberration/--post-aberration-falloff
//   --vignette plus --vignette-amount/-radius/-softness/-roundness/-center-x/-center-y
//   --grain plus --grain-amount/-scale/-speed and --grain-colored
//   --out PATH          output file (default under gallery/)
//
// Slice options:
//   --plane xz|xy|yz|custom     cutting plane      (default xz)
//   --plane-az/--plane-el/--plane-roll   custom-plane orientation, degrees
//   --offset F          out-of-plane offset, a₀    (default 0)
//   --offset-frac F     …or as a fraction of the framing radius (web semantics)
//   --extent F          half-width, a₀             (default: framing radius)
//   --zoom F            …or framing/zoom (web semantics; default 1)
//
// Volume options:
//   --camera AZ,EL,DIST  orbit camera: azimuth/elevation degrees, distance in
//                        multiples of the framing radius (default 35,25,2.6)
//   --fov F              vertical field of view, degrees (default 40)
//   --integrator mip|ea|scatter|mida|iso|isolegacy|pathtrace|eikonal
//   --steps N            ray samples (default 600; eikonal wants ~300–600)
//   --density/--opacity-pow/--emission   EA transfer (defaults 5/2.15/6.7)
//   --tonemap gamma|agx  display transform          (default gamma)
//   --exposure F         EV shift before the tonemap  (default 0)
//   --light AZ,EL        key-light direction          (default -30,50)
//   --light-gain F       key-light gain               (default 6)
//   --hg-g F             Henyey–Greenstein anisotropy (default 0.35)
//   --shadow-steps/--shadow-density      shadow rays  (defaults 24/120)
//   --octaves/--octave-gain/--octave-ext         multi-scatter octaves
//   --ambient-gain/-dirs/-radius/-density        ambient occlusion field
//   --mida-gamma F       −1 EA … 0 MIDA … +1 MIP      (default 0)
//   --iso-level/-count/-spacing/-alpha/-emission/-rim/-ambient  isosurfaces
//   --shade-model off|lambert|blinn|ggx          lit-surface overlay
//   --shade-diffuse/-spec/-rough/-f0/-conf, --grad-delta
//   --spp N              path tracer: samples per pixel (default 64)
//   --max-bounces/--albedo/--scatter-tint        path tracer
//   --aperture/--focus   thin lens, in framing radii (defaults 0/2.6)
//   --env black|uniform|studio|hue|checker       environment (pt/eikonal)
//   --env-gain F
//   --ior-scale/--eik-map/--eik-pow/--eik-log-k/--absorb/--eik-emission/
//   --dispersion         eikonal refraction
//   --clip nx,ny,nz,d    half-space clip plane, repeatable up to twice;
//                        keeps the side where n·p + d ≥ 0
// =============================================================================

using Hydrogen.Export;
using Hydrogen.Export.Gl;
using Hydrogen.Export.Horb;
using Hydrogen.Export.Palettes;
using Hydrogen.Export.Render;
using System.Numerics;

string root = AppContext.BaseDirectory;
while (!Directory.Exists(Path.Combine(root, "shaders")))
{
    var parent = Directory.GetParent(root)
        ?? throw new InvalidOperationException("repo root (shaders/) not found");
    root = parent.FullName;
}

if (args.Length == 0 ||
    (args[0] != "slice" && args[0] != "volume" && args[0] != "gallery" && args[0] != "url"))
{
    Console.Error.WriteLine(
        "usage: dotnet run -- slice|volume|gallery|url [options]   (see Program.cs header)");
    return 1;
}
string command = args[0];

// ---------------------------------------------------------------------------
// Parse options. The `url` command takes the link as its positional argument.
// ---------------------------------------------------------------------------
string? urlLink = null;
int argStart = 1;
if (command == "url")
{
    if (args.Length < 2)
        throw new ArgumentException("url command needs the link as its argument");
    urlLink = args[1];
    argStart = 2;
}

var opt = new Dictionary<string, string>();
var flags = new HashSet<string>();
var clips = new List<(double, double, double, double)>();
for (int i = argStart; i < args.Length; i++)
{
    if (!args[i].StartsWith("--"))
        throw new ArgumentException($"unexpected argument '{args[i]}'");
    string key = args[i][2..];
    if (key is "no-dither" or "phase-constant" or "no-normalize"
        or "okphase-signed" or "post" or "no-bloom" or "vignette"
        or "grain" or "grain-colored")
        flags.Add(key);
    else if (key == "clip")
    {
        var v = args[++i].Split(',').Select(double.Parse).ToArray();
        if (v.Length != 4) throw new ArgumentException("--clip needs nx,ny,nz,d");
        clips.Add((v[0], v[1], v[2], v[3]));
    }
    else opt[key] = args[++i];
}
if (opt.Remove("url", out string? optUrl)) urlLink ??= optUrl;

// URL seeding: fills only options the CLI did not set. Web clip specs are
// camera-relative; they are converted after the camera pose exists below.
var urlClips = new List<string>();
if (urlLink != null)
{
    string? view = UrlQuery.Apply(urlLink, opt, flags, urlClips);
    if (command == "url") command = view ?? "volume";
}

string Get(string key, string fallback) => opt.GetValueOrDefault(key, fallback);
double GetF(string key, double fallback) =>
    opt.TryGetValue(key, out var s) ? double.Parse(s) : fallback;
int GetI(string key, int fallback) =>
    opt.TryGetValue(key, out var s) ? (int)Math.Round(double.Parse(s)) : fallback;
Vector3 GetRgb(string key, string fallback)
{
    string hex = Get(key, fallback).Trim().TrimStart('#');
    if (hex.Length != 6 || !int.TryParse(hex, System.Globalization.NumberStyles.HexNumber,
                                         null, out int rgb))
        throw new ArgumentException($"--{key} needs a six-digit RRGGBB color");
    return new Vector3((rgb >> 16) / 255f, ((rgb >> 8) & 255) / 255f, (rgb & 255) / 255f);
}

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
    "okphase" => 3,
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

// --- superposition + time ---------------------------------------------------
var terms = opt.TryGetValue("terms", out var termSpec)
    ? SuperTerm.ParseList(termSpec)
    : new List<SuperTerm>();
double timeAu = GetF("time", 0.0);
// A lone state under time evolution is a 1-term superposition (the global
// phase e^{−iEt} spins — visible in phase coloring), mirroring the web host.
if (terms.Count == 0 && timeAu != 0.0)
    terms.Add(new SuperTerm(n, l, m, 1.0, 0.0));

// --- custom ramp -------------------------------------------------------------
Ramp? customRamp = null;
string rampName = Get("ramp", "accretion_tuned");
if (opt.TryGetValue("ramp-stops", out var stopSpec))
{
    customRamp = ColorMath.ParseRampStops(stopSpec);
    rampName = "custom";
}

int compressMode = Get("compress", "off") switch
{
    "off" => 0, "log" => 1, "asinh" => 2,
    var s => throw new ArgumentException($"unknown compress mode '{s}'"),
};

// The base record every command extends with its geometry.
var common = new CommonParams
{
    N = n, L = l, M = m,
    RealMode = realMode,
    ColorMode = colorMode,
    Width = width, Height = height,
    Terms = terms,
    SuperNormalize = !flags.Contains("no-normalize"),
    TimeAu = timeAu,
    RampName = rampName,
    CustomRamp = customRamp,
    RampSpaceSrgb = Get("ramp-space", "oklab") == "srgb",
    Gamma = GetF("gamma", 0.71),
    ValueMode = Get("value", "density") == "amplitude" ? 1 : 0,
    CompressMode = compressMode,
    CompressK = GetF("compress-k", 20.0),
    CompressWhite = GetF("compress-white", 1.0),
    Dither = !flags.Contains("no-dither"),
    PhaseVivid = !flags.Contains("phase-constant"),
    PhaseChromaPow = GetF("phase-chroma-pow", 0.6),
    OkPhaseSigned = flags.Contains("okphase-signed"),
};

// Framing radius: the state's — or, for superpositions, the largest term's.
double framing = terms.Count > 0
    ? terms.Max(t => asset.FramingRadius(t.N))
    : asset.FramingRadius(n);

string stateTag = terms.Count > 0
    ? $"sup{terms.Count}"
    : $"n{n}_l{l}_m{m}";

using var ctx = new OffscreenGl(Path.Combine(root, "shaders"));
byte[] pixels;
string defaultOut;

if (command == "slice")
{
    double extent = opt.TryGetValue("extent", out var extStr)
        ? double.Parse(extStr)
        : framing / GetF("zoom", 1.0);
    double offset = opt.ContainsKey("offset")
        ? GetF("offset", 0.0)
        : GetF("offset-frac", 0.0) * framing;
    // Non-square outputs keep square pixels: U spans the width, V the height,
    // so U carries the aspect factor (the vertical extent is the anchor — the
    // same convention as the volume renderer's vertical FOV).
    double extentU = extent * width / height;
    (double, double, double) origin, axisU, axisV;
    switch (Get("plane", "xz"))
    {
        case "xz": (origin, axisU, axisV) =
            ((0.0, offset, 0.0), (extentU, 0.0, 0.0), (0.0, 0.0, extent)); break;
        case "xy": (origin, axisU, axisV) =
            ((0.0, 0.0, offset), (extentU, 0.0, 0.0), (0.0, extent, 0.0)); break;
        case "yz": (origin, axisU, axisV) =
            ((offset, 0.0, 0.0), (0.0, extentU, 0.0), (0.0, 0.0, extent)); break;
        case "custom":
        {
            // Mirror of web/lib/scene.ts: normal from (azimuth, elevation),
            // in-plane frame z-referenced (x near the poles), then rolled.
            double az = GetF("plane-az", 90.0) * Math.PI / 180;
            double el = GetF("plane-el", 0.0) * Math.PI / 180;
            var nv = (x: Math.Cos(el) * Math.Cos(az),
                      y: Math.Cos(el) * Math.Sin(az),
                      z: Math.Sin(el));
            var refv = Math.Abs(nv.z) > 0.99 ? (x: 1.0, y: 0.0, z: 0.0)
                                             : (x: 0.0, y: 0.0, z: 1.0);
            var u0 = VecOps.Norm(VecOps.Cross(nv, refv));
            var v0 = VecOps.Cross(u0, nv);
            double cr = Math.Cos(GetF("plane-roll", 0.0) * Math.PI / 180);
            double sr = Math.Sin(GetF("plane-roll", 0.0) * Math.PI / 180);
            origin = (nv.x * offset, nv.y * offset, nv.z * offset);
            axisU = ((u0.x * cr + v0.x * sr) * extentU,
                     (u0.y * cr + v0.y * sr) * extentU,
                     (u0.z * cr + v0.z * sr) * extentU);
            axisV = ((v0.x * cr - u0.x * sr) * extent,
                     (v0.y * cr - u0.y * sr) * extent,
                     (v0.z * cr - u0.z * sr) * extent);
            break;
        }
        default: throw new ArgumentException($"unknown plane '{Get("plane", "xz")}'");
    }

    var renderer = new SliceRenderer(ctx, asset, palettes);
    pixels = renderer.Render(new SliceParams
    {
        Common = common,
        Origin = origin, AxisU = axisU, AxisV = axisV,
    });
    defaultOut = Path.Combine("gallery", "slices",
        $"{stateTag}_{(realMode ? "real" : "complex")}_{Get("plane", "xz")}.png");
}
else
{
    // Orbit camera: azimuth around +z from +x, elevation above the xy-plane,
    // distance in framing radii, always looking at the origin with world-up z.
    double[] cam = Get("camera", "35,25,2.6").Split(',').Select(double.Parse).ToArray();
    if (cam.Length != 3) throw new ArgumentException("--camera needs AZ,EL,DIST");
    double camAz = cam[0] * Math.PI / 180, camEl = cam[1] * Math.PI / 180;
    double dist = cam[2] * framing;

    var pos = (x: dist * Math.Cos(camEl) * Math.Cos(camAz),
               y: dist * Math.Cos(camEl) * Math.Sin(camAz),
               z: dist * Math.Sin(camEl));
    var fwd = VecOps.Norm((-pos.x, -pos.y, -pos.z));
    // World-up +z, with an x-axis fallback when looking straight up/down.
    var upRef = Math.Abs(cam[1]) > 89.0 ? (1.0, 0.0, 0.0) : (0.0, 0.0, 1.0);
    var right = VecOps.Norm(VecOps.Cross(fwd, upRef));
    var up = VecOps.Cross(right, fwd);

    // Web-style clip specs (axis,offset[,flip[,camLock]]) become world planes
    // relative to this camera's basis — camLock is moot for a single still.
    foreach (string spec in urlClips.Take(2 - Math.Min(clips.Count, 2)))
    {
        string[] f = spec.Split(',');
        var axis = f[0] switch
        {
            "forward" => fwd, "right" => right, "up" => up,
            var s => throw new ArgumentException($"unknown clip axis '{s}'"),
        };
        double off = f.Length > 1 ? double.Parse(f[1]) : 0.0;
        double sgn = f.Length > 2 && f[2] == "1" ? -1.0 : 1.0;
        clips.Add((sgn * axis.x, sgn * axis.y, sgn * axis.z, -sgn * off * framing));
    }

    string integrator = Get("integrator", "mip");
    int tonemap = Get("tonemap", "gamma") switch
    {
        "gamma" => 0, "agx" => 1,
        var s => throw new ArgumentException($"unknown tonemap '{s}'"),
    };
    int envMode = Get("env", integrator == "eikonal" ? "studio" : "black") switch
    {
        "black" => 0, "uniform" => 1, "studio" => 2, "hue" => 3, "checker" => 4,
        var s => throw new ArgumentException($"unknown environment '{s}'"),
    };
    double[] light = Get("light",
        $"{GetF("light-az", -30)},{GetF("light-el", 50)}")
        .Split(',').Select(double.Parse).ToArray();
    if (light.Length != 2) throw new ArgumentException("--light needs AZ,EL");
    double fov = GetF("fov", 40.0);
    double exposure = GetF("exposure", 0.0);

    if (integrator == "pathtrace")
    {
        var renderer = new PathtraceRenderer(ctx, asset, palettes);
        pixels = renderer.Render(new PathtraceParams
        {
            Common = common,
            CamPos = pos, CamRight = right, CamUp = up, CamFwd = fwd,
            FovYDeg = fov, Tonemap = tonemap, ExposureEv = exposure,
            Spp = GetI("spp", 64),
            DensityScale = GetF("density", 5.0),
            OpacityPow = GetF("opacity-pow", 2.15),
            EmissionGain = GetF("emission", 6.7),
            LightAzDeg = light[0], LightElDeg = light[1],
            LightGain = GetF("light-gain", 6.0),
            HgG = GetF("hg-g", 0.35),
            MaxBounces = GetI("max-bounces", 4),
            Albedo = GetF("albedo", 0.85),
            ScatterTint = GetF("scatter-tint", 0.7),
            Aperture = GetF("aperture", 0.0) * framing,
            FocusDist = GetF("focus", 2.6) * framing,
            EnvMode = envMode,
            EnvGain = GetF("env-gain", 1.0),
            ClipPlanes = clips,
        });
    }
    else if (integrator == "eikonal")
    {
        var renderer = new EikonalRenderer(ctx, asset, palettes);
        pixels = renderer.Render(new EikonalParams
        {
            Common = common,
            CamPos = pos, CamRight = right, CamUp = up, CamFwd = fwd,
            FovYDeg = fov, Tonemap = tonemap, ExposureEv = exposure,
            Steps = GetI("steps", 300),
            IorScale = GetF("ior-scale", 0.25),
            EikMap = Get("eik-map", "log") == "pow" ? 0 : 1,
            EikPow = GetF("eik-pow", 0.5),
            EikLogK = GetF("eik-log-k", 10.0),
            Absorb = GetF("absorb", 1.0),
            Emission = GetF("eik-emission", 3.0),
            Dispersion = GetF("dispersion", 0.05),
            EnvMode = envMode,
            EnvGain = GetF("env-gain", 1.0),
            GradDelta = GetF("grad-delta", 0.004),
            ClipPlanes = clips,
        });
    }
    else
    {
        int integratorId = integrator switch
        {
            "mip" => 0, "ea" => 1, "scatter" => 2, "mida" => 3,
            "iso" => 4, "isolegacy" => 4,
            var s => throw new ArgumentException($"unknown integrator '{s}'"),
        };
        int shadeModel = Get("shade-model", "off") switch
        {
            "off" => 0, "lambert" => 1, "blinn" => 2, "ggx" => 3,
            var s => throw new ArgumentException($"unknown shade model '{s}'"),
        };
        var renderer = new VolumeRenderer(ctx, asset, palettes);
        pixels = renderer.Render(new VolumeParams
        {
            Common = common,
            CamPos = pos, CamRight = right, CamUp = up, CamFwd = fwd,
            FovYDeg = fov, Tonemap = tonemap, ExposureEv = exposure,
            Integrator = integratorId,
            IsoLegacy = integrator == "isolegacy",
            // URLs omit values at the WEB defaults — steps is the one place
            // the two hosts' defaults differ (interactive 64 vs offline 600),
            // so URL-seeded renders reproduce the browser's sampling.
            Steps = GetI("steps", urlLink != null ? 64 : 600),
            DensityScale = GetF("density", 5.0),
            OpacityPow = GetF("opacity-pow", 2.15),
            EmissionGain = GetF("emission", 6.7),
            LightAzDeg = light[0], LightElDeg = light[1],
            LightGain = GetF("light-gain", 6.0),
            HgG = GetF("hg-g", 0.35),
            ShadowSteps = GetI("shadow-steps", 24),
            ShadowDensity = GetF("shadow-density", 120.0),
            Octaves = GetI("octaves", 3),
            OctaveGain = GetF("octave-gain", 0.5),
            OctaveExt = GetF("octave-ext", 0.4),
            AmbientGain = GetF("ambient-gain", 2.0),
            AmbientDirs = GetI("ambient-dirs", 6),
            AmbientRadius = GetF("ambient-radius", 0.25),
            AmbientDensity = GetF("ambient-density", 250.0),
            MidaGamma = GetF("mida-gamma", 0.0),
            IsoLevel = GetF("iso-level", 0.5),
            IsoCount = GetI("iso-count", 3),
            IsoSpacing = GetF("iso-spacing", 0.5),
            IsoAlpha = GetF("iso-alpha", 0.4),
            IsoEmission = GetF("iso-emission", 2.5),
            IsoRim = GetF("iso-rim", 1.5),
            IsoAmbient = GetF("iso-ambient", 0.15),
            ShadeModel = shadeModel,
            ShadeDiffuse = GetF("shade-diffuse", 0.5),
            ShadeSpec = GetF("shade-spec", 2.0),
            ShadeRough = GetF("shade-rough", 0.3),
            ShadeF0 = GetF("shade-f0", 0.05),
            ShadeConf = GetF("shade-conf", 1.5),
            GradDelta = GetF("grad-delta", 0.004),
            ClipPlanes = clips,
        });
    }
    defaultOut = Path.Combine("gallery", "volumes",
        $"{stateTag}_{(realMode ? "real" : "complex")}_{integrator}.png");
}

string outPath = Get("out", Path.Combine(root, defaultOut));
pixels = PostProcessor.Apply(pixels, width, height, new PostProcessParams
{
    Enabled = flags.Contains("post"),
    BloomEnabled = !flags.Contains("no-bloom"),
    BloomThreshold = GetF("bloom-threshold", 0.72),
    BloomKnee = GetF("bloom-knee", 0.4),
    BloomIntensity = GetF("bloom-intensity", 0.55),
    BloomRadius = GetF("bloom-radius", 1.0),
    BloomIterations = GetI("bloom-iterations", 3),
    BloomScale = GetF("bloom-scale", 0.5),
    BloomSaturation = GetF("bloom-saturation", 1.0),
    BloomTint = GetRgb("bloom-tint", "ffffff"),
    BloomComposite = Get("bloom-composite", "screen") switch
    {
        "screen" => 0, "additive" => 1,
        var s => throw new ArgumentException($"unknown bloom composite '{s}'"),
    },
    Exposure = GetF("post-exposure", 0.0),
    Contrast = GetF("post-contrast", 1.0),
    Saturation = GetF("post-saturation", 1.0),
    Vibrance = GetF("post-vibrance", 0.0),
    AberrationPx = GetF("post-aberration", 0.0),
    AberrationFalloff = GetF("post-aberration-falloff", 1.5),
    VignetteEnabled = flags.Contains("vignette"),
    VignetteAmount = GetF("vignette-amount", 0.28),
    VignetteRadius = GetF("vignette-radius", 0.82),
    VignetteSoftness = GetF("vignette-softness", 0.38),
    VignetteRoundness = GetF("vignette-roundness", 1.0),
    VignetteCenterX = GetF("vignette-center-x", 0.0),
    VignetteCenterY = GetF("vignette-center-y", 0.0),
    GrainEnabled = flags.Contains("grain"),
    GrainAmount = GetF("grain-amount", 0.025),
    GrainScale = GetF("grain-scale", 1.0),
    GrainTime = timeAu * GetF("grain-speed", 1.0),
    GrainColored = flags.Contains("grain-colored"),
});
Png.Write(outPath, pixels, width, height);
Console.WriteLine($"wrote {outPath}");
return 0;

/// <summary>Tiny tuple-vector helpers shared by the slice/camera setup.</summary>
internal static class VecOps
{
    public static (double x, double y, double z) Norm((double x, double y, double z) v)
    {
        double len = Math.Sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        return (v.x / len, v.y / len, v.z / len);
    }

    public static (double x, double y, double z) Cross(
        (double x, double y, double z) a, (double x, double y, double z) b) =>
        (a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
