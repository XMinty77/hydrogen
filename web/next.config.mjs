// =============================================================================
// next.config.mjs — static export ("next build" → out/), no server runtime.
// The demo is pure client-side WebGL2; everything it loads at runtime
// (orbitals.bin, palettes.json, the shared shaders) is copied into
// public/generated/ by scripts/sync-assets.mjs on every dev/build.
// =============================================================================

// GitHub Pages serves this project site under a sub-path
// (xminty77.github.io/hydrogen), so the CI workflow exports
// PAGES_BASE_PATH=/hydrogen and Next prefixes its emitted asset/link URLs with
// it. Local dev and the screenshot harness leave the variable unset and keep
// serving from the root. Runtime data fetches use page-relative paths
// ("generated/…", no leading slash), so they follow the base path automatically
// without it being threaded through the client.
const basePath = process.env.PAGES_BASE_PATH ?? "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  reactStrictMode: true,
  ...(basePath ? { basePath } : {}),
};

export default nextConfig;
