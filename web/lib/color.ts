// =============================================================================
// color.ts — small color conversions for the palette editor.
//
// The shader interpolates ramp stops in OKLab (assets/palettes.json carries
// both spaces; see lab/scripts/palettes.jl). A user-edited ramp is defined in
// sRGB hex, so the web host must derive the OKLab stops itself — with the
// same constants the shader/lab use (Björn Ottosson's; mirrors
// shaders/common.glsl and lab/src/color.jl).
// =============================================================================

export type Rgb = [number, number, number];

/** "#rrggbb" (or "rrggbb") → sRGB in [0,1]. Returns null on malformed input. */
export function hexToSrgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

export function srgbToHex([r, g, b]: Rgb): string {
  const q = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${q(r)}${q(g)}${q(b)}`;
}

function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearChannelToSrgb(c: number): number {
  const x = Math.max(0, Math.min(1, c));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** Gamma sRGB [0,1]³ → OKLab (L, a, b). */
export function srgbToOklab(srgb: Rgb): Rgb {
  const [r, g, b] = srgb.map(srgbChannelToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab (L, a, b) → OKLCH (L, C, h°): the same color in cylindrical form, the
 * natural space for a perceptual color picker (lightness / chroma / hue). */
export function oklabToOklch([L, a, b]: Rgb): Rgb {
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, C, h];
}

/** OKLCH (L, C, h°) → OKLab (L, a, b). */
export function oklchToOklab([L, C, h]: Rgb): Rgb {
  const hr = (h * Math.PI) / 180;
  return [L, C * Math.cos(hr), C * Math.sin(hr)];
}

/** OKLab → gamma sRGB [0,1]³ (clamped into gamut). */
export function oklabToSrgb(lab: Rgb): Rgb {
  const l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
  const m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
  const s_ = lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2];
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    linearChannelToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearChannelToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearChannelToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
