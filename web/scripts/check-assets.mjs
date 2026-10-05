import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadHorbIndex, parseHorb } from "../lib/horb.ts";

// Every generated table must remain byte-identical to the certified bake;
// requests for repeated terms and opposite m signs must share cached tables.
const bytes = await readFile(new URL("../../assets/orbitals.bin", import.meta.url));
const full = parseHorb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const requests = new Map();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  requests.set(url, (requests.get(url) ?? 0) + 1);
  return new Response(await readFile(new URL(`../public/${url}`, import.meta.url)));
};
try {
  const asset = await loadHorbIndex("generated/orbitals.json");
  assert.equal(asset.nMax, full.nMax);
  assert.equal(asset.extentFactor, full.extentFactor);
  assert.equal(asset.extentPad, full.extentPad);
  assert.deepEqual(asset.stats, full.stats);
  const duplicate = [{ n: 4, l: 2, m: 1 }, { n: 4, l: 2, m: -1 }];
  await Promise.all([asset.ensureTables(duplicate), asset.ensureTables(duplicate)]);
  assert.equal(requests.get("generated/tables/r-4-2.bin"), 1);
  assert.equal(requests.get("generated/tables/a-2-1.bin"), 1);
  assert.equal(asset.ensureTables(duplicate), null);
  const states = [];
  for (let n = 1; n <= full.nMax; n++)
    for (let l = 0; l < n; l++)
      for (let m = -l; m <= l; m++) states.push({ n, l, m });
  await asset.ensureTables(states);
  for (const name of ["radial", "angular"])
    for (const [key, table] of full[name])
      assert.deepEqual(asset[name].get(key), table, `${name} table ${key} differs from the bake`);
  assert.equal(requests.size, 651);
  assert([...requests.values()].every((n) => n === 1));
  console.log("PASS 650 byte-identical tables, 5850 statistics, signed-m caching, concurrent-request deduplication");
} finally {
  globalThis.fetch = originalFetch;
}
