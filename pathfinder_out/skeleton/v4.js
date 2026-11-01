'use strict';
// v4 = v3 + directed repair roads + local directed spanner (shortcut roads) + buildings unsplit (parent/child hierarchy for split
// groves / plazas) + narrow-alley contraction + region_adj <= 3 per piece pair + flat port merge + parent records + new render.
// v3: post-processing of the v2 region graph.
//  A. canopy-top groves (hookRegions)          B. large-region split (geodesic Voronoi)
//  C. junction clustering / short-edge contraction   D. connect stray components
//  E. port (exit) clustering                    F. deg-2 merge / spur prune, output
const SK = require('./skeleton');
const RG = require('./regions');

const V3 = {
  canopyTop: true, canopyMin: 30, canopyJoin: true,
  splitR: 20, splitDiam: 48, adjSep: 8, adjMax: 3,
  contract: true, contractMin: 3, contractK: 1, clusterR: 0, clusterMaxR: 8, repMode: 'clear',
  connect: true, connectMax: 96,
  alleyW: 3, alleyLen: 16, alleyMaxR: 16, wideMax: null, keepRegionLoops: true,
  span: true, spanR: 96, spanT: 1.15, spanAdd: 6, spanMin: 6,
  splitDiamBuilding: 100000, portMergeDy: 0, repair: true, repairK: 1.5, repairMax: 48,
  portMerge: 4, spurMin: 0, dedupe: true, dedupeTol: 0.25, dedupeSep: 4, refit: true,
};

// ---------- A. canopy-top groves (called as opts.hookRegions) ----------
function hookCanopy(ctx, rs, B, dFull, full, o) {
  if (!o.canopyTop) return { added: 0 };
  const { N, FB, keep } = ctx, R = B.R;
  const is = new Uint8Array(N);
  let n = 0;
  for (let u = 0; u < N; u++) if (keep[u] && R[u] < 0 && RG.CANOPY.has(FB[u] >> 4)) { is[u] = 1; n++; }
  const seen = new Uint8Array(N); let added = 0, joined = 0, cellsAdded = 0;
  for (let s = 0; s < N; s++) {
    if (!is[s] || seen[s]) continue;
    const comp = [s]; seen[s] = 1; const touch = new Map();
    for (let i = 0; i < comp.length; i++) {
      const u = comp[i];
      for (let j = full.P[u]; j < full.P[u + 1]; j++) {
        const v = full.NB[j];
        if (is[v] && !seen[v]) { seen[v] = 1; comp.push(v); }
        else if (R[v] >= 0 && B.blds[R[v]].kind === 'grove') touch.set(R[v], (touch.get(R[v]) || 0) + 1);
      }
    }
    let gid = -1;
    if (o.canopyJoin && touch.size) { let best = 0; for (const [g, c] of touch) if (c > best) { best = c; gid = g; } }
    if (gid >= 0) { const g = B.blds[gid]; for (const u of comp) { R[u] = gid; g.cells.push(u); } joined++; cellsAdded += comp.length; }
    else if (comp.length >= o.canopyMin) {
      gid = B.blds.length;
      B.blds.push({ id: gid, kind: 'grove', cells: comp, canopy: comp.length, roofed: 0, openness: 0, canopy_top: true });
      for (const u of comp) R[u] = gid; added++; cellsAdded += comp.length;
    }
  }
  return { canopy_top_cells: n, added, joined, cells: cellsAdded };
}

// ---------- helpers ----------
class Heap { constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(k, v) { const K = this.k, Vv = this.v; let i = K.length; K.push(k); Vv.push(v);
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= k) break; K[i] = K[p]; Vv[i] = Vv[p]; i = p; } K[i] = k; Vv[i] = v; }
  pop() { const K = this.k, Vv = this.v, rk = K[0], rv = Vv[0], lk = K.pop(), lv = Vv.pop(), n = K.length;
    if (n) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && K[c + 1] < K[c]) c++; if (K[c] >= lk) break; K[i] = K[c]; Vv[i] = Vv[c]; i = c; } K[i] = lk; Vv[i] = lv; }
    return [rk, rv]; } }

function postV3(res, o) {
  const { ctx, full, dFull, regions } = res, { X, Z, F, N } = ctx;
  const P = full.P, NB = full.NB;
  const dist = (a, b) => Math.hypot(X[a] - X[b], Z[a] - Z[b], (F[a] - F[b]) / 16);
  const st = {};
  // ---- import v2 output into mutable structure ----
  const nodes = res.out.nodes.map((n) => {
    if (n.cell_list) return { kind: 'region', rkind: n.kind, region: n.region, rep: n._rep, cells: regions[n.region].cells.slice(), tags: [], alive: true, info: n };
    return { kind: 'sk', tags: (n.tags || []).slice(), rep: n._rep, radius: n.radius, ncells: n.cells, alive: true };
  });
  const edges = [];
  for (const e of res.out.edges) {
    if (e.kind === 'road') edges.push({ kind: 'road', a: e.a, b: e.b, cells: e._cells.slice(), length: e.length, width_min: e.width_min, alive: true });
    else if (e.kind === 'region_link') edges.push({ kind: 'region_link', a: e.a, b: e.b, cell: e._cell, length: 0, alive: true });
    else edges.push({ kind: e.kind, a: e.a, b: e.b, u: e._u, v: e._v, length: e.length, dst_gid: e.dst_gid, ladder_cells: e.ladder_cells, alive: true });
  }
  const endCell = (e, side) => {
    if (e.kind === 'road') return side === 0 ? e.cells[0] : e.cells[e.cells.length - 1];
    if (e.kind === 'region_link') return e.cell;
    return side === 0 ? e.u : (e.v != null && e.v >= 0 ? e.v : e.u);
  };

  // ---- B. split large regions ----
  const owner = new Int32Array(N).fill(-1); // cell -> region node id
  nodes.forEach((n, i) => { if (n.kind === 'region') for (const c of n.cells) owner[c] = i; });
  const dij = new Float64Array(N).fill(Infinity), lab = new Int32Array(N).fill(-1);
  function multiSrc(cells, seeds, mask) { // geodesic Voronoi inside mask
    for (const c of cells) { dij[c] = Infinity; lab[c] = -1; }
    const h = new Heap();
    seeds.forEach((s, i) => { dij[s] = 0; lab[s] = i; h.push(0, s); });
    while (h.size) { const [d, u] = h.pop(); if (d > dij[u]) continue;
      for (let j = P[u]; j < P[u + 1]; j++) { const v = NB[j]; if (!mask(v)) continue; const nd = d + dist(u, v); if (nd < dij[v]) { dij[v] = nd; lab[v] = lab[u]; h.push(nd, v); } } }
  }
  let splitCount = 0, pieces = 0;
  const nOrig = nodes.length;
  const pieceRedirect = new Map(); // orig region node -> [piece ids]
  for (let ni = 0; ni < nOrig; ni++) {
    const n = nodes[ni]; if (n.kind !== 'region') continue;
    const cells = n.cells, mask = (v) => owner[v] === ni;
    // farthest point seeding until every cell within splitR of a seed
    let seeds = [n.rep != null && owner[n.rep] === ni ? n.rep : cells[0]];
    multiSrc(cells, seeds, mask);
    let far = -1, fd = -1; for (const c of cells) if (dij[c] > fd) { fd = dij[c]; far = c; }
    // quick test with double sweep: diameter
    multiSrc(cells, [far], mask); let diam = 0; for (const c of cells) if (dij[c] > diam && dij[c] < Infinity) diam = dij[c];
    const disconnected = cells.some((c) => dij[c] === Infinity);
    n.diam = diam;
    const lim = n.rkind === 'building' && o.splitDiamBuilding != null ? o.splitDiamBuilding : o.splitDiam;
    if (diam <= lim && (!disconnected || n.rkind === 'building')) continue;
    seeds = [far];
    for (let it = 0; it < 200; it++) {
      multiSrc(cells, seeds, mask);
      let f = -1, d = -1; for (const c of cells) { const x = dij[c] === Infinity ? 1e9 : dij[c]; if (x > d) { d = x; f = c; } }
      if (d <= o.splitR) break; seeds.push(f);
    }
    // Lloyd-ish refinement: move seeds to geodesic medoid approx (centroid nearest cell), 2 rounds
    for (let r = 0; r < 2; r++) {
      const sx = seeds.map(() => [0, 0, 0, 0]);
      for (const c of cells) { const l = lab[c]; if (l < 0) continue; const a = sx[l]; a[0] += X[c]; a[1] += Z[c]; a[2] += F[c]; a[3]++; }
      const best = seeds.map(() => [Infinity, -1]);
      for (const c of cells) { const l = lab[c]; if (l < 0) continue; const a = sx[l]; const dd = Math.hypot(X[c] - a[0] / a[3], Z[c] - a[1] / a[3], (F[c] - a[2] / a[3]) / 16); if (dd < best[l][0]) best[l] = [dd, c]; }
      seeds = best.map((b, i) => b[1] >= 0 ? b[1] : seeds[i]);
      multiSrc(cells, seeds, mask);
    }
    // any unlabeled (shouldn't happen) -> nearest seed by euclid
    const groups = seeds.map(() => []);
    for (const c of cells) { let l = lab[c]; if (l < 0) { let bd = Infinity; seeds.forEach((s, i) => { const d = dist(s, c); if (d < bd) { bd = d; l = i; } }); } groups[l].push(c); }
    const ids = [];
    groups.forEach((g, i) => { if (!g.length) return;
      let rep = g[0], bd = -1; for (const c of g) if (dFull[c] - dist(c, seeds[i]) * 0.2 > bd) { bd = dFull[c] - dist(c, seeds[i]) * 0.2; rep = c; }
      const id = nodes.length; nodes.push({ kind: 'region', rkind: n.rkind, region: n.region, rep, cells: g, tags: [], alive: true, parent: ni, piece: ids.length, info: n.info });
      ids.push(id); for (const c of g) owner[c] = id; });
    n.alive = false; pieceRedirect.set(ni, ids); splitCount++; pieces += ids.length;
    // adjacency edges between pieces: best boundary pair (max clearance)
    const bnd = new Map();
    for (const c of cells) { const pa = owner[c];
      for (let j = P[c]; j < P[c + 1]; j++) { const v = NB[j]; const pb = owner[v]; if (pb === pa || pa > pb || !ids.includes(pb)) continue;
        const key = pa + ',' + pb; if (!bnd.has(key)) bnd.set(key, []); bnd.get(key).push({ sc: Math.min(dFull[c], dFull[v]), a: pa, b: pb, u: c, v }); } }
    for (const list of bnd.values()) {
      list.sort((p, q) => q.sc - p.sc); const sel = [];
      for (const x of list) { if (sel.length >= o.adjMax) break; if (sel.some((y) => dist(y.u, x.u) < o.adjSep)) continue; sel.push(x); }
      for (const x of sel) edges.push({ kind: 'region_adj', a: x.a, b: x.b, u: x.u, v: x.v, length: +dist(x.u, x.v).toFixed(2), alive: true });
    }
  }
  st.split = { regions_split: splitCount, pieces };
  // remap edge endpoints that pointed to split regions
  function pieceNear(orig, cell) {
    const ids = pieceRedirect.get(orig);
    if (owner[cell] >= 0 && ids.includes(owner[cell])) return owner[cell];
    // BFS over full graph
    const q = [cell], seen = new Set([cell]);
    for (let i = 0; i < q.length && i < 4000; i++) { const u = q[i];
      for (let j = P[u]; j < P[u + 1]; j++) { const v = NB[j]; if (seen.has(v)) continue; seen.add(v);
        if (owner[v] >= 0 && ids.includes(owner[v])) return owner[v]; q.push(v); } }
    let bi = ids[0], bd = Infinity; for (const id of ids) { const d = dist(nodes[id].rep, cell); if (d < bd) { bd = d; bi = id; } } return bi;
  }
  for (const e of edges) {
    if (pieceRedirect.has(e.a)) e.a = pieceNear(e.a, endCell(e, 0));
    if (e.b != null && pieceRedirect.has(e.b)) e.b = pieceNear(e.b, endCell(e, 1));
  }

  // ---- C. junction clustering / short-edge contraction ----
  const uf = nodes.map((_, i) => i); const find = (x) => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
  const members = nodes.map((_, i) => [i]);
  let contracted = 0;
  if (o.contract) {
    const cand = [];
    for (const e of edges) { if (!e.alive || e.kind !== 'road') continue; const A = nodes[e.a], Bn = nodes[e.b];
      if (A.kind !== 'sk' || Bn.kind !== 'sk' || e.a === e.b) continue;
      let thr = Math.max(o.contractMin, o.contractK * ((A.radius || 0) + (Bn.radius || 0)) + 1, o.clusterR);
      // v4 narrow-alley contraction: roads whose minimum clearance <= alleyW (1-2 block alleys between buildings) contract up to alleyLen
      const narrow = o.alleyLen > 0 && e.width_min <= o.alleyW && (A.radius || 0) <= o.alleyW + 1 && (Bn.radius || 0) <= o.alleyW + 1;
      if (narrow) thr = Math.max(thr, o.alleyLen);
      else if (o.wideMax != null && e.width_min > o.alleyW) thr = Math.min(thr, o.wideMax); // v4: wide streets are (almost) untouched
      e._narrow = narrow;
      if (e.length < thr) cand.push(e); }
    // also pure proximity clustering (euclid) of sk nodes
    cand.sort((p, q) => p.length - q.length);
    for (const e of cand) { const ra = find(e.a), rb = find(e.b); if (ra === rb) continue;
      let ok = true; outer: for (const x of members[ra]) for (const y of members[rb]) if (dist(nodes[x].rep, nodes[y].rep) > (e._narrow ? Math.max(o.clusterMaxR, o.alleyMaxR) : o.clusterMaxR)) { ok = false; break outer; }
      if (!ok) continue; uf[rb] = ra; members[ra] = members[ra].concat(members[rb]); members[rb] = []; contracted++; }
    for (let i = 0; i < nodes.length; i++) { if (find(i) !== i || members[i].length < 2) continue;
      let rep = nodes[i].rep, bd = -1, tags = new Set(), rad = 0, nc = 0;
      let bestSc = Infinity; for (const m of members[i]) { const c = nodes[m].rep; let mx = 0; for (const q of members[i]) mx = Math.max(mx, dist(c, nodes[q].rep)); const sc = o.repMode === 'clear' ? -dFull[c] : mx - 0.1 * dFull[c]; if (sc < bestSc) { bestSc = sc; rep = c; } }
      for (const m of members[i]) { const nn = nodes[m]; if (dFull[nn.rep] > bd) { bd = dFull[nn.rep]; } nn.tags.forEach((t) => tags.add(t)); rad = Math.max(rad, nn.radius || 0); nc += nn.ncells || 0; if (m !== i) nn.alive = false; }
      Object.assign(nodes[i], { rep, tags: [...tags], radius: Math.max(rad, bd), ncells: nc, merged: members[i].length }); }
    for (const e of edges) { if (!e.alive) continue;
      const na = find(e.a), nb = e.b == null ? null : find(e.b);
      if (e.kind === 'road') {
        if (na !== e.a || members[na].length > 1) { const r = nodes[na].rep; if (e.cells[0] !== r) { e.length += dist(r, e.cells[0]); e.cells.unshift(r); e.moved = 1; } }
        if (nb !== e.b || members[nb].length > 1) { const r = nodes[nb].rep, l = e.cells[e.cells.length - 1]; if (l !== r) { e.length += dist(l, r); e.cells.push(r); e.moved = 1; } }
      }
      e.a = na; e.b = nb; }
  }
  st.contract = { merges: contracted };

  // ---- E. port clustering per region ----
  let portsBefore = 0, portsAfter = 0;
  if (o.portMerge > 0) {
    const pr = new Map(); // region -> [{e, side, cell}]
    for (const e of edges) { if (!e.alive) continue;
      for (const side of [0, 1]) { const nid = side ? e.b : e.a; if (nid == null || nodes[nid].kind !== 'region') continue;
        if (e.kind === 'teleport' || e.kind === 'ladder') continue;
        let cell;
        if (e.kind === 'road') cell = endCell(e, side);
        else if (e.kind === 'region_link') cell = e.cell;
        else if (e.kind === 'region_adj') cell = side ? e.v : e.u;
        if (!pr.has(nid)) pr.set(nid, []); pr.get(nid).push({ e, side, cell }); } }
    for (const [nid, ps] of pr) {
      const cl = []; // clusters of unique cells
      const uniq = [...new Set(ps.map((p) => p.cell))]; portsBefore += uniq.length;
      const cid = new Map();
      // greedy: sort by clearance desc; assign to existing cluster rep within portMerge
      uniq.sort((a, b) => dFull[b] - dFull[a]);
      for (const c of uniq) { let hit = -1;
        for (let k = 0; k < cl.length; k++) { const r = cl[k]; if (Math.hypot(X[r] - X[c], Z[r] - Z[c]) < o.portMerge && Math.abs(F[r] - F[c]) <= 16 * (o.portMergeDy != null ? o.portMergeDy : 2)) { hit = k; break; } }
        if (hit < 0) { cl.push(c); cid.set(c, c); } else cid.set(c, cl[hit]); }
      portsAfter += cl.length;
      for (const p of ps) { const r = cid.get(p.cell); if (r === p.cell) continue; const e = p.e;
        if (e.kind === 'road') { e.moved = 1; if (p.side === 0) { e.length += dist(r, e.cells[0]); e.cells.unshift(r); } else { e.length += dist(e.cells[e.cells.length - 1], r); e.cells.push(r); } }
        else if (e.kind === 'region_link') e.cell = r;
        else if (e.kind === 'region_adj') { if (p.side) e.v = r; else e.u = r; e.length = +dist(e.u, e.v).toFixed(2); } }
    }
  }
  st.ports = { before: portsBefore, after: portsAfter };

  // ---- R. refit moved road edges: bounded geodesic shortest path between the (new) end cells ----
  const rd = new Float64Array(N).fill(Infinity), rstamp = new Int32Array(N), rpar = new Int32Array(N); let rs = 0, refitN = 0, refitGain = 0;
  function refitEdge(e) {
    const s0 = e.cells[0], t0 = e.cells[e.cells.length - 1]; if (s0 === t0) return;
    const ra = nodes[e.a].kind === 'region' ? e.a : -1, rb = nodes[e.b].kind === 'region' ? e.b : -1;
    const ok = (v) => full.keep[v] && (owner[v] < 0 || owner[v] === ra || owner[v] === rb);
    rs++; const h = new Heap(); rstamp[s0] = rs; rd[s0] = 0; rpar[s0] = -1; h.push(0, s0); const lim = e.length + 1e-6; let found = false;
    while (h.size) { const [d, u] = h.pop(); if (d > rd[u]) continue; if (u === t0) { found = true; break; } if (d > lim) break;
      for (let j = P[u]; j < P[u + 1]; j++) { const v = NB[j]; if (!ok(v) && v !== t0) continue; const nd = d + dist(u, v); if (nd > lim) continue;
        if (rstamp[v] !== rs || nd < rd[v]) { rstamp[v] = rs; rd[v] = nd; rpar[v] = u; h.push(nd, v); } } }
    if (!found || rd[t0] >= e.length - 1e-6) return;
    const path = []; for (let u = t0; u >= 0; u = rpar[u]) path.push(u); path.reverse();
    refitGain += e.length - rd[t0]; refitN++; e.cells = path; e.length = rd[t0]; let w = Infinity; for (const c of path) w = Math.min(w, dFull[c]); e.width_min = Math.min(e.width_min, w);
  }
  if (o.refit) for (const e of edges) if (e.alive && e.kind === 'road' && e.moved && e.a !== e.b) refitEdge(e);
  st.refit = { edges: refitN, length_saved: +refitGain.toFixed(1) };

  function hausd(A, Bc) { const f = (P1, P2) => { let m = 0; for (let i = 0; i < P1.length; i += 2) { let b = Infinity; for (let j = 0; j < P2.length; j += 2) { const d = Math.hypot(X[P1[i]] - X[P2[j]], Z[P1[i]] - Z[P2[j]]); if (d < b) b = d; } if (b > m) m = b; } return m; }; return Math.max(f(A, Bc), f(Bc, A)); }
  // ---- F. cleanup: self loops, duplicates, deg-2 merge, spurs ----
  function degs() { const d = new Map(); for (const e of edges) { if (!e.alive) continue; if (e.kind === 'teleport' && e.b == null) continue; for (const x of [e.a, e.b]) if (x != null) d.set(x, (d.get(x) || 0) + 1); } return d; }
  let loops = 0, dups = 0, d2 = 0, spurs = 0;
  for (let round = 0; round < 10; round++) {
    let changed = 0;
    for (const e of edges) if (e.alive && e.kind === 'road' && e.a === e.b && e.length < 16 && !(o.keepRegionLoops && nodes[e.a].kind === 'region')) { e.alive = false; loops++; changed++; }
    for (const e of edges) if (e.alive && e.kind === 'region_link' && e.a === e.b) { e.alive = false; loops++; changed++; }
    if (o.dedupe) { const m = new Map();
      for (const e of edges) { if (!e.alive || (e.kind !== 'road' && e.kind !== 'region_link') || e.a === e.b) continue; const k = Math.min(e.a, e.b) + ',' + Math.max(e.a, e.b) + e.kind;
        const c = m.get(k); if (!c) { m.set(k, e); continue; }
        if (e.kind === 'region_link') { if (c.cell === e.cell || dist(c.cell, e.cell) < o.portMerge) { e.alive = false; dups++; changed++; } continue; }
        const lo = Math.min(c.length, e.length), hi = Math.max(c.length, e.length);
        if (hi - lo < o.dedupeTol * hi + 1 && hausd(c.cells, e.cells) <= o.dedupeSep) { if (e.length < c.length) { c.alive = false; m.set(k, e); } else e.alive = false; dups++; changed++; } } }
    // incident lists
    const inc = new Map(); for (const e of edges) { if (!e.alive) continue; for (const x of [e.a, e.b]) if (x != null) { if (!inc.has(x)) inc.set(x, []); inc.get(x).push(e); } }
    for (const [x, es] of inc) { const n = nodes[x]; if (!n.alive || n.kind !== 'sk' || n.tags.length) continue;
      const live = es.filter((e) => e.alive); if (live.length !== 2 || live.some((e) => e.kind !== 'road' || e.a === e.b)) continue;
      const [e1, e2] = live; const c1 = e1.a === x ? e1.cells.slice().reverse() : e1.cells, o1 = e1.a === x ? e1.b : e1.a;
      const c2 = e2.a === x ? e2.cells : e2.cells.slice().reverse(), o2 = e2.a === x ? e2.b : e2.a;
      if (o1 === x || o2 === x) continue;
      e1.alive = false; e2.alive = false; n.alive = false;
      edges.push({ kind: 'road', a: o1, b: o2, cells: c1.concat([n.rep], c2), length: e1.length + e2.length, width_min: Math.min(e1.width_min, e2.width_min), alive: true });
      d2++; changed++; break; // incident map stale after merge; restart
    }
    if (o.spurMin > 0) { const dg = degs();
      for (const e of edges) { if (!e.alive || e.kind !== 'road' || e.length >= o.spurMin) continue;
        for (const [x, y] of [[e.a, e.b], [e.b, e.a]]) { const n = nodes[x]; if (n.kind !== 'sk' || n.tags.length || dg.get(x) !== 1 || (dg.get(y) || 0) < 3) continue;
          e.alive = false; n.alive = false; spurs++; changed++; break; } } }
    if (!changed) break;
    if (round === 9) round = 8; // keep merging until stable (bounded by edge count)
    if (d2 > 5000) break;
  }
  st.cleanup = { self_loops: loops, dup_edges: dups, deg2_merged: d2, spurs };

  // ---- D. connect stray components ----
  let conns = 0, connLen = 0, unconnected = 0;
  let XP = P, XNB = NB;
  if (o.connect) { // extended adjacency: full planar + non-teleport PFG3 edges (jump/drop/climb, |dx|,|dz|<=4), symmetrised (same as eval.js)
    const lists = new Array(N); const add = (p, q) => { (lists[p] || (lists[p] = new Set())).add(q); };
    for (let u = 0; u < N; u++) { if (!full.keep[u]) continue; for (let j = P[u]; j < P[u + 1]; j++) add(u, NB[j]);
      const r = ctx.regs[ctx.RI[u]], k = ctx.RK[u];
      for (let e = r.ptr[k]; e < r.ptr[k + 1]; e++) { if (r.et[e] === SK.ET.teleport) continue; const v = ctx.lookup(r.dst[e]); if (v < 0 || v === u || !full.keep[v]) continue; if (Math.abs(X[v] - X[u]) > 4 || Math.abs(Z[v] - Z[u]) > 4) continue; add(u, v); add(v, u); } }
    XP = new Int32Array(N + 1); const nb = []; for (let u = 0; u < N; u++) { if (lists[u]) for (const v of lists[u]) nb.push(v); XP[u + 1] = nb.length; } XNB = Int32Array.from(nb);
  }
  if (o.connect) {
    for (let pass = 0; pass < 3; pass++) {
      const alive = nodes.map((n) => n.alive);
      const p2 = nodes.map((_, i) => i); const f2 = (x) => { while (p2[x] !== x) { p2[x] = p2[p2[x]]; x = p2[x]; } return x; };
      for (const e of edges) if (e.alive && e.b != null) p2[f2(e.a)] = f2(e.b);
      const size = new Map(); nodes.forEach((n, i) => { if (n.alive) { const r = f2(i); size.set(r, (size.get(r) || 0) + (n.kind === 'region' ? n.cells.length : 1) + 0); } });
      for (const e of edges) if (e.alive && e.kind === 'road') { const r = f2(e.a); size.set(r, size.get(r) + e.cells.length); }
      let main = -1, ms = -1; for (const [r, s] of size) if (s > ms) { ms = s; main = r; }
      if (size.size <= 1) break;
      // cell ownership: node id / road edge
      const cn = new Int32Array(N).fill(-1), ce = new Int32Array(N).fill(-1), ci = new Int32Array(N).fill(-1), comp = new Int32Array(N).fill(-1);
      nodes.forEach((n, i) => { if (!n.alive) return; const r = f2(i); if (n.kind === 'region') for (const c of n.cells) { cn[c] = i; comp[c] = r; } else { cn[n.rep] = i; comp[n.rep] = r; } });
      edges.forEach((e, k) => { if (!e.alive || e.kind !== 'road') return; const r = f2(e.a); e.cells.forEach((c, i) => { if (cn[c] < 0) { ce[c] = k; ci[c] = i; comp[c] = r; } }); });
      const roots = [...size.keys()].filter((r) => r !== main);
      let did = 0;
      for (const r of roots) {
        // multi-source from all cells of this comp
        const srcs = []; for (let c = 0; c < N; c++) if (comp[c] === r) srcs.push(c);
        const D = new Map(), par = new Map(), h = new Heap(); for (const s of srcs) { D.set(s, 0); h.push(0, s); }
        let hit = -1;
        while (h.size) { const [d, u] = h.pop(); if (d > D.get(u)) continue; if (d > o.connectMax) break;
          if (comp[u] >= 0 && f2(comp[u]) !== r && comp[u] !== r) { hit = u; break; }
          for (let j = XP[u]; j < XP[u + 1]; j++) { const v = XNB[j]; if (!full.keep[v]) continue; const nd = d + dist(u, v); if (nd < (D.has(v) ? D.get(v) : Infinity)) { D.set(v, nd); par.set(v, u); h.push(nd, v); } } }
        if (hit < 0) { unconnected++; continue; }
        const path = [hit]; let u = hit; while (par.has(u)) { u = par.get(u); path.push(u); } path.reverse();
        const s = path[0];
        const ownerNode = (c) => { if (cn[c] >= 0) return cn[c]; // split road edge at c
          const k = ce[c], e = edges[k], i = ci[c]; const id = nodes.length;
          nodes.push({ kind: 'sk', tags: ['connector'], rep: c, radius: dFull[c], ncells: 1, alive: true });
          const l1 = segLen(e.cells, 0, i), l2 = e.length - l1;
          edges.push({ kind: 'road', a: id, b: e.b, cells: e.cells.slice(i), length: Math.max(0, l2), width_min: e.width_min, alive: true });
          { const ni = edges.length - 1, nc = edges[ni].cells; for (let q = 1; q < nc.length; q++) if (cn[nc[q]] < 0) { ce[nc[q]] = ni; ci[nc[q]] = q; } }
          e.b = id; e.cells = e.cells.slice(0, i + 1); e.length = l1;
          cn[c] = id; return id; };
        const a = ownerNode(s), b = ownerNode(hit);
        const L = D.get(hit); let wmin = Infinity; for (const c of path) wmin = Math.min(wmin, dFull[c]);
        edges.push({ kind: 'road', a, b, cells: path, length: L, width_min: wmin, alive: true, connector: true });
        conns++; connLen += L; did++;
        p2[f2(a)] = f2(b);
      }
      if (!did) break;
    }
  }
  function segLen(cs, i0, i1) { let s = 0; for (let i = i0; i < i1; i++) s += dist(cs[i], cs[i + 1]); return s; }
  st.connect = { connectors: conns, connector_length: +connLen.toFixed(1), unconnected_components: unconnected };
  if (o.repair) st.repair = repairDirected(ctx, full, nodes, edges, dist, o);
  return { nodes, edges, st };
}

// ---------- v4: directed repair ----------
// The skeleton is extracted from a symmetrised walk graph. On one-way terrain (drops) a road can be walkable in one direction only.
// For every road that is blocked (or much longer) in one direction, add a return road along the shortest DIRECTED cell path.
function repairDirected(ctx, full, nodes, edges, dist, o) {
  const { N, X, Z } = ctx; const fl = new Array(N);
  for (let u = 0; u < N; u++) { if (!full.keep[u]) continue; const r = ctx.regs[ctx.RI[u]], k = ctx.RK[u];
    for (let e = r.ptr[k]; e < r.ptr[k + 1]; e++) { if (r.et[e] === SK.ET.teleport) continue; const v = ctx.lookup(r.dst[e]); if (v < 0 || v === u || !full.keep[v]) continue; if (Math.abs(X[v] - X[u]) > 4 || Math.abs(Z[v] - Z[u]) > 4) continue; (fl[u] || (fl[u] = [])).push(v); } }
  const SP = full.P, SNB = full.NB; const mask = new Int32Array(N); let stp = 0;
  const dij = (a, b, maxD, useMask) => { const D = new Map([[a, 0]]), par = new Map(), h = new Heap(); h.push(0, a);
    while (h.size) { const [d, u] = h.pop(); if (d > D.get(u)) continue; if (u === b) break; if (d > maxD) return null;
      const l = fl[u]; if (l) for (const v of l) { if (useMask && mask[v] !== stp) continue; const nd = d + dist(u, v); if (nd < (D.has(v) ? D.get(v) : Infinity)) { D.set(v, nd); par.set(v, u); h.push(nd, v); } } }
    if (!D.has(b)) return null; const p = [b]; let u = b; while (par.has(u)) { u = par.get(u); p.push(u); } p.reverse(); return { d: D.get(b), path: p }; };
  const corr = (cells, rad) => { stp++; let fr = cells.slice(); for (const c of fr) mask[c] = stp; for (let k = 0; k < rad; k++) { const nx = []; for (const u of fr) for (let j = SP[u]; j < SP[u + 1]; j++) { const v = SNB[j]; if (mask[v] !== stp) { mask[v] = stp; nx.push(v); } } fr = nx; } };
  let checked = 0, blocked = 0, added = 0, addLen = 0; const add = [];
  for (const e of edges) { if (!e.alive || e.kind !== 'road' || e.b == null || e.cells.length < 2) continue; checked++;
    const a = e.cells[0], b = e.cells[e.cells.length - 1]; corr(e.cells, 2);
    for (const [x, y, fwd] of [[a, b, 1], [b, a, 0]]) {
      const c = dij(x, y, 4 * e.length + 16, true); if (c && c.d <= o.repairK * e.length + 4) continue;
      blocked++; const f = dij(x, y, o.repairK * 2 * e.length + o.repairMax, false); if (!f) continue;
      if (c && f.d >= c.d - 2) continue;
      add.push({ kind: 'road', a: fwd ? e.a : e.b, b: fwd ? e.b : e.a, cells: f.path, length: f.d, width_min: e.width_min, alive: true, oneway: true, repair: true }); added++; addLen += f.d; } }
  for (const r of add) edges.push(r);
  return { checked, blocked_dirs: blocked, added, added_length: +addLen.toFixed(1) };
}

// ---------- output ----------
function outputV3(res, pp, o) {
  const { ctx, dFull } = res, { X, Z, F, box } = ctx;
  const cp = (c) => SK.cellPos(ctx, c);
  const inBox = (c) => X[c] >= box.x0 && X[c] <= box.x1 && Z[c] >= box.z0 && Z[c] <= box.z1;
  const { nodes, edges } = pp;
  const keepN = new Set();
  const liveE = edges.filter((e) => e.alive && (e.b == null || e.a !== e.b || e.kind === 'road'));
  for (const e of liveE) { keepN.add(e.a); if (e.b != null) keepN.add(e.b); }
  nodes.forEach((n, i) => { if (n.alive && n.kind === 'region') keepN.add(i); });
  const nid = new Map(); const ON = [];
  const deg = new Map(); for (const e of liveE) if (e.kind !== 'teleport') for (const x of [e.a, e.b]) if (x != null) deg.set(x, (deg.get(x) || 0) + 1);
  [...keepN].sort((a, b) => a - b).forEach((i) => { const n = nodes[i]; if (!n.alive) return;
    const id = ON.length; nid.set(i, id); const d = deg.get(i) || 0;
    if (n.kind === 'region') {
      let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
      for (const c of n.cells) { const y = F[c] / 16; x0 = Math.min(x0, X[c]); x1 = Math.max(x1, X[c]); z0 = Math.min(z0, Z[c]); z1 = Math.max(z1, Z[c]); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const r = { id, kind: n.rkind, pos: cp(n.rep), cells: n.cells.length, bbox: [x0, +y0.toFixed(2), z0, x1, +y1.toFixed(2), z1], deg: d, region: n.region };
      if (n.parent != null) { r.parent_region = n.region; r.piece = n.piece; }
      r.cell_list = n.cells.map(cp);
      Object.defineProperty(r, '_rep', { value: n.rep, enumerable: false }); Object.defineProperty(r, '_cells', { value: n.cells, enumerable: false });
      ON.push(r);
    } else {
      const kind = d >= 3 ? 'junction' : d === 1 ? 'end' : d === 0 ? 'isolated' : 'pass';
      const r = { id, kind: n.tags.length && kind !== 'junction' ? 'forced' : kind, tags: n.tags, pos: cp(n.rep), radius: +(n.radius || 0).toFixed(2), cells: n.ncells || 1, deg: d };
      if (n.merged) r.merged = n.merged;
      Object.defineProperty(r, '_rep', { value: n.rep, enumerable: false });
      ON.push(r);
    }
  });
  const OE = [];
  for (const e of liveE) {
    const a = nid.get(e.a), b = e.b == null ? null : nid.get(e.b); if (a == null || (e.b != null && b == null)) continue;
    if (e.kind === 'road') {
      if (o.clipBox && !e.cells.some(inBox)) continue;
      const pl = []; for (let i = 0; i < e.cells.length; i += o.polyStep) pl.push(cp(e.cells[i]));
      if ((e.cells.length - 1) % o.polyStep) pl.push(cp(e.cells[e.cells.length - 1]));
      const r = { a, b, kind: 'road', length: +e.length.toFixed(2), width_min: +(e.width_min === Infinity ? 0 : e.width_min).toFixed(2), cells: e.cells.length, polyline: pl };
      if (e.connector) r.connector = true; if (e.oneway) r.oneway = true; if (e.repair) r.repair = true;
      Object.defineProperty(r, '_cells', { value: e.cells, enumerable: false }); OE.push(r);
    } else if (e.kind === 'region_link') OE.push({ a, b, kind: 'region_link', at: cp(e.cell), length: 0 });
    else if (e.kind === 'region_adj') OE.push({ a, b, kind: 'region_adj', a_pos: cp(e.u), b_pos: cp(e.v), length: e.length });
    else { const r = { a, b, kind: e.kind, at: cp(e.u) }; if (e.v != null && e.v >= 0) r.to = cp(e.v); if (e.length != null) r.length = e.length; if (e.dst_gid != null) r.dst_gid = e.dst_gid; if (e.ladder_cells != null) r.ladder_cells = e.ladder_cells; OE.push(r); }
  }
  const byK = (arr) => { const m = {}; for (const x of arr) m[x.kind] = (m[x.kind] || 0) + 1; return m; };
  return { nodes: ON, edges: OE, stats: { nodes: ON.length, nodes_by_kind: byK(ON), edges: OE.length, edges_by_kind: byK(OE), road_length_total: +OE.filter((e) => e.kind === 'road').reduce((s, e) => s + e.length, 0).toFixed(1) } };
}

// attach region crossing matrix from eval's L1 model (same costs eval uses)
function attachCross(graph, L) {
  const per = new Map();
  for (let v = 0; v < L.adj.length; v++) for (const [u, w, info] of L.adj[v] || []) {
    if (!info || info.cross == null || u === v) continue; // v4: directed, both (i,j) and (j,i) are stored
    const nid = info.cross; if (!per.has(nid)) per.set(nid, new Map());
    per.get(nid).set(v + ',' + u, w);
  }
  for (const n of graph.nodes) {
    if (!n.cell_list) continue;
    const ps = L.regPorts && L.regPorts.get ? L.regPorts.get(n.id) : null;
    if (!ps) { n.ports = []; n.cross = []; continue; }
    const arr = [...ps]; const idx = new Map(arr.map((v, i) => [v, i]));
    n.ports = arr.map((v) => SK.cellPos(L.ctx || graph._ctx, L.V[v].cell));
    const m = per.get(n.id) || new Map(); n.cross = [];
    for (const [k, w] of m) { const [a, b] = k.split(',').map(Number); if (idx.has(a) && idx.has(b)) n.cross.push([idx.get(a), idx.get(b), +w.toFixed(2)]); }
  }
}

// ---------- v4: local directed spanner ----------
// For every L1 vertex x (sk node or region port) run a directed cell Dijkstra up to spanR. For every other vertex y reached at cell
// distance d, if the current L1 distance x->y exceeds spanT*d + spanAdd, add a shortcut road along the cell path (greedy, shortest d first,
// re-checked after each insertion). This bounds the local stretch of the L1 graph and fills holes the skeleton missed.
function spanner(graph, ectx, L, EV, o) {
  const { V, adj } = L; const cp = (c) => SK.cellPos(ectx, c); const nV = V.length;
  const byCell = new Map(); V.forEach((x, v) => { if (x.cell < 0) return; if (!byCell.has(x.cell)) byCell.set(x.cell, []); byCell.get(x.cell).push(v); });
  const l1 = (src, lim, stop) => { const D = new Map([[src, 0]]), h = new Heap(); h.push(0, src);
    while (h.size) { const [d, v] = h.pop(); if (d > D.get(v)) continue; if (v === stop) return d; if (d > lim) break;
      for (const [u, w] of adj[v]) { const nd = d + w; if (nd <= lim && nd < (D.has(u) ? D.get(u) : Infinity)) { D.set(u, nd); h.push(nd, u); } } }
    return stop != null ? Infinity : D; };
  const cand = [];
  for (let x = 0; x < nV; x++) { const cx = V[x].cell; if (cx < 0) continue;
    const { dist } = EV.dijkstra(ectx, [[cx, 0]], { dir: 'f', maxD: o.spanR });
    const D1 = l1(x, o.spanT * o.spanR + o.spanAdd);
    for (const [c, d] of dist) { if (d < o.spanMin) continue; const ys = byCell.get(c); if (!ys) continue;
      for (const y of ys) { if (V[y].node === V[x].node) continue; const l = D1.has(y) ? D1.get(y) : Infinity; if (l > o.spanT * d + o.spanAdd) cand.push([d, x, y]); } } }
  cand.sort((a, b) => a[0] - b[0]);
  let added = 0, addLen = 0; const E = graph.edges;
  for (const [d, x, y] of cand) {
    if (l1(x, o.spanT * d + o.spanAdd, y) <= o.spanT * d + o.spanAdd) continue;
    const { dist, par } = EV.dijkstra(ectx, [[V[x].cell, 0]], { dir: 'f', parents: true, stopAt: V[y].cell, maxD: d + 1 });
    if (!dist.has(V[y].cell)) continue;
    const path = []; for (let c = V[y].cell; c != null && c >= 0; c = par.get(c)) { path.push(c); if (c === V[x].cell) break; } path.reverse();
    const pl = []; for (let i = 0; i < path.length; i += o.polyStep) pl.push(cp(path[i])); if ((path.length - 1) % o.polyStep) pl.push(cp(path[path.length - 1]));
    const e = { a: V[x].node, b: V[y].node, kind: 'road', length: +d.toFixed(2), width_min: 0, cells: path.length, polyline: pl, a_pos: cp(V[x].cell), b_pos: cp(V[y].cell), shortcut: true, oneway: true };
    Object.defineProperty(e, '_cells', { value: path, enumerable: false });
    E.push(e); adj[x].push([y, d, { e: E.length - 1 }]); added++; addLen += d; }
  return { candidates: cand.length, added, added_length: +addLen.toFixed(1), spanR: o.spanR, spanT: o.spanT, spanAdd: o.spanAdd };
}

// ---------- v4: parent regions (hierarchy) ----------
// Every v2-size region that was split gets a parent record. Children = its piece nodes. Parent ports = child ports that have an L1 edge
// leaving the parent. Parent cross = directed shortest L1 distance between parent ports using only child crossings and child-child edges.
function buildParents(graph, L, ctx) {
  const byReg = new Map(); for (const n of graph.nodes) if (n.parent_region != null) { if (!byReg.has(n.parent_region)) byReg.set(n.parent_region, []); byReg.get(n.parent_region).push(n.id); }
  const parents = [];
  for (const [reg, kids] of byReg) {
    const kset = new Set(kids); const inP = (v) => v >= 0 && v < L.V.length && kset.has(L.V[v].node);
    const ports = []; const vs = []; for (const k of kids) for (const v of L.regPorts.get(k) || []) vs.push(v);
    for (const v of vs) { let out = false; for (const [u] of L.adj[v]) if (!inP(u)) { out = true; break; } if (!out) for (const x of vs) {} if (out) ports.push(v); }
    // incoming edges too (vertex reached from outside)
    const pset = new Set(ports); for (let v = 0; v < L.adj.length; v++) { if (inP(v)) continue; for (const [u] of L.adj[v]) if (inP(u) && !pset.has(u)) { pset.add(u); ports.push(u); } }
    const idx = new Map(ports.map((v, i) => [v, i])); const cross = [];
    for (const p of ports) { const D = new Map([[p, 0]]), h = new Heap(); h.push(0, p);
      while (h.size) { const [d, v] = h.pop(); if (d > D.get(v)) continue; for (const [u, w] of L.adj[v]) { if (!inP(u)) continue; const nd = d + w; if (nd < (D.has(u) ? D.get(u) : Infinity)) { D.set(u, nd); h.push(nd, u); } } }
      for (const q of ports) if (q !== p && D.has(q)) cross.push([idx.get(p), idx.get(q), +D.get(q).toFixed(2)]); }
    const first = graph.nodes[kids[0]]; let cells = 0; const bb = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
    for (const k of kids) { const n = graph.nodes[k]; cells += n.cells; for (let i = 0; i < 3; i++) { bb[i] = Math.min(bb[i], n.bbox[i]); bb[i + 3] = Math.max(bb[i + 3], n.bbox[i + 3]); } }
    parents.push({ id: 'P' + reg, region: reg, kind: first.kind, cells, bbox: bb, children: kids, ports: ports.map((v) => SK.cellPos(ctx, L.V[v].cell)), port_child: ports.map((v) => L.V[v].node), cross });
  }
  for (const p of parents) for (const k of p.children) graph.nodes[k].parent = p.id;
  graph.parents = parents; return { parents: parents.length, children: parents.reduce((s, p) => s + p.children.length, 0), ports: parents.reduce((s, p) => s + p.ports.length, 0) };
}

// ---------- render ----------
function renderV3(res, graph, routes, scale = 3, ro = {}) {
  const star = ro.star === true, drawShort = ro.shortcuts !== false;
  const { ctx, full, dFull } = res, { X, Z, F, T, N, box } = ctx;
  const W = box.x1 - box.x0 + 1, H = box.z1 - box.z0 + 1, w = W * scale, h = H * scale;
  const img = Buffer.alloc(w * h * 3);
  const top = new Int32Array(W * H).fill(-1);
  for (let u = 0; u < N; u++) { if (!full.keep[u]) continue; const x = X[u] - box.x0, z = Z[u] - box.z0; if (x < 0 || z < 0 || x >= W || z >= H) continue; const k = z * W + x; if (top[k] < 0 || F[u] > F[top[k]]) top[k] = u; }
  const colReg = new Int32Array(W * H).fill(-1);
  graph.nodes.forEach((n) => { if (!n._cells) return; for (const c of n._cells) { const x = X[c] - box.x0, z = Z[c] - box.z0; if (x < 0 || z < 0 || x >= W || z >= H) continue; const k = z * W + x; if (colReg[k] < 0 || top[k] === c) colReg[k] = n.id; } });
  const hue = (i) => { const hh = (i * 0.618034) % 1, s = 0.7, v = 1; const k = (n) => (n + hh * 6) % 6; const f = (n) => v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1)); return [f(5), f(3), f(1)].map((q) => Math.round(q * 255)); };
  const lerp = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  const put = (px, py, c) => { if (px < 0 || py < 0 || px >= w || py >= h) return; const o = (py * w + px) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; };
  const KB = { building: [255, 255, 255], grove: [0, 200, 60], plaza: [255, 150, 0] };
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const k = z * W + x, u = top[k]; let c;
    if (u < 0) c = [28, 28, 32];
    else { const s = Math.min(1, (Math.min(dFull[u], 8) - 0.5) / 7.5); c = (T[u] & 6) ? lerp([15, 30, 90], [120, 170, 250], s) : lerp([45, 60, 45], [150, 160, 140], s); }
    const r = colReg[k];
    if (r >= 0) { const n = graph.nodes[r]; const base = KB[n.kind] || [200, 200, 200]; const hc = lerp(base, hue(r), 0.6); c = lerp(c, hc, 0.5);
      // v4: parent border (different parent / no region) = thick black; child border (same parent, other piece) = thin light line
      const par = (id) => id < 0 ? null : (graph.nodes[id].parent || 'n' + id);
      const P = par(r); let pb = [0, 0, 0, 0], cb = [0, 0, 0, 0];
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dz], i) => { const xx = x + dx, zz = z + dz; const o = (xx < 0 || zz < 0 || xx >= W || zz >= H) ? -1 : colReg[zz * W + xx]; if (o === r) return; if (par(o) !== P) pb[i] = 1; else cb[i] = 1; });
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const onP = (pb[0] && dx === scale - 1) || (pb[1] && dx === 0) || (pb[2] && dy === scale - 1) || (pb[3] && dy === 0);
        const onC = (cb[0] && dx === scale - 1) || (cb[1] && dx === 0) || (cb[2] && dy === scale - 1) || (cb[3] && dy === 0);
        put(x * scale + dx, z * scale + dy, onP ? [0, 0, 0] : onC ? lerp(c, [255, 255, 255], 0.45) : c); }
      continue; }
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(x * scale + dx, z * scale + dy, c);
  }
  const px = (p) => [Math.round((p[0] - box.x0) * scale + (scale >> 1)), Math.round((p[2] - box.z0) * scale + (scale >> 1))];
  const line = (a, b, c, t = 0) => { const [x0, y0] = a, [x1, y1] = b; const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) { const xx = Math.round(x0 + (x1 - x0) * i / n), yy = Math.round(y0 + (y1 - y0) * i / n); for (let dx = -t; dx <= t; dx++) for (let dy = -t; dy <= t; dy++) put(xx + dx, yy + dy, c); } };
  const disc = (p, r, c) => { for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) if (dx * dx + dy * dy <= r * r) put(p[0] + dx, p[1] + dy, c); };
  const sq = (p, r, c) => { for (let d = -r; d <= r; d++) { put(p[0] + d, p[1] - r, c); put(p[0] + d, p[1] + r, c); put(p[0] - r, p[1] + d, c); put(p[0] + r, p[1] + d, c); } };
  for (const e of graph.edges) {
    if (e.kind === 'road') { if (e.shortcut && !drawShort) continue;
      const col = e.shortcut ? [150, 70, 40] : e.connector ? [255, 120, 255] : e.repair ? [255, 140, 140] : [235, 20, 20];
      const cs = e._cells ? e._cells.map((c) => SK.cellPos(ctx, c)) : e.polyline; for (let i = 1; i < cs.length; i++) line(px(cs[i - 1]), px(cs[i]), col);
      if (star) { const A = graph.nodes[e.a], B = graph.nodes[e.b]; if (A && A.cell_list) line(px(A.pos), px(cs[0]), [255, 255, 255]); if (B && B.cell_list) line(px(cs[cs.length - 1]), px(B.pos), [255, 255, 255]); } }
    else if (e.kind === 'region_link') { if (star) { line(px(graph.nodes[e.a].pos), px(e.at), [255, 255, 255]); if (e.b != null) line(px(e.at), px(graph.nodes[e.b].pos), [255, 255, 255]); } }
    else if (e.kind === 'region_adj') { if (star) { line(px(graph.nodes[e.a].pos), px(e.a_pos), [200, 200, 255]); line(px(e.b_pos), px(graph.nodes[e.b].pos), [200, 200, 255]); } }
  }
  // exit (port) dots: small white squares with black centre at every region port
  for (const n of graph.nodes) if (n.cell_list && n.ports) for (const q of n.ports) { const p = px(q); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) put(p[0] + dx, p[1] + dy, (dx || dy) ? [255, 255, 255] : [0, 0, 0]); }
  // test routes: cyan and lime (not used by any other layer), black outline
  const RC = [[0, 240, 255], [170, 255, 0]];
  (routes || []).forEach((r, i) => { const g = r.geometry; if (!g) return; for (let j = 1; j < g.length; j++) line(px(g[j - 1]), px(g[j]), [0, 0, 0], 2); for (let j = 1; j < g.length; j++) line(px(g[j - 1]), px(g[j]), RC[i % 2], 1);
    disc(px(g[0]), 3 * scale, [0, 0, 0]); disc(px(g[0]), 3 * scale - 1, RC[i % 2]); disc(px(g[g.length - 1]), 3 * scale, [0, 0, 0]); disc(px(g[g.length - 1]), 3 * scale - 1, RC[i % 2]); });
  const COL = { junction: [255, 230, 0], end: [40, 110, 255], isolated: [40, 110, 255], forced: [0, 240, 240], pass: [255, 230, 0] };
  for (const n of graph.nodes) { const p = px(n.pos); if (n.cell_list) { if (star) { sq(p, 2 * scale, KB[n.kind]); sq(p, 2 * scale - 1, [0, 0, 0]); } } else disc(p, scale, COL[n.kind] || [255, 255, 255]); }
  return { png: SK.encodePNG(w, h, img), w, h };
}

module.exports = { V3, hookCanopy, postV3, outputV3, attachCross, renderV3, spanner, buildParents };
