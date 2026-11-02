'use strict';
// Dump every teleport edge (source cell -> landing cell) into data/teleport_edges.json.
// An admissible A* bound needs the *source* of each teleport, because a teleport costs 10 but jumps far:
// straight-line distance alone makes A* skip teleport routes (村莊大門->補給品簡方: 46.6 instead of 20.1).
const fs = require('fs'), path = require('path');
const G = require('./graph');
const IDX = require('./data/index.json');
G.load(path.join(__dirname, 'data'), { maxRegions: 1000 });
const out = [];
for (const R of IDX.regions) {
  // touch the region centre so it gets loaded, then walk its edges through the public API
  const cx = R.x0 + 256, cz = R.z0 + 256;
  const seed = G.cellsNear(cx, 0, cz, 400, 1e9)[0] || G.cellsNear(cx, 200, cz, 400, 1e9)[0];
  if (!seed) continue;
  const r = G.regionOf(seed.id);
  if (!r) continue;
  for (let k = 0; k < r.n; k++) for (let e = r.ptr[k]; e < r.ptr[k + 1]; e++) {
    if (G.ETN[r.et[e]] !== 'teleport') continue;
    // the destination may live in another region, so resolve it globally
    const d = G.cell(r.dst[e]); if (!d) continue;
    out.push([r.x[k], r.f[k], r.z[k], d.x, d.f, d.z]);
  }
}
const uniq = new Map(); for (const q of out) uniq.set(q.join(','), q);
const list = [...uniq.values()];
fs.writeFileSync(path.join(__dirname, 'data', 'teleport_edges.json'), JSON.stringify(list));
console.log('teleport edges', out.length, 'unique', list.length, JSON.stringify(list.slice(0, 3)));
