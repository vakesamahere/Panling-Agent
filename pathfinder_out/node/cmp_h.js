'use strict';
const NEW = require('./graph');
const OLD = require('C:/Users/Administrator/Desktop/vake/mc/backup/graph_js_before_h_20261102.js');
const DIR = 'C:/Users/Administrator/Desktop/vake/mc/pathfinder_out/node/data';
NEW.load(DIR, { maxRegions: 40 }); OLD.load(DIR, { maxRegions: 40 });
const places = require('C:/Users/Administrator/Desktop/vake/mc/agent/memory/world.json').places;
const names = Object.keys(places);
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const N = +(process.argv[2] || 40);
const rows = [];
for (let i = 0; i < N; i++) {
  const a = names[Math.floor(rnd() * names.length)], b = names[Math.floor(rnd() * names.length)];
  if (a === b) continue;
  const A = places[a], B = places[b];
  const run = (G) => { const t = Date.now(); const c = G.plan([A.x, A.y, A.z], [B.x, B.y, B.z], { maxNodes: 1500000 }); return { ms: Date.now() - t, ok: c.length > 0, cost: c.info && c.info.cost, len: c.info && c.info.length, exp: c.info && c.info.expanded }; };
  const o = run(OLD), n = run(NEW);
  rows.push({ pair: a + '→' + b, oldMs: o.ms, newMs: n.ms, oldCost: o.cost && +o.cost.toFixed(1), newCost: n.cost && +n.cost.toFixed(1), same: o.ok === n.ok && Math.abs((o.cost || 0) - (n.cost || 0)) < 0.01, oldOk: o.ok, newOk: n.ok, oldExp: o.exp, newExp: n.exp });
  console.log(JSON.stringify(rows[rows.length - 1]));
}
const sum = (k) => +rows.reduce((s, r) => s + (r[k] || 0), 0).toFixed(1);
console.log(JSON.stringify({ n: rows.length, oldMs: sum('oldMs'), newMs: sum('newMs'), maxOld: Math.max(...rows.map(r => r.oldMs)), maxNew: Math.max(...rows.map(r => r.newMs)), sameCost: rows.filter(r => r.same).length, bothOk: rows.filter(r => r.oldOk && r.newOk).length, newFails: rows.filter(r => r.oldOk && !r.newOk).length, oldFails: rows.filter(r => !r.oldOk && r.newOk).length }));
