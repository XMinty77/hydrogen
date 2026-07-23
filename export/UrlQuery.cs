// =============================================================================
// UrlQuery.cs — translate a web-demo URL into CLI options.
// =============================================================================
//
// The web demo mirrors its whole state into the query string (see
// web/lib/params.ts — the writer). This class parses that vocabulary back so
//
//     dotnet run -- url "https://…/hydrogen/?state=4,2,1&integrator=iso&…"
//
// renders offline exactly what the browser showed. Accepted inputs: a full
// URL, a bare query string, with or without the leading '?', and — because
// nobody remembers which part it is — the fragment ('#…') is searched too if
// the query is empty.
//
// Every recognized key fills the CLI option dictionary ONLY if the user did
// not pass the equivalent flag explicitly: command-line arguments always win.
// Unknown keys are ignored (forward compatibility with future web params).
// =============================================================================

using System.Web;

namespace Hydrogen.Export;

public static class UrlQuery
{
    /// <summary>Web query key → CLI option name, for keys that are a straight
    /// value copy. Keys with structure (clip, lightAz/El, slice geometry) are
    /// handled in Apply.</summary>
    private static readonly (string web, string cli)[] Direct =
    [
        ("state", "state"), ("mode", "mode"), ("color", "color"),
        ("value", "value"), ("gamma", "gamma"),
        ("compress", "compress"), ("compressK", "compress-k"),
        ("compressWhite", "compress-white"),
        ("bloomThreshold", "bloom-threshold"), ("bloomKnee", "bloom-knee"),
        ("bloomIntensity", "bloom-intensity"), ("bloomRadius", "bloom-radius"),
        ("bloomIterations", "bloom-iterations"), ("bloomScale", "bloom-scale"),
        ("bloomSaturation", "bloom-saturation"), ("bloomTint", "bloom-tint"),
        ("bloomComposite", "bloom-composite"),
        ("postExposure", "post-exposure"), ("postContrast", "post-contrast"),
        ("postSaturation", "post-saturation"), ("postVibrance", "post-vibrance"),
        ("postAberration", "post-aberration"),
        ("postAberrationFalloff", "post-aberration-falloff"),
        ("vignetteAmount", "vignette-amount"), ("vignetteRadius", "vignette-radius"),
        ("vignetteSoftness", "vignette-softness"),
        ("vignetteRoundness", "vignette-roundness"),
        ("vignetteCenterX", "vignette-center-x"),
        ("vignetteCenterY", "vignette-center-y"),
        ("grainAmount", "grain-amount"), ("grainScale", "grain-scale"),
        ("grainSpeed", "grain-speed"),
        ("ramp", "ramp"), ("rampSpace", "ramp-space"), ("rampStops", "ramp-stops"),
        ("chromaPow", "phase-chroma-pow"), ("phaseL", "phase-L"),
        ("phaseC", "phase-C"), ("phaseH0Deg", "phase-h0-deg"),
        ("terms", "terms"), ("t", "time"),
        ("integrator", "integrator"), ("steps", "steps"),
        ("density", "density"), ("opacityPow", "opacity-pow"),
        ("emission", "emission"), ("tonemap", "tonemap"), ("exposure", "exposure"),
        ("fov", "fov"), ("camera", "camera"),
        ("lightGain", "light-gain"), ("hgG", "hg-g"),
        ("shadowSteps", "shadow-steps"), ("shadowDensity", "shadow-density"),
        ("octaves", "octaves"), ("octaveGain", "octave-gain"),
        ("octaveExt", "octave-ext"), ("ambientGain", "ambient-gain"),
        ("ambientDirs", "ambient-dirs"), ("ambientRadius", "ambient-radius"),
        ("ambientDensity", "ambient-density"),
        ("midaGamma", "mida-gamma"),
        ("isoLevel", "iso-level"), ("isoCount", "iso-count"),
        ("isoSpacing", "iso-spacing"), ("isoAlpha", "iso-alpha"),
        ("isoEmission", "iso-emission"), ("isoRim", "iso-rim"),
        ("isoAmbient", "iso-ambient"),
        ("shadeModel", "shade-model"), ("shadeDiffuse", "shade-diffuse"),
        ("shadeSpec", "shade-spec"), ("shadeRough", "shade-rough"),
        ("shadeF0", "shade-f0"), ("shadeConf", "shade-conf"),
        ("gradDelta", "grad-delta"),
        ("maxBounces", "max-bounces"), ("albedo", "albedo"),
        ("scatterTint", "scatter-tint"), ("spp", "spp"),
        ("aperture", "aperture"), ("focus", "focus"),
        ("ptEnv", "env"), ("ptEnvGain", "env-gain"),
        ("eikSteps", "steps"), ("iorScale", "ior-scale"), ("eikMap", "eik-map"),
        ("eikPow", "eik-pow"), ("eikLogK", "eik-log-k"), ("absorb", "absorb"),
        ("eikEmission", "eik-emission"), ("dispersion", "dispersion"),
        ("eikEnv", "env"), ("eikEnvGain", "env-gain"),
        ("eikGradDelta", "grad-delta"),
        // slice geometry (offset/zoom are framing-relative in the web).
        ("plane", "plane"), ("az", "plane-az"), ("el", "plane-el"),
        ("roll", "plane-roll"), ("offset", "offset-frac"), ("zoom", "zoom"),
    ];

    /// <summary>Parse `link` and fill `opt`/`flags`/`urlClips` with everything
    /// found; existing entries in `opt` are never overwritten. Returns the
    /// URL's view ("slice"/"volume") or null if it doesn't say.</summary>
    public static string? Apply(string link, Dictionary<string, string> opt,
                                HashSet<string> flags, List<string> urlClips)
    {
        string query = ExtractQuery(link);
        var q = HttpUtility.ParseQueryString(query);

        foreach (var (web, cli) in Direct)
        {
            string? v = q[web];
            if (v != null && !opt.ContainsKey(cli)) opt[cli] = v;
        }

        // Boolean-ish switches.
        if (q["vivid"] == "0") flags.Add("phase-constant");
        if (q["dither"] == "0") flags.Add("no-dither");
        if (q["normalize"] == "0") flags.Add("no-normalize");
        if (q["okSigned"] == "1") flags.Add("okphase-signed");
        if (q["post"] == "1") flags.Add("post");
        if (q["bloom"] == "0") flags.Add("no-bloom");
        if (q["vignette"] == "1") flags.Add("vignette");
        if (q["grain"] == "1") flags.Add("grain");
        if (q["grainColor"] == "1") flags.Add("grain-colored");

        // Clip planes: web specs are camera-basis-relative; the caller
        // converts them once the camera pose exists.
        string[]? clips = q.GetValues("clip");
        if (clips != null && urlClips.Count == 0) urlClips.AddRange(clips);

        return q["view"];
    }

    private static string ExtractQuery(string link)
    {
        // Full URL → query part; else assume the string IS the query. If the
        // query is empty but a fragment exists, search that instead.
        int qi = link.IndexOf('?');
        int hi = link.IndexOf('#');
        if (qi >= 0)
        {
            int end = hi > qi ? hi : link.Length;
            string query = link[(qi + 1)..end];
            if (query.Length > 0) return query;
        }
        if (hi >= 0) return link[(hi + 1)..].TrimStart('?');
        return link.TrimStart('?');
    }
}
