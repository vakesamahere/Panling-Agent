'use strict';
// Can every recorded place actually be planned to? Reports the snapped cell and, when the plan fails, why.
// node check_places.js [fromPlaceName]
const G = require('./graph');
const IDX = G.load('./data', { maxRegions: 40 });
const names = IDX.block_names;
const P = require('C:/Users/Administrator/Desktop/vake/mc/agent/memory/world.json').places;
const fromName = process.argv[2] || '皇城南門';
const from = P[fromName];
const bad = [];
for (const k of Object.keys(P)) {
  const p = P[k];
  const near = G.cellsNear(p.x, p.y, p.z, 2.0, 1.0);
  const c = near[0];
  const cells = G.plan([from.x, from.y, from.z], [p.x, p.y, p.z], { maxNodes: 1500000 });
  const row = {
    place: k, snapped: c ? [c.x, c.y, c.z, names[c.fb >> 4]] : null,
    plan: cells.length ? 'ok' : (cells.info.why || 'fail'),
    cells: cells.length || null,
    goalFallback: cells.info.goalFallback || null,
    end: cells.length ? [cells[cells.length - 1].x, cells[cells.length - 1].y, cells[cells.length - 1].z] : null,
    ms: Math.round(cells.info.ms || 0),
  };
  if (!cells.length) bad.push(k);
  console.log(JSON.stringify(row));
}
console.log(JSON.stringify({ from: fromName, bad }));
