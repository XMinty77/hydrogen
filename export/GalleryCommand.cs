// =============================================================================
// GalleryCommand.cs — the exhaustive still-image gallery batch (M4).
// =============================================================================
//
// Implements docs/gallery-spec.md: for every state |n, l, m⟩ with n ≤ n_max
// and m ≥ 0 (the −m images are exact transforms; see the spec), renders the
// 18-image set (17 when the equatorial slice is parity-skipped) into
//   gallery/stills/n{n}/l{l}/m{m}/*.png
// and writes one static HTML contact sheet per n plus a master index.
//
// Everything runs in one process on one GL context with cached tables —
// per-image process startup would otherwise dominate the batch. PNG encoding
// is offloaded to a bounded task queue so the GPU never waits on the encoder.
// =============================================================================

using Hydrogen.Export.Gl;
using Hydrogen.Export.Horb;
using Hydrogen.Export.Palettes;
using Hydrogen.Export.Render;
using System.Diagnostics;
using System.Text;

namespace Hydrogen.Export;

public static class GalleryCommand
{
    /// <summary>Camera presets from the spec: name → (azimuth°, elevation°,
    /// distance in framing radii). The top view sits farther out: looking down
    /// the z-axis, the orbital's equatorial footprint projects wider than in
    /// the ¾ view, and 2.6× was measured to crop bright structure at n = 10.</summary>
    private static readonly (string name, double az, double el, double dist)[] Views =
    [
        ("q34", 35, 25, 2.6),       // canonical ¾
        ("side", 0, 0, 2.6),        // perfectly horizontal profile (user, 2026-07-19)
        ("side_tilt", 0, 15, 2.6),  // secondary side view, slightly tilted
        ("diag_side", 0, 60, 2.9),  // 30° down from the top, no azimuthal rotation
        ("top", 35, 78, 3.1),       // down the z-axis
    ];

    public static int Run(string root, HorbAsset asset, PaletteSet palettes,
                          Dictionary<string, string> opt)
    {
        int nMax = int.Parse(opt.GetValueOrDefault("n-max", asset.NMax.ToString()));
        int size = int.Parse(opt.GetValueOrDefault("size", "1024"));
        int ss = int.Parse(opt.GetValueOrDefault("ss", "2"));
        int steps = int.Parse(opt.GetValueOrDefault("steps", "600"));
        string outRoot = opt.GetValueOrDefault("out-root",
            Path.Combine(root, "gallery", "stills"));
        // Optional single-state filter for smoke tests: --only N,L,M
        int[]? only = opt.TryGetValue("only", out var o)
            ? o.Split(',').Select(int.Parse).ToArray() : null;

        int render = size * ss;                    // supersampled render size
        using var ctx = new OffscreenGl(Path.Combine(root, "shaders"));
        var slices = new SliceRenderer(ctx, asset, palettes);
        var volumes = new VolumeRenderer(ctx, asset, palettes);

        // Bounded PNG-encode queue: the GPU renders ahead while CPU encodes.
        using var encodeSlots = new SemaphoreSlim(Environment.ProcessorCount);
        var encodeTasks = new List<Task>();
        void Save(string path, byte[] pixels)
        {
            encodeSlots.Wait();
            encodeTasks.Add(Task.Run(() =>
            {
                try { Png.WriteDownsampled(path, pixels, render, render, ss); }
                finally { encodeSlots.Release(); }
            }));
        }

        var clock = Stopwatch.StartNew();
        int images = 0;

        for (int n = 1; n <= nMax; n++)
        {
            for (int l = 0; l < n; l++)
            for (int m = 0; m <= l; m++)
            {
                if (only != null && (n != only[0] || l != only[1] || m != only[2]))
                    continue;

                string dir = Path.Combine(outRoot, $"n{n}", $"l{l}", $"m{m}");
                double extent = asset.FramingRadius(n);

                CommonParams Common(bool real, int colorMode) => new()
                {
                    N = n, L = l, M = m, RealMode = real, ColorMode = colorMode,
                    Width = render, Height = render, Gamma = 0.71,
                };

                // ---- 2D slices --------------------------------------------------
                var xz = ((0.0, 0.0, 0.0), (extent, 0.0, 0.0), (0.0, 0.0, extent));
                byte[] Slice(bool real, int color,
                             ((double, double, double) o,
                              (double, double, double) u,
                              (double, double, double) v) plane) =>
                    slices.Render(new SliceParams
                    {
                        Common = Common(real, color),
                        Origin = plane.o, AxisU = plane.u, AxisV = plane.v,
                    });

                Save(Path.Combine(dir, "2d_real_xz.png"), Slice(true, 0, xz));
                Save(Path.Combine(dir, "2d_signed_xz.png"), Slice(true, 1, xz));

                // Equatorial slice only when parity doesn't null it (P̄_l^m(0) = 0
                // for odd l−m ⇒ the z = 0 plane is exactly nodal).
                if ((l - m) % 2 == 0)
                {
                    var xy = ((0.0, 0.0, 0.0), (extent, 0.0, 0.0), (0.0, extent, 0.0));
                    Save(Path.Combine(dir, "2d_real_xy.png"), Slice(true, 0, xy));
                }

                // Complex phase slice: xz for m = 0 (no azimuthal structure);
                // otherwise the xy plane offset to the state's brightest point
                // (z* = r*·cosθ*, argmaxes read straight off the baked tables) —
                // guaranteed to cut through the dominant torus.
                if (m == 0)
                {
                    Save(Path.Combine(dir, "2d_complex_phase.png"), Slice(false, 2, xz));
                }
                else
                {
                    var rt = asset.Radial[(n, l)];
                    var at = asset.Angular[(l, m)];
                    int ri = ArgMaxAbs(rt.Values);
                    int ti = ArgMaxAbs(at.Values);
                    double rStar = rt.RMax * Math.Pow(ri / (double)(rt.Values.Length - 1), 2);
                    double thetaStar = Math.PI * ti / (at.Values.Length - 1);
                    double zStar = rStar * Math.Cos(thetaStar);
                    var xyOff = ((0.0, 0.0, zStar), (extent, 0.0, 0.0), (0.0, extent, 0.0));
                    Save(Path.Combine(dir, "2d_complex_phase.png"), Slice(false, 2, xyOff));
                }

                // ---- 3D volumes -------------------------------------------------
                byte[] Volume(bool real, int color, double az, double el,
                              double distFactor, int integrator, bool halfCut)
                {
                    var cam = OrbitCam(az, el, distFactor * extent);
                    // EA transfer (density/opacity/emission) rides on the
                    // VolumeParams defaults — the user-tuned values.
                    return volumes.Render(new VolumeParams
                    {
                        Common = Common(real, color),
                        CamPos = cam.pos, CamRight = cam.right,
                        CamUp = cam.up, CamFwd = cam.fwd,
                        Integrator = integrator, Steps = steps,
                        ClipPlanes = halfCut
                            ? new[] { (0.0, -1.0, 0.0, 0.0) }   // keep y ≤ 0
                            : Array.Empty<(double, double, double, double)>(),
                    });
                }

                // MIP reads well only through the brightness ramp (user,
                // 2026-07-19): the max-|ψ|² sample carries no depth context,
                // so signed/phase hues at it look arbitrary. Those color modes
                // ride the EA integrator instead — signed at all three angles.
                foreach (var (name, az, el, dist) in Views)
                {
                    Save(Path.Combine(dir, $"3d_mip_real_{name}.png"),
                         Volume(true, 0, az, el, dist, 0, false));
                    Save(Path.Combine(dir, $"3d_ea_signed_{name}.png"),
                         Volume(true, 1, az, el, dist, 1, false));
                }
                var (cAz, cEl, cDist) = (Views[0].az, Views[0].el, Views[0].dist);
                Save(Path.Combine(dir, "3d_ea_real_q34.png"),
                     Volume(true, 0, cAz, cEl, cDist, 1, false));
                Save(Path.Combine(dir, "3d_ea_real_cut.png"),
                     Volume(true, 0, cAz, cEl, cDist, 1, true));
                Save(Path.Combine(dir, "3d_ea_signed_cut.png"),
                     Volume(true, 1, cAz, cEl, cDist, 1, true));
                Save(Path.Combine(dir, "3d_ea_complex_q34.png"),
                     Volume(false, 2, cAz, cEl, cDist, 1, false));

                images += (l - m) % 2 == 0 ? 18 : 17;
            }

            if (only == null)
            {
                WriteContactSheet(outRoot, n);
                Console.WriteLine($"n={n} done  ({images} images, " +
                                  $"{clock.Elapsed.TotalMinutes:F1} min elapsed)");
            }
        }

        Task.WaitAll(encodeTasks.ToArray());
        if (only == null) WriteMasterIndex(outRoot, nMax);
        Console.WriteLine($"gallery complete: {images} images in " +
                          $"{clock.Elapsed.TotalMinutes:F1} min → {outRoot}");
        return 0;
    }

    private static int ArgMaxAbs(float[] values)
    {
        int best = 0;
        for (int i = 1; i < values.Length; i++)
            if (Math.Abs(values[i]) > Math.Abs(values[best])) best = i;
        return best;
    }

    /// <summary>Orbit camera looking at the origin, world-up +z (mirrors the
    /// volume CLI; kept here so the batch has no CLI dependency).</summary>
    private static ((double, double, double) pos, (double, double, double) right,
                    (double, double, double) up, (double, double, double) fwd)
        OrbitCam(double azDeg, double elDeg, double dist)
    {
        double az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180;
        var pos = (x: dist * Math.Cos(el) * Math.Cos(az),
                   y: dist * Math.Cos(el) * Math.Sin(az),
                   z: dist * Math.Sin(el));
        var fwd = Norm((-pos.x, -pos.y, -pos.z));
        var upRef = Math.Abs(elDeg) > 89 ? (1.0, 0.0, 0.0) : (0.0, 0.0, 1.0);
        var right = Norm(Cross(fwd, upRef));
        var up = Cross(right, fwd);
        return ((pos.x, pos.y, pos.z), right, up, fwd);

        static (double x, double y, double z) Norm((double x, double y, double z) v)
        {
            double len = Math.Sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
            return (v.x / len, v.y / len, v.z / len);
        }
        static (double x, double y, double z) Cross((double x, double y, double z) a,
                                                    (double x, double y, double z) b) =>
            (a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
    }

    // -------------------------------------------------------------------------
    // Contact sheets: one HTML grid per n, plus a master index. Plain static
    // HTML with lazy image loading — no dependencies, browsable from disk.
    // -------------------------------------------------------------------------

    private static readonly string[] ImageOrder =
    [
        "2d_real_xz", "2d_real_xy", "2d_signed_xz", "2d_complex_phase",
        "3d_mip_real_q34", "3d_mip_real_side", "3d_mip_real_side_tilt",
        "3d_mip_real_diag_side", "3d_mip_real_top",
        "3d_ea_real_q34", "3d_ea_real_cut",
        "3d_ea_signed_q34", "3d_ea_signed_side", "3d_ea_signed_side_tilt",
        "3d_ea_signed_diag_side", "3d_ea_signed_top",
        "3d_ea_signed_cut", "3d_ea_complex_q34",
    ];

    private static void WriteContactSheet(string outRoot, int n)
    {
        var html = new StringBuilder();
        html.Append($$"""
            <!doctype html><meta charset="utf-8"><title>n = {{n}} — hydrogen gallery</title>
            <style>
              body { background:#0b0512; color:#ddd; font:14px system-ui; margin:1.5rem; }
              h2 { color:#f0a832; margin:2rem 0 .5rem; }
              .row { display:flex; flex-wrap:wrap; gap:6px; }
              .row a img { width:150px; height:150px; object-fit:cover; display:block;
                           border:1px solid #2a1840; }
              p.note { color:#977; max-width:60rem; }
            </style>
            <h1>Hydrogen |n = {{n}}⟩ — all (l, m ≥ 0)</h1>
            <p class="note">Negative-m states are exact transforms of these:
            complex-mode images hue-mirror (ψ → ψ*), real-mode images rotate by
            π/2m about z. Image order per state: {{string.Join(", ", ImageOrder)}}.</p>
            """);
        for (int l = 0; l < n; l++)
        for (int m = 0; m <= l; m++)
        {
            html.Append($"<h2>|{n}, {l}, {m}⟩</h2><div class=\"row\">");
            foreach (var name in ImageOrder)
            {
                string rel = $"l{l}/m{m}/{name}.png";
                if (File.Exists(Path.Combine(outRoot, $"n{n}", rel)))
                    html.Append($"<a href=\"{rel}\"><img loading=\"lazy\" src=\"{rel}\" " +
                                $"title=\"{name}\"></a>");
            }
            html.Append("</div>");
        }
        File.WriteAllText(Path.Combine(outRoot, $"n{n}", "index.html"), html.ToString());
    }

    private static void WriteMasterIndex(string outRoot, int nMax)
    {
        var links = string.Join("", Enumerable.Range(1, nMax)
            .Select(n => $"<li><a href=\"n{n}/index.html\">n = {n}</a> — {n * (n + 1) / 2} states</li>"));
        File.WriteAllText(Path.Combine(outRoot, "index.html"), $$"""
            <!doctype html><meta charset="utf-8"><title>Hydrogen orbital gallery</title>
            <style>body { background:#0b0512; color:#ddd; font:16px system-ui; margin:3rem; }
                   a { color:#f0a832; }</style>
            <h1>Hydrogen orbital gallery (n ≤ {{nMax}}, m ≥ 0)</h1><ul>{{links}}</ul>
            """);
    }
}
