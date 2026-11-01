'use strict';
// node run.js <x0> <z0> <x1> <z1> [name] [--key=value ...]
//   e.g. node run.js 0 -190 300 200 huangcheng --pK=2 --borderDiag=true
// Writes out/<name>_graph.json and out/<name>.png (+ out/<name>_stats.json).
const fs = require('fs'), path = require('path');
const SK = require('./skeleton');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v = 'true'] = a.slice(2).split('=');
  return [k, v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v];
}));
if (args.length < 4) { console.error('usage: node run.js <x0> <z0> <x1> <z1> [name] [--key=value]'); process.exit(1); }
const [a, b, c, d] = args.slice(0, 4).map(Number);
const box = { x0: Math.min(a, c), z0: Math.min(b, d), x1: Math.max(a, c), z1: Math.max(b, d) };
const name = args[4] || `box_${box.x0}_${box.z0}_${box.x1}_${box.z1}`;
const scale = flags.scale || 3; delete flags.scale;
// --seeds=x,y,z;x,y,z  (cells strongly connected with any seed are kept)
if (typeof flags.seeds === 'string') flags.seeds = flags.seeds.split(';').map((s) => s.split(',').map(Number));
const dataDir = path.join(__dirname, '..', 'node', 'data');
const outDir = path.join(__dirname, 'out'); fs.mkdirSync(outDir, { recursive: true });

const t0 = Date.now();
const res = SK.run(dataDir, box, flags);
const st = res.stats;
st.levels = SK.levelStats(res.ctx, res.S);
let t = Date.now(); const img = SK.render(res, scale); fs.writeFileSync(path.join(outDir, name + '.png'), img.png); st.timing_ms.png_ms = Date.now() - t;
t = Date.now();
const opts = Object.assign({}, res.opts); delete opts.planarTypes;
fs.writeFileSync(path.join(outDir, name + '_graph.json'), JSON.stringify({ name, box, opts, stats: st, nodes: res.out.nodes, edges: res.out.edges }));
st.timing_ms.json_ms = Date.now() - t; st.timing_ms.total_ms = Date.now() - t0;
st.rss_mb = Math.round(process.memoryUsage().rss / 1e6); st.png = { w: img.w, h: img.h, scale };
fs.writeFileSync(path.join(outDir, name + '_stats.json'), JSON.stringify({ name, box, opts, stats: st }, null, 1));
console.log(JSON.stringify({ name, box, opts: flags, stats: st }, null, 1));
