'use strict';
// node test.js  -> runs the 12 皇城 pairs + all testset_v3 pairs, compares with the HPC results, writes test_results.json
const fs = require('fs'), path = require('path');
const G = require('./graph');
const T = path.join(__dirname, '..', 'testset_v3');
let t0 = Date.now(); G.load(path.join(__dirname, 'data'), { maxRegions: +(process.env.MAXREG || 4) });
console.log('index load ms', Date.now() - t0);
const cases = [];
for (const r of JSON.parse(fs.readFileSync(path.join(T, 'huangcheng_world.json'), 'utf8'))) cases.push(['皇城', r.frm, r.to, r.frm_xyz, r.to_xyz, r.length]);
for (const r of JSON.parse(fs.readFileSync(path.join(T, 'results.json'), 'utf8')).rows) {
  const f = path.join(T, r.frm + '__' + r.to + '.json'); if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f, 'utf8')); cases.push(['v3', r.frm, r.to, d.frm_xyz, d.to_xyz, d.length]);
}
const out = []; let bad = 0;
console.log('set  | from -> to | hpc len | node len | diff | tp | ms | expanded | regions | rssMB');
for (const [set, a, b, pa, pb, hl] of cases) {
  const c = G.plan(pa, pb, { maxNodes: 1000000 }); const i = c.info;
  const nl = i.reachable ? i.length : null; const diff = nl == null ? null : nl - hl;
  if (nl == null || Math.abs(diff) > 0.05) bad++;
  const tp = c.filter((p) => p.act === 'teleport').length;
  out.push({ set, frm: a, to: b, hpc_length: hl, node_length: nl, diff, teleports: tp, ms: i.ms, expanded: i.expanded, regions: i.regionsLoaded, rss_mb: G.memoryMB() });
  console.log([set, a + ' -> ' + b, hl, nl == null ? 'UNREACH' : nl.toFixed(2), diff == null ? '-' : diff.toFixed(2), tp, i.ms.toFixed(0), i.expanded, i.regionsLoaded, G.memoryMB().toFixed(0)].join(' | '));
}
console.log('cases', cases.length, 'mismatch(>0.05)', bad, 'peak rss MB', Math.max(...out.map((o) => o.rss_mb)).toFixed(0));
fs.writeFileSync(path.join(__dirname, 'test_results.json'), JSON.stringify(out, null, 1));
