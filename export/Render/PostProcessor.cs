// =============================================================================
// PostProcessor.cs — CPU twin of the web host's display-referred finishing.
//
// The analytic renderers return their established RGBA8 image first. Optional
// bloom, grade, vignette, aberration, and grain then operate on those pixels,
// preserving the validated density/current/clip pipeline and keeping the
// default (post disabled) byte-identical.
// =============================================================================

using System.Numerics;

namespace Hydrogen.Export.Render;

public sealed record PostProcessParams
{
    public bool Enabled { get; init; }
    public bool BloomEnabled { get; init; } = true;
    public double BloomThreshold { get; init; } = 0.72;
    public double BloomKnee { get; init; } = 0.4;
    public double BloomIntensity { get; init; } = 0.55;
    public double BloomRadius { get; init; } = 1.0;
    public int BloomIterations { get; init; } = 3;
    public double BloomScale { get; init; } = 0.5;
    public double BloomSaturation { get; init; } = 1.0;
    public Vector3 BloomTint { get; init; } = Vector3.One;
    /// <summary>0 screen, 1 additive.</summary>
    public int BloomComposite { get; init; }
    public double Exposure { get; init; }
    public double Contrast { get; init; } = 1.0;
    public double Saturation { get; init; } = 1.0;
    public double Vibrance { get; init; }
    public double AberrationPx { get; init; }
    public double AberrationFalloff { get; init; } = 1.5;
    public bool VignetteEnabled { get; init; }
    public double VignetteAmount { get; init; } = 0.28;
    public double VignetteRadius { get; init; } = 0.82;
    public double VignetteSoftness { get; init; } = 0.38;
    public double VignetteRoundness { get; init; } = 1.0;
    public double VignetteCenterX { get; init; }
    public double VignetteCenterY { get; init; }
    public bool GrainEnabled { get; init; }
    public double GrainAmount { get; init; } = 0.025;
    public double GrainScale { get; init; } = 1.0;
    public double GrainTime { get; init; }
    public bool GrainColored { get; init; }
}

public static class PostProcessor
{
    private static float Clamp(float x, float lo = 0f, float hi = 1f) =>
        Math.Clamp(x, lo, hi);
    private static float Fract(float x) => x - MathF.Floor(x);
    private static Vector3 Max(Vector3 v, float floor = 0f) =>
        new(MathF.Max(v.X, floor), MathF.Max(v.Y, floor), MathF.Max(v.Z, floor));
    private static Vector3 Clamp01(Vector3 v) =>
        new(Clamp(v.X), Clamp(v.Y), Clamp(v.Z));
    private static float Luma(Vector3 v) =>
        Vector3.Dot(v, new Vector3(0.2126f, 0.7152f, 0.0722f));

    public static byte[] Apply(byte[] scene, int width, int height, PostProcessParams p)
    {
        if (!p.Enabled) return scene;

        Vector3[]? bloom = null;
        int bw = 0, bh = 0;
        if (p.BloomEnabled && p.BloomIntensity > 0)
        {
            double scale = Math.Clamp(p.BloomScale, 0.125, 1.0);
            bw = Math.Max(1, (int)Math.Round(width * scale));
            bh = Math.Max(1, (int)Math.Round(height * scale));
            bloom = ExtractBloom(scene, width, height, bw, bh, p);
            var scratch = new Vector3[bloom.Length];
            int iterations = Math.Clamp(p.BloomIterations, 1, 8);
            float radius = (float)Math.Max(0.05, p.BloomRadius);
            for (int i = 0; i < iterations; i++)
            {
                Blur(bloom, scratch, bw, bh, radius, horizontal: true);
                Blur(scratch, bloom, bw, bh, radius, horizontal: false);
            }
        }

        var output = new byte[scene.Length];
        float aspect = (float)width / Math.Max(height, 1);
        for (int y = 0; y < height; y++)
        for (int x = 0; x < width; x++)
        {
            float u = (x + 0.5f) / width;
            float vTop = (y + 0.5f) / height;
            float vShader = 1f - vTop; // GLSL vUv/gl_FragCoord origin is bottom-left.
            Vector2 centered = new(u - 0.5f, vShader - 0.5f);
            float radial = MathF.Pow(Clamp(centered.Length() * 1.4142f),
                                     (float)Math.Max(p.AberrationFalloff, 0.01));
            Vector2 direction = centered.LengthSquared() > 1e-12f
                ? Vector2.Normalize(centered) : Vector2.Zero;
            Vector2 delta = direction * (float)p.AberrationPx * radial
                / new Vector2(width, height);
            Vector3 mid = SampleScene(scene, width, height, u, vTop);
            Vector3 plus = SampleScene(scene, width, height, u + delta.X, vTop - delta.Y);
            Vector3 minus = SampleScene(scene, width, height, u - delta.X, vTop + delta.Y);
            Vector3 c = new(plus.X, mid.Y, minus.Z);

            if (bloom != null)
            {
                Vector3 b = Max(Sample(bloom, bw, bh, u, vTop))
                    * (float)Math.Max(p.BloomIntensity, 0);
                c = p.BloomComposite == 1
                    ? c + b
                    : Vector3.One - (Vector3.One - c) * (Vector3.One - Clamp01(b));
            }

            c *= MathF.Pow(2f, (float)p.Exposure);
            c = (c - new Vector3(0.5f)) * (float)Math.Max(p.Contrast, 0) + new Vector3(0.5f);
            float luma = Luma(c);
            c = Vector3.Lerp(new Vector3(luma), c, (float)Math.Max(p.Saturation, 0));
            float range = MathF.Max(c.X, MathF.Max(c.Y, c.Z))
                        - MathF.Min(c.X, MathF.Min(c.Y, c.Z));
            c = Vector3.Lerp(new Vector3(luma), c,
                1f + (float)p.Vibrance * (1f - Clamp(range)));

            if (p.VignetteEnabled)
            {
                Vector2 q = centered - new Vector2(
                    (float)p.VignetteCenterX, (float)p.VignetteCenterY);
                q.X *= float.Lerp(1f, aspect, Clamp((float)p.VignetteRoundness));
                float radius = (float)Math.Max(p.VignetteRadius, 1e-4);
                float inner = (float)Math.Max(p.VignetteRadius - p.VignetteSoftness, 0);
                float edge = Smoothstep(inner, radius, q.Length());
                c *= 1f - Clamp((float)p.VignetteAmount) * edge;
            }

            if (p.GrainEnabled && p.GrainAmount > 0)
            {
                float grainScale = (float)Math.Max(p.GrainScale, 0.25);
                float gx = MathF.Floor(x / grainScale);
                float gy = MathF.Floor((height - 1 - y) / grainScale);
                Vector3 n = p.GrainColored
                    ? new(Hash12(gx + (float)p.GrainTime * 17.1f,
                                 gy + (float)p.GrainTime * 9.2f),
                          Hash12(gx + (float)p.GrainTime * 5.7f + 31f,
                                 gy + (float)p.GrainTime * 23.4f + 31f),
                          Hash12(gx + (float)p.GrainTime * 13.8f + 67f,
                                 gy + (float)p.GrainTime * 3.1f + 67f))
                    : new Vector3(Hash12(gx + (float)p.GrainTime * 17.1f,
                                         gy + (float)p.GrainTime * 9.2f));
                float response = 1f - MathF.Abs(2f * Clamp(luma) - 1f);
                c += (n - new Vector3(0.5f)) * (float)p.GrainAmount
                    * float.Lerp(0.35f, 1f, response);
            }

            c = Clamp01(c);
            int i = 4 * (y * width + x);
            output[i] = (byte)Math.Clamp((int)Math.Round(c.X * 255), 0, 255);
            output[i + 1] = (byte)Math.Clamp((int)Math.Round(c.Y * 255), 0, 255);
            output[i + 2] = (byte)Math.Clamp((int)Math.Round(c.Z * 255), 0, 255);
            output[i + 3] = 255;
        }
        return output;
    }

    private static Vector3[] ExtractBloom(
        byte[] scene, int sw, int sh, int w, int h, PostProcessParams p)
    {
        var output = new Vector3[w * h];
        float threshold = (float)p.BloomThreshold;
        float knee = MathF.Max(threshold * (float)p.BloomKnee, 1e-5f);
        for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++)
        {
            Vector3 c = Max(SampleScene(scene, sw, sh, (x + 0.5f) / w, (y + 0.5f) / h));
            float peak = MathF.Max(c.X, MathF.Max(c.Y, c.Z));
            float soft = Clamp(peak - threshold + knee, 0, 2 * knee);
            soft = soft * soft / (4 * knee + 1e-5f);
            float contribution = MathF.Max(peak - threshold, soft) / MathF.Max(peak, 1e-5f);
            float luma = Luma(c);
            c = Vector3.Lerp(new Vector3(luma), c, (float)Math.Max(p.BloomSaturation, 0));
            output[y * w + x] = c * p.BloomTint * contribution;
        }
        return output;
    }

    private static void Blur(
        Vector3[] src, Vector3[] dst, int w, int h, float radius, bool horizontal)
    {
        float[] offsets = [0f, 1.3846153846f, -1.3846153846f, 3.2307692308f, -3.2307692308f];
        float[] weights = [0.2270270270f, 0.3162162162f, 0.3162162162f, 0.0702702703f, 0.0702702703f];
        for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++)
        {
            Vector3 sum = Vector3.Zero;
            for (int i = 0; i < offsets.Length; i++)
            {
                float sx = x + (horizontal ? offsets[i] * radius : 0);
                float sy = y + (horizontal ? 0 : offsets[i] * radius);
                sum += SamplePixel(src, w, h, sx, sy) * weights[i];
            }
            dst[y * w + x] = sum;
        }
    }

    private static Vector3 SampleScene(byte[] src, int w, int h, float u, float v)
    {
        u = Clamp(u); v = Clamp(v);
        float x = u * w - 0.5f, y = v * h - 0.5f;
        int x0 = Math.Clamp((int)MathF.Floor(x), 0, w - 1);
        int y0 = Math.Clamp((int)MathF.Floor(y), 0, h - 1);
        int x1 = Math.Min(x0 + 1, w - 1), y1 = Math.Min(y0 + 1, h - 1);
        float tx = x - MathF.Floor(x), ty = y - MathF.Floor(y);
        Vector3 Get(int px, int py)
        {
            int i = 4 * (py * w + px);
            return new(src[i] / 255f, src[i + 1] / 255f, src[i + 2] / 255f);
        }
        return Vector3.Lerp(Vector3.Lerp(Get(x0, y0), Get(x1, y0), tx),
                            Vector3.Lerp(Get(x0, y1), Get(x1, y1), tx), ty);
    }

    private static Vector3 Sample(Vector3[] src, int w, int h, float u, float v) =>
        SamplePixel(src, w, h, Clamp(u) * w - 0.5f, Clamp(v) * h - 0.5f);

    private static Vector3 SamplePixel(Vector3[] src, int w, int h, float x, float y)
    {
        int x0 = Math.Clamp((int)MathF.Floor(x), 0, w - 1);
        int y0 = Math.Clamp((int)MathF.Floor(y), 0, h - 1);
        int x1 = Math.Min(x0 + 1, w - 1), y1 = Math.Min(y0 + 1, h - 1);
        float tx = x - MathF.Floor(x), ty = y - MathF.Floor(y);
        return Vector3.Lerp(
            Vector3.Lerp(src[y0 * w + x0], src[y0 * w + x1], tx),
            Vector3.Lerp(src[y1 * w + x0], src[y1 * w + x1], tx), ty);
    }

    private static float Smoothstep(float a, float b, float x)
    {
        float t = Clamp((x - a) / MathF.Max(b - a, 1e-6f));
        return t * t * (3f - 2f * t);
    }

    private static float Hash12(float x, float y)
    {
        float px = Fract(x * 0.1031f), py = Fract(y * 0.1031f), pz = px;
        float dot = px * (py + 33.33f) + py * (pz + 33.33f) + pz * (px + 33.33f);
        px += dot; py += dot; pz += dot;
        return Fract((px + py) * pz);
    }
}
