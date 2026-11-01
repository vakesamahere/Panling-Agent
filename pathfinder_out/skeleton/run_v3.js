'use strict';
// node run_v3.js <x0> <z0> <x1> <z1> [name] [--key=value ...] [--eval=false] [--suffix=_v3]
// v3 = v2 (regions.js) + canopy-top groves + region split + junction contraction + port merge + stray-component connectors.
// Writes out/<name><suffix>.png, _graph.json, _stats.json and (unless --eval=false) _eval.json / --evalOut.
const fs = require('fs'), path = require('path');
const RG = require('./regions');
const V = require('./v3');
const EV = require('./eval');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v = 'true'] = a.slice(2).split('=');
  return [k, v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v];
}));
if (args.length < 4) { console.error('usage: node run_v3.js <x0> <z0> <x1> <z1> [name] [--key=value]'); process.exit(1); }
const [a, b, c, d] = args.slice(0, 4).map(Number);
const box = { x0: Math.min(a, c), z0: Math.min(b, d), x1: Math.max(a, c), z1: Math.max(b, d) };
const suffix = flags.suffix != null ? String(flags.suffix) : '_v3'; delete flags.suffix;
const doEval = flags.eval !== false; delete flags.eval;
const evalOut = flags.evalOut; delete flags.evalOut;
const set = flags.set; delete flags.set;
const routesToDraw = String(flags.draw != null ? flags.draw : '0,6').split(',').map(Number); delete flags.draw;
const name = (args[4] || `box_${box.x0}_${box.z0}_${box.x1}_${box.z1}`) + suffix;
const scale = flags.scale || 3; delete flags.scale;
if (typeof flags.seeds === 'string') flags.seeds = flags.seeds.split(';').map((s) => s.split(',').map(Number));
const dataDir = path.join(__dirname, '..', 'node', 'data');
const outDir = path.join(__dirname, 'out'); fs.mkdirSync(outDir, { recursive: true });

const t0 = Date.now();
const opts = Object.assign({}, V.V3, flags, { hookRegions: (ctx, rs, B, dFull, full, o) => V.hookCanopy(ctx, rs, B, dFull, full, o) });
const res = RG.runV2(dataDir, box, opts);
const st = res.stats; st.timing_ms.v2_total_ms = Date.now() - t0;
let t = Date.now();
const pp = V.postV3(res, res.opts);
const out = V.outputV3(res, pp, res.opts);
st.v3 = pp.st; st.graph_v2 = st.graph; st.graph = out.stats; st.timing_ms.v3_post_ms = Date.now() - t;
st.timing_ms.build_total_ms = Date.now() - t0;
st.rss_mb = Math.round(process.memoryUsage().rss / 1e6);
const o2 = Object.assign({}, res.opts); delete o2.planarTypes; delete o2.hookRegions; delete o2.hookPlazas; delete o2.hookPreGroves;
const graph = { name, box, opts: o2, stats: st, nodes: out.nodes, edges: out.edges };

let ev = null, routes = [];
if (doEval) {
  t = Date.now();
  const ectx = EV.loadCtx(graph);
  const sname = set || (name.startsWith('renzu') ? 'renzu' : 'huangcheng');
  const r = EV.evaluate(graph, ectx, sname, { file: path.join('out', name + '_graph.json'), geometry: true, v1: path.join(outDir, sname === 'renzu' ? 'renzu_village_oneway_graph.json' : 'huangcheng_graph.json') });
  ev = r.res; routes = r.routes;
  r.L.ctx = ectx; V.attachCross(graph, r.L);
  ev.build = { timing_ms: st.timing_ms, rss_mb: st.rss_mb };
  ev.eval_timing_ms.wall_ms = Date.now() - t; ev.eval_rss_mb = Math.round(process.memoryUsage().rss / 1e6);
  st.timing_ms.eval_ms = ev.eval_timing_ms.wall_ms;
}
t = Date.now();
const draw = routesToDraw.map((i) => routes[i]).filter((r) => r && r.geometry);
const img = V.renderV3(res, graph, draw, scale);
fs.writeFileSync(path.join(outDir, name + '.png'), img.png); st.timing_ms.png_ms = Date.now() - t;
st.drawn_routes = draw.map((r) => `${r.frm} -> ${r.to} (ratio ${r.ratio})`);
fs.writeFileSync(path.join(outDir, name + '_graph.json'), JSON.stringify(graph));
st.timing_ms.total_ms = Date.now() - t0; st.rss_mb_final = Math.round(process.memoryUsage().rss / 1e6);
fs.writeFileSync(path.join(outDir, name + '_stats.json'), JSON.stringify({ name, box, opts: o2, stats: st }, null, 1));
if (ev) fs.writeFileSync(evalOut ? path.resolve(evalOut) : path.join(outDir, name + '_eval.json'), JSON.stringify(ev, null, 1));
const brief = { name, graph: st.graph, v3: st.v3, timing_ms: st.timing_ms, rss_mb: st.rss_mb_final };
if (ev) brief.eval = { median: ev.route.ratio_median, max: ev.route.ratio_max, reach: ev.route.reachable + '/' + ev.route.pairs, coverage: ev.coverage.coverage, junctions: ev.size.junctions, nodes: ev.size.nodes, edges: ev.size.edges, regions: ev.size.regions, max_diam: ev.size.region_max_diam, diam_gt48: ev.size.regions_diam_gt48, close_ports: ev.size.close_port_pairs_lt4, deg0: ev.size.regions_deg0, j_grove2: ev.size.junctions_within2_of_grove, w6: ev.main_street.w6.kept, comps: ev.connectivity.count, cross_unreach: ev.size.cross_pairs_unreachable };
console.log(JSON.stringify(brief));
if (ev) for (const r of ev.route.rows) console.log(`  ${r.frm} -> ${r.to}  gt ${r.gt_length} l1 ${r.l1_length} ratio ${r.ratio}`);
