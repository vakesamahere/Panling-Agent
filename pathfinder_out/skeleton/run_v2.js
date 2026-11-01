'use strict';
// node run_v2.js <x0> <z0> <x1> <z1> [name] [--key=value ...]
// v2 = v1 skeleton + building (roofed / behind doors) and plaza regions as single nodes.
// Writes out/<name>_v2.png, out/<name>_v2_graph.json, out/<name>_v2_stats.json.
const fs = require('fs'), path = require('path');
const RG = require('./regions');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v = 'true'] = a.slice(2).split('=');
  return [k, v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v];
}));
if (args.length < 4) { console.error('usage: node run_v2.js <x0> <z0> <x1> <z1> [name] [--key=value]'); process.exit(1); }
const [a, b, c, d] = args.slice(0, 4).map(Number);
const box = { x0: Math.min(a, c), z0: Math.min(b, d), x1: Math.max(a, c), z1: Math.max(b, d) };
const name = (args[4] || `box_${box.x0}_${box.z0}_${box.x1}_${box.z1}`) + '_v2';
const scale = flags.scale || 3; delete flags.scale;
if (typeof flags.seeds === 'string') flags.seeds = flags.seeds.split(';').map((s) => s.split(',').map(Number));
const dataDir = path.join(__dirname, '..', 'node', 'data');
const outDir = path.join(__dirname, 'out'); fs.mkdirSync(outDir, { recursive: true });

const t0 = Date.now();
const res = RG.runV2(dataDir, box, flags);
const st = res.stats;
let t = Date.now(); const img = RG.renderV2(res, scale); fs.writeFileSync(path.join(outDir, name + '.png'), img.png); st.timing_ms.png_ms = Date.now() - t;
t = Date.now();
const opts = Object.assign({}, res.opts); delete opts.planarTypes;
fs.writeFileSync(path.join(outDir, name + '_graph.json'), JSON.stringify({ name, box, opts, stats: st, nodes: res.out.nodes, edges: res.out.edges.map((e) => { const r = Object.assign({}, e); delete r._cells; return r; }) }));
st.timing_ms.json_ms = Date.now() - t; st.timing_ms.total_ms = Date.now() - t0;
st.rss_mb = Math.round(process.memoryUsage().rss / 1e6); st.heap_mb = Math.round(process.memoryUsage().heapUsed / 1e6); st.png = { w: img.w, h: img.h, scale };
fs.writeFileSync(path.join(outDir, name + '_stats.json'), JSON.stringify({ name, box, opts, stats: st }, null, 1));
const brief = { name, graph: st.graph, buildings: st.buildings, plazas: st.plazas, roof: st.roof, floor_check: st.floor_check, final_prune_merge: st.final_prune_merge, forced: st.forced, timing_ms: st.timing_ms, rss_mb: st.rss_mb };
console.log(JSON.stringify(brief, null, 1));
