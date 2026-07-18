// =============================================================================
// next.config.mjs — static export ("next build" → out/), no server runtime.
// The demo is pure client-side WebGL2; everything it loads at runtime
// (orbitals.bin, palettes.json, the shared shaders) is copied into
// public/generated/ by scripts/sync-assets.mjs on every dev/build.
// =============================================================================

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  reactStrictMode: true,
};

export default nextConfig;
