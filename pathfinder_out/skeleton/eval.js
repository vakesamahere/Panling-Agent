'use strict';
// Objective metrics for an L1 graph (v2 or v3 graph.json). Pure Node. Read-only on ../node.
//   node --max-old-space-size=2000 eval.js out/huangcheng_v2_graph.json [--out=out/eval_v2.json] [--set=huangcheng|renzu] [--v1=out/huangcheng_graph.json]
// Metrics (see README v3 "eval"):
//  1 route quality: L1 Dijkstra (roads + region crossing by in-region cell shortest paths + start/goal attachment) / grid A* length
//  2 coverage: share of reachable in-box cells inside a region or within 8 (planar geodesic, 3D step length) of an L1 node / road / port
//  3 size: nodes, junctions, edges, regions, region diameter (geodesic double sweep + bbox extent)
//  4 main street: v1 road polyline points with width >= 6 that are inside an L1 region or within 3 blocks of an L1 road
//  5 connectivity: connected components of the L1 graph
//  6 time / memory
const fs = require('fs'), path = require('path');
const SK = require('./skeleton');

const SETS = {
  huangcheng: { file: 'huangcheng_world.json' },
  renzu: { files: ['人族出生点__村長', '人族出生点__鐵匠舖', '人族出生点__村莊大門', '丹藥舖__村長', '丹藥舖__鐵匠舖', '村莊大門__丹藥舖', '村長__雜貨舖掌櫃', '補給品簡方__鐵匠舖', '雜貨舖掌櫃__人族出生点', '鐵匠舖__村莊大門'] },
};
const TS = path.join(__dirname, '..', 'testset_v3');
const DATA = path.join(__dirname, '..', 'node', 'data');
const OUT = path.join(__dirname, 'out');
const ATTACH = 24;     // start / goal attach radius (planar geodesic length)
const COVER = 8;       // coverage radius (planar geodesic length)
const MAIN_W = 6, MAIN_R = 3;
const PORT_R = 12;
const CROSS_MARGIN = +(process.env.EVAL_CROSS_MARGIN || 3); // v4: outside rim (undirected steps, non-region cells) allowed in crossing searches     // port-to-region link radius when computing region crossing costs

function pairsFor(set) {
  if (set === 'huangcheng') return JSON.parse(fs.readFileSync(path.join(TS, SETS.huangcheng.file), 'utf8')).map((r) => ({ frm: r.frm, to: r.to, frm_xyz: r.frm_xyz, to_xyz: r.to_xyz, file_length: r.length }));
  return SETS[set].files.map((f) => { const r = JSON.parse(fs.readFileSync(path.join(TS, f + '.json'), 'utf8')); return { frm: r.frm, to: r.to, frm_xyz: r.frm_xyz, to_xyz: r.to_xyz, file_length: r.length }; });
}

// ground truth: grid A* on the full PFG3 graph (../node/graph.js), cached per set
function groundTruth(set, pairs) {
  const f = path.join(OUT, 'gt_' + set + '.json');
  if (fs.existsSync(f)) { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (c.length === pairs.length) return c; }
  const G = require('../node/graph'); G.load(DATA, { maxRegions: 6 });
  const res = pairs.map((p) => {
    const c = G.plan(p.frm_xyz, p.to_xyz, { maxNodes: 1500000 });
    if (!c.info.reachable) return { frm: p.frm, to: p.to, reachable: false };
    const a = c[0], b = c[c.length - 1];
    return { frm: p.frm, to: p.to, reachable: true, length: c.info.length, kinds: c.info.kinds, ms: c.info.ms, start: [Math.floor(a.x), a.y, Math.floor(a.z)], end: [Math.floor(b.x), b.y, Math.floor(b.z)] };
  });
  fs.writeFileSync(f, JSON.stringify(res, null, 1));
  return res;
}

// ---------- cell context (same load / reach / planar as the builder) ----------
function loadCtx(graph) {
  const o = Object.assign({}, SK.DEFAULTS, graph.opts);
  const ctx = SK.loadBox(DATA, graph.box, o);
  SK.reachFilter(ctx, o.seeds, (s) => SK.nearestLocal(ctx, s));
  SK.buildPlanar(ctx, o);
  // evaluation adjacency: planar edges plus every other PFG3 edge between kept cells (jump/drop/climb/door..., not teleport), made undirected.
  // Start / goal pockets that are only reachable by a drop would otherwise be cut off from the planar skeleton.
  { const N = ctx.N, lists = new Array(N); const add = (a, b) => { (lists[a] || (lists[a] = new Set())).add(b); };
    for (let u = 0; u < N; u++) { if (!ctx.keep[u]) continue; for (let j = ctx.P[u]; j < ctx.P[u + 1]; j++) add(u, ctx.NB[j]);
      const r = ctx.regs[ctx.RI[u]], k = ctx.RK[u];
      for (let e = r.ptr[k]; e < r.ptr[k + 1]; e++) { if (r.et[e] === SK.ET.teleport) continue; const v = ctx.lookup(r.dst[e]); if (v < 0 || v === u || !ctx.keep[v]) continue; if (Math.abs(ctx.X[v] - ctx.X[u]) > 4 || Math.abs(ctx.Z[v] - ctx.Z[u]) > 4) continue; add(u, v); add(v, u); } }
    const P = new Int32Array(N + 1), nb = []; for (let u = 0; u < N; u++) { if (lists[u]) for (const v of lists[u]) nb.push(v); P[u + 1] = nb.length; }
    ctx.P = P; ctx.NB = Int32Array.from(nb);
    // directed adjacency (v4): exactly the PFG3 edges (no teleport, |dx|,|dz| <= 4) between kept cells, forward and reverse
    const fl = new Array(N), rl = new Array(N); const addD = (L2, a, b) => { (L2[a] || (L2[a] = new Set())).add(b); };
    for (let u = 0; u < N; u++) { if (!ctx.keep[u]) continue; const r = ctx.regs[ctx.RI[u]], k = ctx.RK[u];
      for (let e = r.ptr[k]; e < r.ptr[k + 1]; e++) { if (r.et[e] === SK.ET.teleport) continue; const v = ctx.lookup(r.dst[e]); if (v < 0 || v === u || !ctx.keep[v]) continue; if (Math.abs(ctx.X[v] - ctx.X[u]) > 4 || Math.abs(ctx.Z[v] - ctx.Z[u]) > 4) continue; addD(fl, u, v); addD(rl, v, u); } }
    const csr = (L2) => { const Pp = new Int32Array(N + 1), a = []; for (let u = 0; u < N; u++) { if (L2[u]) for (const v of L2[u]) a.push(v); Pp[u + 1] = a.length; } return [Pp, Int32Array.from(a)]; };
    [ctx.FP, ctx.FNB] = csr(fl); [ctx.RP, ctx.RNB] = csr(rl); ctx.SP = ctx.P; ctx.SNB = ctx.NB; }
  const col = new Map();
  for (let u = 0; u < ctx.N; u++) { if (!ctx.keep[u]) continue; const k = ctx.X[u] * 65536 + ctx.Z[u]; const a = col.get(k); if (a) a.push(u); else col.set(k, [u]); }
  ctx.col = col;
  return ctx;
}
function findCell(ctx, x, y, z, rad = 1) {
  const pick = (xx, zz) => { const a = ctx.col.get(xx * 65536 + zz); if (!a) return [-1, Infinity]; let b = -1, bd = Infinity; for (const u of a) { const q = Math.abs(ctx.F[u] / 16 - y); if (q < bd) { bd = q; b = u; } } return [b, bd]; };
  x = Math.floor(x); z = Math.floor(z);
  let [b, bd] = pick(x, z); if (b >= 0 && bd <= 2) return b;
  let best = b, bq = b >= 0 ? bd * bd : Infinity;
  for (let dx = -rad; dx <= rad; dx++) for (let dz = -rad; dz <= rad; dz++) { if (!dx && !dz) continue; const [c, cd] = pick(x + dx, z + dz); if (c >= 0) { const q = cd * cd + dx * dx + dz * dz; if (q < bq) { bq = q; best = c; } } }
  return best;
}
const stepLen = (ctx, a, b) => Math.sqrt((ctx.X[a] - ctx.X[b]) ** 2 + (ctx.Z[a] - ctx.Z[b]) ** 2 + ((ctx.F[a] - ctx.F[b]) / 16) ** 2);

// bounded Dijkstra over planar adjacency; mask (Int32Array stamp) optional; returns Map cell->dist (+parents when asked)
// dir: 'u' undirected (coverage / stats), 'f' forward along PFG3 edges, 'r' reverse (distance TO the sources). Default from ctx.DIRECTED.
function dijkstra(ctx, srcs, { maxD = Infinity, mask = null, stamp = 0, parents = false, stopAt = null, dir = null } = {}) {
  dir = dir || (ctx.DIRECTED ? 'f' : 'u');
  const P = dir === 'f' ? ctx.FP : dir === 'r' ? ctx.RP : ctx.SP, NB = dir === 'f' ? ctx.FNB : dir === 'r' ? ctx.RNB : ctx.SNB;
  const dist = new Map(), par = parents ? new Map() : null; const h = new SK.Heap();
  for (const [c, d0] of srcs) if (!(dist.get(c) <= d0)) { dist.set(c, d0); if (par) par.set(c, -1); h.push(d0, c); }
  while (h.size) {
    const u = h.pop(), du = h.topKey; if (du > dist.get(u)) continue; if (stopAt != null && u === stopAt) break;
    for (let j = P[u]; j < P[u + 1]; j++) {
      const v = NB[j]; if (mask && mask[v] !== stamp) continue;
      const nd = du + stepLen(ctx, u, v); if (nd > maxD) continue;
      if (nd < (dist.has(v) ? dist.get(v) : Infinity)) { dist.set(v, nd); if (par) par.set(v, u); h.push(nd, v); }
    }
  }
  return { dist, par };
}

class MinHeap { constructor() { this.k = []; this.v = []; } get size() { return this.v.length; } push(k, v) { this.k.push(k); this.v.push(v); let i = this.v.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= this.k[i]) break; [this.k[p], this.k[i]] = [this.k[i], this.k[p]]; [this.v[p], this.v[i]] = [this.v[i], this.v[p]]; i = p; } }
  pop() { const r = [this.k[0], this.v[0]]; const lk = this.k.pop(), lv = this.v.pop(); if (this.v.length) { this.k[0] = lk; this.v[0] = lv; let i = 0; for (;;) { const a = 2 * i + 1, b = a + 1; let s = i; if (a < this.v.length && this.k[a] < this.k[s]) s = a; if (b < this.v.length && this.k[b] < this.k[s]) s = b; if (s === i) break; [this.k[s], this.k[i]] = [this.k[i], this.k[s]]; [this.v[s], this.v[i]] = [this.v[i], this.v[s]]; i = s; } } return r; } }

const REGION_KINDS = new Set(['building', 'grove', 'plaza', 'region']);
const isRegion = (n) => REGION_KINDS.has(n.kind) || !!n.cell_list;

// ---------- build the expanded L1 graph: one vertex per skeleton node, one vertex per (region, port cell) ----------
function buildL1(graph, ctx) {
  const nodes = graph.nodes, edges = graph.edges;
  const regCells = new Map(); // node id -> cells
  const cellReg = new Map();  // cell -> region node id
  for (const n of nodes) if (isRegion(n)) {
    const cs = []; for (const p of n.cell_list || []) { const c = findCell(ctx, p[0], p[1], p[2], 0); if (c >= 0) { cs.push(c); if (!cellReg.has(c)) cellReg.set(c, n.id); } }
    regCells.set(n.id, cs);
  }
  const V = []; const adj = []; const addV = (o) => { V.push(o); adj.push([]); return V.length - 1; };
  const nodeV = new Map(); for (const n of nodes) if (!isRegion(n)) nodeV.set(n.id, addV({ kind: 'node', node: n.id, cell: findCell(ctx, n.pos[0], n.pos[1], n.pos[2]) }));
  const portV = new Map(); // `${node}:${cell}` -> vid
  const regPorts = new Map(); // node -> [vid]
  const port = (nid, pos) => {
    const n = nodes[nid]; if (!isRegion(n)) return nodeV.get(nid);
    let c = findCell(ctx, pos[0], pos[1], pos[2]); if (c < 0) c = findCell(ctx, n.pos[0], n.pos[1], n.pos[2]);
    const key = nid + ':' + c; if (portV.has(key)) return portV.get(key);
    const v = addV({ kind: 'port', node: nid, cell: c }); portV.set(key, v);
    if (!regPorts.has(nid)) regPorts.set(nid, []); regPorts.get(nid).push(v); return v;
  };
  const D_ = !!ctx.DIRECTED;
  const addE = (a, b, w, info) => { adj[a].push([b, w, info]); adj[b].push([a, w, info]); };
  const add1 = (a, b, w, info) => { if (w < Infinity) adj[a].push([b, w, info]); };
  // directed cost between two cells, restricted to a corridor (cells within CORR undirected steps of the given cells)
  const cmask = new Int32Array(ctx.N); let cst = 0; let roadOneWay = 0, roadBlocked = 0;
  const corridorCost = (cellsAlong, ca, cb, rad) => {
    cst++; let fr = cellsAlong.filter((c) => c >= 0); for (const c of fr) cmask[c] = cst; cmask[ca] = cst; cmask[cb] = cst; fr = fr.concat([ca, cb]);
    for (let k = 0; k < rad; k++) { const nx = []; for (const u of fr) for (let j = ctx.SP[u]; j < ctx.SP[u + 1]; j++) { const v = ctx.SNB[j]; if (cmask[v] !== cst) { cmask[v] = cst; nx.push(v); } } fr = nx; }
    const f = dijkstra(ctx, [[ca, 0]], { mask: cmask, stamp: cst, stopAt: cb, dir: 'f' }).dist.get(cb);
    const r = dijkstra(ctx, [[cb, 0]], { mask: cmask, stamp: cst, stopAt: ca, dir: 'f' }).dist.get(ca);
    return [f == null ? Infinity : f, r == null ? Infinity : r];
  };
  const densify = (pl) => { const out = []; for (let i = 0; i < pl.length; i++) { const p = pl[i], q = pl[i + 1] || p; const n = Math.max(1, Math.abs(q[0] - p[0]), Math.abs(q[2] - p[2])); for (let k = 0; k < n; k++) { const t = k / n; out.push(findCell(ctx, Math.round(p[0] + (q[0] - p[0]) * t), p[1] + (q[1] - p[1]) * t, Math.round(p[2] + (q[2] - p[2]) * t))); } } return out; };
  const pairCost = (ca, cb, along, w0) => { // [a->b, b->a]
    if (!D_) return [w0, w0];
    if (ca < 0 || cb < 0) return [w0, w0];
    if (ca === cb) return [0, 0];
    let [f, r] = corridorCost(along, ca, cb, 2);
    if (f === Infinity || r === Infinity) { const [f2, r2] = corridorCost(along, ca, cb, 5); f = Math.min(f, f2); r = Math.min(r, r2); }
    return [f, r];
  };
  const roadDir = new Map(); // ei -> [ab, ba]
  const roadAnch = []; // [cell, vidA, sA, vidB, sB, edgeIndex]
  edges.forEach((e, ei) => {
    if (e.b == null) return;
    if (e.kind === 'road') {
      const pl = e.polyline; const pa = e.a_pos || pl[0], pb = e.b_pos || pl[pl.length - 1];
      const va = port(e.a, pa), vb = port(e.b, pb);
      const [wf, wr] = pairCost(V[va].cell, V[vb].cell, D_ ? densify(pl) : null, e.length);
      add1(va, vb, wf, { e: ei }); add1(vb, va, wr, { e: ei }); roadDir.set(ei, [wf < Infinity, wr < Infinity]);
      if (D_) { if (wf === Infinity && wr === Infinity) roadBlocked++; else if (wf === Infinity || wr === Infinity) roadOneWay++; }
      const cum = [0]; for (let i = 1; i < pl.length; i++) cum.push(cum[i - 1] + Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][2] - pl[i - 1][2], pl[i][1] - pl[i - 1][1]));
      const C = cum[cum.length - 1] || 1;
      const [okF, okR] = roadDir.get(ei);
      for (let i = 0; i < pl.length; i++) { const c = findCell(ctx, pl[i][0], pl[i][1], pl[i][2]); if (c >= 0) { const s = (cum[i] / C) * e.length; roadAnch.push([c, va, s, vb, e.length - s, ei, okF, okR]); } }
    } else if (e.kind === 'region_link' || e.kind === 'region_adj') {
      const pa = e.a_pos || e.at, pb = e.b_pos || e.at;
      const va = port(e.a, pa), vb = port(e.b, pb);
      const [wf, wr] = pairCost(V[va].cell, V[vb].cell, [], e.length || 0);
      add1(va, vb, wf, { e: ei }); add1(vb, va, wr, { e: ei });
    } else if (e.kind === 'ladder' || e.kind === 'teleport') {
      if (e.a === e.b) return;
      const va = isRegion(nodes[e.a]) ? port(e.a, e.a_pos || e.at || nodes[e.a].pos) : nodeV.get(e.a);
      const vb = isRegion(nodes[e.b]) ? port(e.b, e.b_pos || e.to || e.at || nodes[e.b].pos) : nodeV.get(e.b);
      // ladders carry no endpoint positions in v2: never let one be shorter than the straight line between its end cells
      const ca = V[va].cell, cb = V[vb].cell; const eu = ca >= 0 && cb >= 0 ? stepLen(ctx, ca, cb) : 0;
      if (e.kind === 'ladder' && D_ && ca >= 0 && cb >= 0) { const [wf, wr] = pairCost(ca, cb, [], eu); add1(va, vb, Math.max(e.length || 0, wf), { e: ei }); add1(vb, va, Math.max(e.length || 0, wr), { e: ei }); }
      else addE(va, vb, e.kind === 'ladder' ? Math.max(e.length || 0, eu) : 0, { e: ei });
    }
  });
  // region crossing: in-region cell shortest paths between all ports (allowed cells = region cells + its port cells)
  const mask = new Int32Array(ctx.N); let stamp = 0; let crossPairs = 0, crossInf = 0;
  const cross = new Map(); // node -> {ports:[vid], D:[[...]]}
  for (const [nid, vs] of regPorts) {
    stamp++; for (const c of regCells.get(nid) || []) mask[c] = stamp; for (const v of vs) if (V[v].cell >= 0) mask[V[v].cell] = stamp;
    if (CROSS_MARGIN > 0) { // v4: let the in-region search use a thin rim of outside cells (terraced buildings are not strongly connected inside)
      let fr = (regCells.get(nid) || []).slice(); for (let k = 0; k < CROSS_MARGIN; k++) { const nx = []; for (const u of fr) for (let j = ctx.SP[u]; j < ctx.SP[u + 1]; j++) { const v = ctx.SNB[j]; if (mask[v] !== stamp) { mask[v] = stamp; nx.push(v); } } fr = nx; } }
    const D = vs.map(() => vs.map(() => Infinity));
    // a port cell may sit a few blocks outside its region (skeleton end next to the door): link it to the region cells within PORT_R
    // nearOut[i]: region cells reachable FROM port i within PORT_R; nearIn[j]: region cells that reach port j within PORT_R
    const nearOf = (dir) => vs.map((v) => { const c = V[v].cell; const m = new Map(); if (c < 0) return m; const { dist } = dijkstra(ctx, [[c, 0]], { maxD: PORT_R, dir: D_ ? dir : 'u' }); for (const [x, d] of dist) if (mask[x] === stamp) m.set(x, d); return m; });
    const nearOut = nearOf('f'), nearIn = D_ ? nearOf('r') : nearOut;
    for (let i = 0; i < vs.length; i++) {
      if (!nearOut[i].size) continue;
      const { dist } = dijkstra(ctx, [...nearOut[i]], { mask, stamp });
      for (let j = 0; j < vs.length; j++) { let d = Infinity; for (const [x, dj] of nearIn[j]) { const di = dist.get(x); if (di != null && di + dj < d) d = di + dj; } D[i][j] = i === j ? 0 : d; }
    }
    if (D_) { for (let i = 0; i < vs.length; i++) for (let j = 0; j < vs.length; j++) { if (i === j) continue; crossPairs++; if (D[i][j] < Infinity) add1(vs[i], vs[j], D[i][j], { cross: nid }); else crossInf++; } }
    else for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) { const d = Math.min(D[i][j], D[j][i]); crossPairs++; if (d < Infinity) addE(vs[i], vs[j], d, { cross: nid }); else crossInf++; }
    cross.set(nid, { ports: vs, D });
  }
  const anchors = new Map(); // cell -> [[vid, extra]]
  // anchor entry [vid, extra, usableForStart, usableForGoal]: from a road cell to its end a you travel b->a (start side needs okR);
  // reaching the road cell from end a means travelling a->b (goal side needs okF)
  const addA = (c, v, x, okS, okG) => { if (c < 0 || v == null) return; const a = anchors.get(c); const r = [v, x, okS, okG]; if (a) a.push(r); else anchors.set(c, [r]); };
  for (const [vid, o] of V.entries()) addA(o.cell, vid, 0, true, true);
  for (const [c, va, sa, vb, sb, , okF, okR] of roadAnch) { addA(c, va, sa, !D_ || okR, !D_ || okF); addA(c, vb, sb, !D_ || okF, !D_ || okR); }
  return { V, adj, nodeV, portV, regPorts, regCells, cellReg, cross, anchors, mask, crossPairs, crossInf, stampRef: { s: stamp }, directed: D_, roadOneWay, roadBlocked };
}

// attach a cell to the L1 graph: geodesic Dijkstra (radius ATTACH) to anchors; inside a region also to all its ports
function attach(ctx, L, cell, side = 's') {
  const out = new Map(); const put = (v, d) => { if (!(out.get(v) <= d)) out.set(v, d); };
  const dir = !L.directed ? 'u' : side === 's' ? 'f' : 'r';
  const { dist } = dijkstra(ctx, [[cell, 0]], { maxD: ATTACH, dir });
  for (const [c, d] of dist) { const a = L.anchors.get(c); if (a) for (const [v, x, okS, okG] of a) if (side === 's' ? okS : okG) put(v, d + x); }
  const rid = L.cellReg.get(cell);
  if (rid != null && L.regPorts.has(rid)) {
    const s = ++L.stampRef.s; for (const c of L.regCells.get(rid)) L.mask[c] = s; for (const v of L.regPorts.get(rid)) if (L.V[v].cell >= 0) L.mask[L.V[v].cell] = s;
    const r = dijkstra(ctx, [[cell, 0]], { mask: L.mask, stamp: s, dir });
    for (const v of L.regPorts.get(rid)) { const c = L.V[v].cell; if (r.dist.has(c)) put(v, r.dist.get(c)); }
  }
  // v4 fallback: nothing within ATTACH (e.g. deep inside a big building whose ports lie outside the region mask): widen the radius
  if (!out.size) for (const R of [2 * ATTACH, 4 * ATTACH, 8 * ATTACH]) {
    const w = dijkstra(ctx, [[cell, 0]], { maxD: R, dir }).dist;
    for (const [c, d] of w) { const a = L.anchors.get(c); if (a) for (const [v, x, okS, okG] of a) if (side === 's' ? okS : okG) put(v, d + x); }
    if (out.size) break; }
  return { out, dist };
}

function route(ctx, L, sCell, tCell) {
  const A = attach(ctx, L, sCell, 's'), B = attach(ctx, L, tCell, 't');
  const n = L.V.length, S = n, T = n + 1; const dist = new Float64Array(n + 2).fill(Infinity), prev = new Int32Array(n + 2).fill(-1), pinfo = new Array(n + 2);
  const h = new MinHeap(); dist[S] = 0; h.push(0, S);
  const tIn = B.out; let direct = A.dist.has(tCell) ? A.dist.get(tCell) : Infinity;
  while (h.size) {
    const [du, u] = h.pop(); if (du > dist[u]) continue; if (u === T) break;
    const nb = u === S ? [...A.out].map(([v, w]) => [v, w, { attach: 's' }]) : L.adj[u].concat(tIn.has(u) ? [[T, tIn.get(u), { attach: 't' }]] : []);
    if (u === S && direct < Infinity) nb.push([T, direct, { direct: 1 }]);
    for (const [v, w, info] of nb) { const nd = du + w; if (nd < dist[v]) { dist[v] = nd; prev[v] = u; pinfo[v] = info; h.push(nd, v); } }
  }
  if (dist[T] === Infinity) return { length: null, attach_s: A.out.size, attach_t: B.out.size };
  const seq = []; for (let v = T; v >= 0; v = prev[v]) seq.push([v, pinfo[v]]); seq.reverse();
  const steps = []; for (let i = 1; i < seq.length; i++) { const [v, info] = seq[i]; const u = seq[i - 1][0]; steps.push(Object.assign({ from: u >= n ? (u === S ? 'S' : 'T') : u, to: v >= n ? (v === S ? 'S' : 'T') : v, w: +(dist[v] - dist[u]).toFixed(2) }, info)); }
  const nodesUsed = []; for (const [v] of seq) if (v < n) { const o = L.V[v]; if (!nodesUsed.length || nodesUsed[nodesUsed.length - 1] !== o.node) nodesUsed.push(o.node); }
  return { length: dist[T], steps, l1_nodes: nodesUsed, attach_s: A.out.size, attach_t: B.out.size, attach_s_cost: steps[0].w, attach_t_cost: steps[steps.length - 1].w };
}

// polyline (xyz) of a route for drawing: roads use their polylines, crossings / attachments use cell shortest paths
function routeGeometry(graph, ctx, L, r, sCell, tCell) {
  const pts = []; const cp = (c) => [ctx.X[c], ctx.F[c] / 16, ctx.Z[c]];
  const cellPath = (a, b, regionNode) => {
    let mask = null, s = 0;
    if (regionNode != null) { s = ++L.stampRef.s; mask = L.mask; for (const c of L.regCells.get(regionNode)) mask[c] = s; for (const v of L.regPorts.get(regionNode)) mask[L.V[v].cell] = s; mask[a] = s; mask[b] = s; }
    const { par } = dijkstra(ctx, [[a, 0]], { mask, stamp: s, parents: true, stopAt: b, maxD: regionNode != null ? Infinity : 4 * ATTACH, dir: L.directed ? 'f' : 'u' });
    if (!par.has(b)) return [cp(a), cp(b)]; const out = []; for (let c = b; c >= 0; c = par.get(c)) out.push(cp(c)); return out.reverse();
  };
  const cellOf = (v) => (v === 'S' ? sCell : v === 'T' ? tCell : L.V[v].cell);
  for (const st of r.steps) {
    const a = cellOf(st.from), b = cellOf(st.to);
    if (st.e != null) { const e = graph.edges[st.e]; if (e.kind === 'road') { const pl = e.polyline.slice(); const va = L.V[st.from]; const ca = va.cell; const d0 = Math.hypot(pl[0][0] - ctx.X[ca], pl[0][2] - ctx.Z[ca]), d1 = Math.hypot(pl[pl.length - 1][0] - ctx.X[ca], pl[pl.length - 1][2] - ctx.Z[ca]); if (d1 < d0) pl.reverse(); pts.push(...pl); } else pts.push(cp(a), cp(b)); }
    else if (st.cross != null) pts.push(...cellPath(a, b, st.cross));
    else pts.push(...cellPath(a, b, L.cellReg.get(st.from === 'S' ? sCell : tCell) != null && (st.attach === 's' ? L.cellReg.get(sCell) : L.cellReg.get(tCell)) === (L.V[st.attach === 's' ? st.to : st.from] || {}).node ? (st.attach === 's' ? L.cellReg.get(sCell) : L.cellReg.get(tCell)) : null));
  }
  return pts;
}

// ---------- metrics ----------
function coverage(graph, ctx, L) {
  const { box } = ctx; const inBox = (u) => ctx.X[u] >= box.x0 && ctx.X[u] <= box.x1 && ctx.Z[u] >= box.z0 && ctx.Z[u] <= box.z1;
  const src = new Set();
  for (const v of L.V) if (v.cell >= 0) src.add(v.cell);
  for (const e of graph.edges) if (e.kind === 'road') {
    const pl = e.polyline;
    for (let i = 0; i < pl.length; i++) {
      const p = pl[i], q = pl[i + 1] || p; const n = Math.max(1, Math.abs(q[0] - p[0]), Math.abs(q[2] - p[2]));
      for (let k = 0; k < n; k++) { const t = k / n; const c = findCell(ctx, Math.round(p[0] + (q[0] - p[0]) * t), p[1] + (q[1] - p[1]) * t, Math.round(p[2] + (q[2] - p[2]) * t)); if (c >= 0) src.add(c); }
    }
  }
  const { dist } = dijkstra(ctx, [...src].map((c) => [c, 0]), { maxD: COVER, dir: 'u' });
  let all = 0, inReg = 0, near = 0;
  for (let u = 0; u < ctx.N; u++) { if (!ctx.keep[u] || !inBox(u)) continue; all++; if (L.cellReg.has(u)) inReg++; else if (dist.has(u)) near++; }
  return { reachable_cells_in_box: all, in_region: inReg, within8_of_l1: near, covered: inReg + near, coverage: +((inReg + near) / all).toFixed(4), metric: 'planar-graph geodesic distance (3D step length) <= 8 from any L1 node / port cell or road polyline cell (polyline densified to every block)' };
}

function regionStats(graph, ctx, L) {
  const res = []; const mask = new Int32Array(ctx.N); let s = 0;
  for (const n of graph.nodes) {
    if (!isRegion(n)) continue; const cs = L.regCells.get(n.id) || []; if (!cs.length) continue;
    s++; for (const c of cs) mask[c] = s;
    // geodesic diameter, double sweep from the first cell (lower bound) per connected part, max over parts
    let diam = 0; const seen = new Set();
    for (const c0 of cs) {
      if (seen.has(c0)) continue;
      const d1 = dijkstra(ctx, [[c0, 0]], { mask, stamp: s, dir: 'u' }).dist; let far = c0, fd = 0; for (const [c, d] of d1) { seen.add(c); if (d > fd) { fd = d; far = c; } }
      const d2 = dijkstra(ctx, [[far, 0]], { mask, stamp: s, dir: 'u' }).dist; for (const d of d2.values()) if (d > diam) diam = d;
    }
    const bb = n.bbox; const ext = Math.max(bb[3] - bb[0] + 1, bb[5] - bb[2] + 1);
    const ports = (L.regPorts.get(n.id) || []).map((v) => L.V[v].cell);
    let close = 0; for (let i = 0; i < ports.length; i++) for (let j = i + 1; j < ports.length; j++) { const a = ports[i], b = ports[j]; if (Math.hypot(ctx.X[a] - ctx.X[b], ctx.Z[a] - ctx.Z[b]) < 4 && Math.abs(ctx.F[a] - ctx.F[b]) / 16 <= 2) close++; }
    res.push({ id: n.id, kind: n.kind, parent: n.parent, cells: cs.length, diam: +diam.toFixed(1), bbox_extent: ext, ports: ports.length, exits: (n.exits || []).length, close_port_pairs: close, deg: n.deg });
  }
  return res;
}

function components(graph) {
  const par = graph.nodes.map((_, i) => i); const f = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (const e of graph.edges) if (e.b != null && e.a != null) { const a = f(e.a), b = f(e.b); if (a !== b) par[a] = b; }
  const comp = new Map(); graph.nodes.forEach((n, i) => { const r = f(i); if (!comp.has(r)) comp.set(r, []); comp.get(r).push(i); });
  const list = [...comp.values()].sort((a, b) => b.length - a.length);
  return { count: list.length, sizes: list.map((c) => c.length).slice(0, 20), small: list.slice(1, 30).map((c) => c.map((i) => ({ id: i, kind: graph.nodes[i].kind, pos: graph.nodes[i].pos, cells: graph.nodes[i].cells, deg: graph.nodes[i].deg }))) };
}

function mainStreet(graph, ctx, L, v1file) {
  if (!v1file || !fs.existsSync(v1file)) return null;
  const v1 = JSON.parse(fs.readFileSync(v1file, 'utf8')); const box = graph.box;
  const grid = new Map(); const key = (x, z) => (x >> 2) * 100000 + (z >> 2);
  for (const e of graph.edges) if (e.kind === 'road') { const pl = e.polyline; for (let i = 0; i < pl.length; i++) { const p = pl[i], q = pl[i + 1] || p; const n = Math.max(1, Math.abs(q[0] - p[0]), Math.abs(q[2] - p[2])); for (let k = 0; k < n; k++) { const t = k / n; const x = p[0] + (q[0] - p[0]) * t, y = p[1] + (q[1] - p[1]) * t, z = p[2] + (q[2] - p[2]) * t; const kk = key(Math.round(x), Math.round(z)); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push([x, y, z]); } } }
  const near = (x, y, z) => { for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const a = grid.get(key(x + 4 * dx, z + 4 * dz)); if (a) for (const p of a) if ((p[0] - x) ** 2 + (p[2] - z) ** 2 <= MAIN_R * MAIN_R && Math.abs(p[1] - y) <= 3) return true; } return false; };
  const r = {};
  for (const w of [4, 6, 8]) {
    let all = 0, inReg = 0, nr = 0;
    for (const e of v1.edges) if (e.kind === 'road' && e.width_min >= w) for (const p of e.polyline) {
      if (p[0] < box.x0 || p[0] > box.x1 || p[2] < box.z0 || p[2] > box.z1) continue; all++;
      const c = findCell(ctx, p[0], p[1], p[2], 0); if (c >= 0 && L.cellReg.has(c)) inReg++; else if (near(p[0], p[1], p[2])) nr++;
    }
    r['w' + w] = { points: all, in_region: inReg, near_road: nr, kept: +((inReg + nr) / all).toFixed(4), kept_outside_regions: +(nr / Math.max(1, all - inReg)).toFixed(4) };
  }
  return r;
}

// v4: random long pairs. Seeded sampling of kept cells; ground truth = directed cell Dijkstra on the eval adjacency (FP/FNB, the same
// PFG3 edges, step length = 3D distance). Only pairs with directed geodesic >= RAND_MIN are kept. Cached in out/gt_<set>_rand.json.
const RAND_N = 30, RAND_MIN = 80, RAND_SEED = 12345;
function randomPairs(ctx, set) {
  const f = path.join(OUT, 'gt_' + set + '_rand.json');
  if (fs.existsSync(f)) { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (c.length === RAND_N) return c; }
  let seed = RAND_SEED; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const bx = ctx.box; const cells = []; for (let u = 0; u < ctx.N; u++) if (ctx.keep[u] && ctx.FP[u + 1] > ctx.FP[u] && ctx.X[u] >= bx.x0 && ctx.X[u] <= bx.x1 && ctx.Z[u] >= bx.z0 && ctx.Z[u] <= bx.z1) cells.push(u); // inside the requested box only (not the load pad)
  const out = []; let tries = 0;
  while (out.length < RAND_N && tries < 2000) { tries++;
    const a = cells[Math.floor(rnd() * cells.length)], b = cells[Math.floor(rnd() * cells.length)];
    if (Math.hypot(ctx.X[a] - ctx.X[b], ctx.Z[a] - ctx.Z[b]) < RAND_MIN) continue;
    const d = dijkstra(ctx, [[a, 0]], { dir: 'f', stopAt: b }).dist.get(b); if (d == null) continue;
    const P = (c) => [ctx.X[c], ctx.F[c] / 16, ctx.Z[c]];
    out.push({ frm: 'r' + out.length + ':' + P(a).join(','), to: P(b).join(','), reachable: true, length: d, start: P(a), end: P(b) }); }
  fs.writeFileSync(f, JSON.stringify(out, null, 1)); return out;
}

function evaluate(graph, ctx, set, opts = {}) {
  const t0 = Date.now(); const T = {}; let t = Date.now(); const lap = (k) => { const n = Date.now(); T[k] = n - t; t = n; };
  ctx.DIRECTED = opts.directed !== false;
  const pairs = pairsFor(set); const gt = groundTruth(set, pairs); lap('gt_ms');
  const L = buildL1(graph, ctx); lap('l1_build_ms');
  const routes = [];
  pairs.forEach((p, i) => {
    const g = gt[i]; if (!g.reachable) { routes.push({ frm: p.frm, to: p.to, gt: null }); return; }
    const s = findCell(ctx, g.start[0], g.start[1], g.start[2]), e = findCell(ctx, g.end[0], g.end[1], g.end[2]);
    const r = route(ctx, L, s, e);
    const rec = { frm: p.frm, to: p.to, gt_length: +g.length.toFixed(2), l1_length: r.length == null ? null : +r.length.toFixed(2), ratio: r.length == null ? null : +(r.length / g.length).toFixed(4), l1_nodes: r.l1_nodes ? r.l1_nodes.length : null, attach_s_cost: r.attach_s_cost, attach_t_cost: r.attach_t_cost, gt_kinds: g.kinds };
    if (opts.geometry && r.length != null) rec.geometry = routeGeometry(graph, ctx, L, r, s, e);
    rec._steps = r.steps; routes.push(rec);
  });
  lap('routes_ms');
  const ratios = routes.filter((r) => r.ratio != null).map((r) => r.ratio).sort((a, b) => a - b);
  const q = (p) => ratios.length ? ratios[Math.min(ratios.length - 1, Math.ceil(p * ratios.length) - 1)] : null;
  const med = ratios.length ? (ratios.length % 2 ? ratios[(ratios.length - 1) / 2] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2) : null;
  let rand = null;
  if (opts.random !== false && ctx.DIRECTED) {
    const rp = randomPairs(ctx, set); lap('rand_gt_ms'); const rows = [];
    for (const g of rp) { const s = findCell(ctx, ...g.start), e = findCell(ctx, ...g.end); const r = route(ctx, L, s, e);
      rows.push({ frm: g.frm, to: g.to, gt_length: +g.length.toFixed(2), l1_length: r.length == null ? null : +r.length.toFixed(2), ratio: r.length == null ? null : +(r.length / g.length).toFixed(4) }); }
    const rr = rows.filter((r) => r.ratio != null).map((r) => r.ratio).sort((a, b) => a - b);
    const qq = (p) => rr.length ? rr[Math.min(rr.length - 1, Math.ceil(p * rr.length) - 1)] : null;
    rand = { pairs: rows.length, reachable: rr.length, min_geodesic: RAND_MIN, seed: RAND_SEED, ratio_median: rr.length ? +(rr.length % 2 ? rr[(rr.length - 1) / 2] : (rr[rr.length / 2 - 1] + rr[rr.length / 2]) / 2).toFixed(4) : null, ratio_p90: qq(0.9), ratio_max: rr.length ? rr[rr.length - 1] : null, gt_length_median: +rows.map((r) => r.gt_length).sort((a, b) => a - b)[rows.length >> 1].toFixed(1), rows };
    lap('rand_routes_ms');
  }
  const cov = coverage(graph, ctx, L); lap('coverage_ms');
  const regs = regionStats(graph, ctx, L); lap('regions_ms');
  const comps = components(graph);
  const ms = mainStreet(graph, ctx, L, opts.v1); lap('main_street_ms');
  // size
  const kinds = {}; for (const n of graph.nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
  const ek = {}; for (const e of graph.edges) ek[e.kind] = (ek[e.kind] || 0) + 1;
  const regKinds = {}; for (const r of regs) regKinds[r.kind] = (regKinds[r.kind] || 0) + 1;
  // junctions near groves (2 blocks, xz)
  const groveCols = new Set(); for (const n of graph.nodes) if (n.kind === 'grove' || (n.kind === 'region' && n.region_kind === 'grove')) for (const p of n.cell_list) groveCols.add(p[0] * 65536 + p[2]);
  let jNearGrove = 0; for (const n of graph.nodes) if (n.kind === 'junction') { let hit = false; for (let dx = -2; dx <= 2 && !hit; dx++) for (let dz = -2; dz <= 2 && !hit; dz++) if (groveCols.has((n.pos[0] + dx) * 65536 + n.pos[2] + dz)) hit = true; if (hit) jNearGrove++; }
  const deg0 = regs.filter((r) => !r.deg).length;
  const size = { nodes: graph.nodes.length, nodes_by_kind: kinds, junctions: kinds.junction || 0, edges: graph.edges.length, edges_by_kind: ek, regions: regs.length, regions_by_kind: regKinds,
    region_max_diam: Math.max(...regs.map((r) => r.diam)), region_max_bbox_extent: Math.max(...regs.map((r) => r.bbox_extent)), regions_diam_gt48: regs.filter((r) => r.diam > 48).length, regions_bbox_gt48: regs.filter((r) => r.bbox_extent > 48).length,
    ports_total: regs.reduce((s, r) => s + r.ports, 0), ports_max: Math.max(...regs.map((r) => r.ports)), close_port_pairs_lt4: regs.reduce((s, r) => s + r.close_port_pairs, 0),
    regions_deg0: deg0, junctions_within2_of_grove: jNearGrove, road_length_total: +graph.edges.filter((e) => e.kind === 'road').reduce((s, e) => s + e.length, 0).toFixed(1), cross_pairs: L.crossPairs, cross_pairs_unreachable: L.crossInf };
  const res = {
    graph: opts.file, set, eval_params: { attach_radius: ATTACH, coverage_radius: COVER, main_street_width: MAIN_W, main_street_radius: MAIN_R, port_link_radius: PORT_R, cross_margin: CROSS_MARGIN, directed: ctx.DIRECTED },
    route: { pairs: routes.length, reachable: ratios.length, ratio_median: med == null ? null : +med.toFixed(4), ratio_max: ratios.length ? ratios[ratios.length - 1] : null, ratio_min: ratios.length ? ratios[0] : null, ratio_p90: q(0.9), directed: ctx.DIRECTED, roads_one_way: L.roadOneWay, roads_blocked: L.roadBlocked, ratio_mean: ratios.length ? +(ratios.reduce((s, x) => s + x, 0) / ratios.length).toFixed(4) : null, pass: med != null && med <= 1.10 && ratios[ratios.length - 1] <= 1.30 && ratios.length === routes.length, rows: routes.map((r) => { const o = Object.assign({}, r); delete o._steps; return o; }) },
    random: rand, coverage: cov, size, main_street: ms, connectivity: comps,
    regions: regs.sort((a, b) => b.diam - a.diam).slice(0, 15),
    build: { timing_ms: graph.stats && graph.stats.timing_ms, rss_mb: graph.stats && graph.stats.rss_mb },
    eval_timing_ms: Object.assign(T, { total_ms: Date.now() - t0 }), eval_rss_mb: Math.round(process.memoryUsage().rss / 1e6),
  };
  return { res, L, routes };
}

if (require.main === module) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v = 'true'] = a.slice(2).split('='); return [k, v]; }));
  const file = args[0]; const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
  const set = flags.set || (graph.name.startsWith('renzu') ? 'renzu' : 'huangcheng');
  const v1 = flags.v1 || path.join(OUT, set === 'renzu' ? 'renzu_village_oneway_graph.json' : 'huangcheng_graph.json');
  const t0 = Date.now(); const ctx = loadCtx(graph); const loadMs = Date.now() - t0;
  const { res } = evaluate(graph, ctx, set, { v1, file, directed: flags.directed !== 'false' });
  res.eval_timing_ms.load_ms = loadMs;
  const outFile = flags.out || file.replace(/_graph\.json$/, '_eval.json');
  fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
  const r = res.route;
  console.log(JSON.stringify({ file, set, directed: r.directed, ratio_median: r.ratio_median, p90: r.ratio_p90, ratio_max: r.ratio_max, ratio_min: r.ratio_min, reachable: r.reachable + '/' + r.pairs, coverage: res.coverage.coverage, size: Object.fromEntries(Object.entries(res.size).filter(([k]) => !k.endsWith('by_kind'))), main_street: res.main_street && res.main_street.w6, components: res.connectivity.count, eval_ms: res.eval_timing_ms.total_ms + loadMs, rss: res.eval_rss_mb }, null, 0));
  for (const row of r.rows) console.log('  ', row.frm, '->', row.to, row.gt_length, row.l1_length, row.ratio, 'att', row.attach_s_cost, row.attach_t_cost);
}

module.exports = { evaluate, loadCtx, buildL1, route, routeGeometry, findCell, pairsFor, groundTruth, dijkstra, attach, ATTACH, COVER };
