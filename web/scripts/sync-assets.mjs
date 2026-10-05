// =============================================================================
// sync-assets.mjs — copy the repo's shared runtime data into public/generated/.
//
// The web demo consumes the *same* files as the C# export host: the baked
// HORB asset, the palette definitions, and the shared GLSL sources. Next.js
// only serves files under public/, so this script (wired as predev/prebuild)
// refreshes a gitignored mirror there. Editing a shader or re-baking the
// asset therefore propagates to the web demo on the next dev reload or build
// with no manual step — the "edit once, get results everywhere" contract.
// =============================================================================

import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(webRoot);
const dest = join(webRoot, "public", "generated");

mkdirSync(join(dest, "shaders"), { recursive: true });

for (const f of ["orbitals.bin", "palettes.json"])
  cpSync(join(repoRoot, "assets", f), join(dest, f));

// Split the certified bake without resampling. A state needs only two tables
// to render its first frame, rather than the entire 16 MB catalog.
const orbital = readFileSync(join(repoRoot, "assets", "orbitals.bin"));
const headerLength = orbital.readUInt32LE(8);
const header = JSON.parse(orbital.subarray(12, 12 + headerLength).toString("utf8"));
const blobOffset = 12 + headerLength;
mkdirSync(join(dest, "tables"), { recursive: true });
const table = (name, offset, samples) => {
  const begin = blobOffset + offset * 4;
  writeFileSync(join(dest, "tables", name), orbital.subarray(begin, begin + samples * 4));
};
for (const t of header.radial_tables)
  table(`r-${t.n}-${t.l}.bin`, t.offset, header.radial_samples);
for (const t of header.angular_tables)
  table(`a-${t.l}-${t.m}.bin`, t.offset, header.angular_samples);
writeFileSync(join(dest, "orbitals.json"), JSON.stringify({
  nMax: header.n_max,
  extent: header.extent,
  radialSamples: header.radial_samples,
  angularSamples: header.angular_samples,
  radial: header.radial_tables.map((t) => [t.n, t.l, t.r_max]),
  angular: header.angular_tables.map((t) => [t.l, t.m]),
  stats: header.stats.map((s) => [s.n, s.l, s.m, s.mode === "real" ? 1 : 0,
    s.max, s.q999, s.q9999]),
}));

for (const f of readdirSync(join(repoRoot, "shaders")))
  if (/\.(glsl|vert|frag)$/.test(f))
    cpSync(join(repoRoot, "shaders", f), join(dest, "shaders", f));

console.log(`sync-assets: refreshed ${dest}`);
