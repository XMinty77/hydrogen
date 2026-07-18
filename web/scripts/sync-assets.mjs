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

import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(webRoot);
const dest = join(webRoot, "public", "generated");

mkdirSync(join(dest, "shaders"), { recursive: true });

for (const f of ["orbitals.bin", "palettes.json"])
  cpSync(join(repoRoot, "assets", f), join(dest, f));

for (const f of readdirSync(join(repoRoot, "shaders")))
  if (/\.(glsl|vert|frag)$/.test(f))
    cpSync(join(repoRoot, "shaders", f), join(dest, "shaders", f));

console.log(`sync-assets: refreshed ${dest}`);
