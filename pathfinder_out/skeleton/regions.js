'use strict';
// v2: building (indoor) + plaza regions on top of the v1 skeleton. See README "v2".
// Pure Node. Reads the PFG3 data through skeleton.js and the 1.8 Anvil world backup through mca.js (read-only).
const SK = require('./skeleton');
const { World } = require('./mca');

const V2 = {
  world: 'C:/Users/Administrator/Desktop/vake/.server/盘灵古域/world_backup_20261028_1454/region',
  roofMin: 2,          // first block checked above the foot block: floor(f)+roofMin (0 = feet, 1 = head)
  roofMax: 12,         // last block checked: floor(f)+roofMax
  bldMinCells: 12,     // building region must have at least this many cells
  bldMaxOpen: 0.60,    // max share of region perimeter cells that open onto walkable outdoor cells
  bldMaxCells: 20000,  // larger roofed components are not buildings (safety)
  eavePeel: 0,         // rounds of peeling roofed cells that open onto outdoor cells (eaves, verandas)
  holeMax: 8,          // unroofed pockets up to this size fully inside a building are absorbed
  roomMax: 400,        // door-cut: components behind doors/gates up to this size become buildings (if partly roofed)
  roomRoofMin: 0.25,   // ... and at least this share of their cells is roofed
  groveClose: 3,       // canopy closing radius (steps): gaps up to ~2*groveClose between tree crowns are filled
  groveMin: 150,       // grove must have at least this many cells
  groveCanopy: 0.5,    // ... and at least this share directly under canopy
  plazaD: 6,
  plazaMin: 40,        // core (d >= plazaD) cells
  plazaElong: 3.0,     // core area / (pi * (dmax - plazaD + 0.5)^2) above this = wide road, not a plaza
  spurLen: 8,          // final graph: end-node edges shorter than this are pruned
};

// ---- roof rule: 1.8 ids that do NOT count as a roof ----
const NOT_ROOF = new Set([
  0, 6, 8, 9, 10, 11,            // air, sapling, water, lava
  18, 161,                       // leaves (trees)
  99, 100,                       // huge mushroom blocks (all meta 14): orange 'autumn' tree canopies on this map
  30, 31, 32, 37, 38, 39, 40, 59, 83, 104, 105, 106, 111, 115, 127, 141, 142, 175, // plants, web, vines, crops
  50, 51, 55, 63, 65, 66, 68, 69, 70, 72, 75, 76, 77, 131, 132, 143, 144, 147, 148, 176, 177, 27, 28, 157, // thin attachments
  85, 113, 188, 189, 190, 191, 192, 139, 101, 102, 160, // fences, walls, bars, panes
  107, 183, 184, 185, 186, 187, 64, 71, 193, 194, 195, 196, 197, 96, 167, // gates, doors, trapdoors
  78,                            // snow layer
]);

const CANOPY = new Set([18, 161, 99, 100]); // leaves + huge mushroom blocks
function roofScan(ctx, W, o) {
  const { N, X, Z, F, keep } = ctx; const roof = new Uint8Array(N), roofId = new Uint16Array(N), roofH = new Uint8Array(N), canopy = new Uint8Array(N);
  for (let u = 0; u < N; u++) {
    if (!keep[u]) continue; const x = X[u], z = Z[u], b = Math.floor(F[u] / 16);
    for (let y = b + o.roofMin; y <= b + o.roofMax; y++) {
      const id = W.getBlock(x, y, z); if (!id) continue;
      if (CANOPY.has(id)) { canopy[u] = 1; break; } // first thing overhead is a tree canopy
      if (!NOT_ROOF.has(id)) { roof[u] = 1; roofId[u] = id; roofH[u] = y - b; break; }
    }
  }
  return { roof, roofId, roofH, canopy };
}

// ---- groves: large connected areas under tree canopy (closing of canopy cells on the walk graph) ----
function detectGroves(ctx, rs, B, o) {
  const { N, P, NB, keep } = ctx; const { canopy } = rs; const st = {};
  const free = (u) => keep[u] && B.R[u] < 0;
  // dilation: BFS distance (steps) from canopy cells
  const bfs = (src) => { const dist = new Int16Array(N).fill(32767); const q = []; for (let u = 0; u < N; u++) if (src(u)) { dist[u] = 0; q.push(u); }
    for (let i = 0; i < q.length; i++) { const a = q[i]; if (dist[a] >= o.groveClose) continue; for (let j = P[a]; j < P[a + 1]; j++) { const v = NB[j]; if (free(v) && dist[v] === 32767) { dist[v] = dist[a] + 1; q.push(v); } } } return dist; };
  const d1 = bfs((u) => free(u) && canopy[u]);
  const dil = (u) => free(u) && d1[u] <= o.groveClose;
  const d2 = bfs((u) => free(u) && !dil(u)); // erosion: distance to non-dilated walkable cells
  const gc = new Uint8Array(N); let n = 0;
  for (let u = 0; u < N; u++) if (free(u) && (canopy[u] || (dil(u) && d2[u] > o.groveClose))) { gc[u] = 1; n++; }
  st.closed_cells = n;
  const mark = new Int32Array(N).fill(-1); const rej = { small: 0, sparse: 0 }; let made = 0, cells = 0;
  for (let u = 0; u < N; u++) {
    if (!gc[u] || mark[u] !== -1) continue;
    const c = bfsComp(u, mark, 0, (a, f) => { for (let j = P[a]; j < P[a + 1]; j++) if (gc[NB[j]]) f(NB[j]); });
    let can = 0; for (const a of c) can += canopy[a];
    if (c.length < o.groveMin) { rej.small++; continue; }
    if (can < o.groveCanopy * c.length) { rej.sparse++; continue; }
    const id = B.blds.length; for (const a of c) B.R[a] = id;
    B.blds.push({ id, kind: 'grove', cells: c, canopy: can, roofed: 0, openness: 0 }); made++; cells += c.length;
  }
  Object.assign(st, { groves: made, grove_cells: cells, rejected: rej });
  return st;
}

// floor check: the block the cell stands on (or the slab/stair block containing the feet) is not passable
function floorCheck(ctx, W, samples = 3000) {
  const { N, X, Z, F, T, keep } = ctx; let ok = 0, bad = 0, n = 0; const ex = []; let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < samples * 4 && n < samples; i++) {
    const u = Math.floor(rnd() * N); if (!keep[u] || (T[u] & (2 | 4 | 8))) continue; n++;
    const f = F[u] / 16, x = X[u], z = Z[u]; const by = f === Math.floor(f) ? f - 1 : Math.floor(f);
    const id = W.getBlock(x, by, z); const fb = ctx.FB[u] >> 4;
    if (id && !NOT_ROOF.has(id) || CANOPY.has(id) || id === 85 || id === 139 || id === 107) ok++; else { bad++; if (ex.length < 5) ex.push([x, f, z, id]); }
    if (id === fb) ctx._fbMatch = (ctx._fbMatch || 0) + 1;
  }
  return { sampled: n, solid_below: ok, not_solid: bad, fb_field_matches_world: ctx._fbMatch || 0, examples: ex };
}

function bfsComp(start, mark, id, nbrs) { const q = [start]; mark[start] = id; for (let i = 0; i < q.length; i++) nbrs(q[i], (v) => { if (mark[v] === -1) { mark[v] = id; q.push(v); } }); return q; }

// ---- step A: building regions on the full (kept) planar graph ----
function detectBuildings(ctx, rs, o) {
  const { N, P, NB, DE, keep } = ctx; const { roof } = rs;
  const st = {};
  // A1 door cut: components without door/gate edges
  const dc = new Int32Array(N).fill(-1); const dcomps = [];
  for (let u = 0; u < N; u++) if (keep[u] && dc[u] === -1) dcomps.push(bfsComp(u, dc, dcomps.length, (a, f) => { for (let j = P[a]; j < P[a + 1]; j++) if (!DE[j]) f(NB[j]); }));
  let big = 0; dcomps.forEach((c, i) => { if (c.length > dcomps[big].length) big = i; });
  const cand = new Uint8Array(N); // 1 roofed, 2 door-cut room
  let rooms = 0, roomCells = 0;
  dcomps.forEach((c, i) => {
    if (i === big || c.length > o.roomMax) return;
    let doorTouch = false; for (const a of c) { for (let j = P[a]; j < P[a + 1]; j++) if (DE[j]) { doorTouch = true; break; } if (doorTouch) break; }
    let r = 0; for (const a of c) r += roof[a];
    if (!doorTouch || r < o.roomRoofMin * c.length) return;
    rooms++; roomCells += c.length; for (const a of c) cand[a] = 2;
  });
  for (let u = 0; u < N; u++) if (keep[u] && roof[u] && !cand[u]) cand[u] = 1;
  st.door_cut = { components: dcomps.length, main: dcomps[big].length, rooms, room_cells: roomCells };
  // A2 absorb small unroofed pockets enclosed by candidate cells (light wells, a missing roof block)
  const hm = new Int32Array(N).fill(-1); let holes = 0, holeCells = 0;
  for (let u = 0; u < N; u++) {
    if (!keep[u] || cand[u] || hm[u] !== -1) continue;
    const c = bfsComp(u, hm, 0, (a, f) => { for (let j = P[a]; j < P[a + 1]; j++) if (!cand[NB[j]]) f(NB[j]); });
    if (c.length <= o.holeMax) { let touch = false; for (const a of c) for (let j = P[a]; j < P[a + 1]; j++) if (cand[NB[j]]) touch = true; if (touch) { holes++; holeCells += c.length; for (const a of c) cand[a] = 3; } }
  }
  st.holes = { pockets: holes, cells: holeCells };
  // A2b peel eaves: roofed cells reachable from outdoor cells by a non-door planar edge are removed, eavePeel rounds.
  // An overhang strip (1-2 cells wide, open on one side) disappears; a walled interior keeps its body.
  let peeled = 0;
  for (let r = 0; r < o.eavePeel; r++) {
    const rm = [];
    for (let u = 0; u < N; u++) { if (!cand[u] || cand[u] === 2) continue; for (let j = P[u]; j < P[u + 1]; j++) { const v = NB[j]; if (!DE[j] && !cand[v] && keep[v]) { rm.push(u); break; } } }
    for (const u of rm) cand[u] = 0; peeled += rm.length;
  }
  st.eave_peeled = peeled;
  // A3 components of candidate cells (planar + door edges: rooms joined by inner doors are one building)
  const rc = new Int32Array(N).fill(-1); const comps = [];
  for (let u = 0; u < N; u++) if (cand[u] && rc[u] === -1) comps.push(bfsComp(u, rc, comps.length, (a, f) => { for (let j = P[a]; j < P[a + 1]; j++) if (cand[NB[j]]) f(NB[j]); }));
  // A4 filter by area and openness (share of perimeter cells with a planar non-door edge to an outdoor cell)
  const R = new Int32Array(N).fill(-1); const blds = []; const rej = { small: 0, open: 0, large: 0, open_cells: 0 };
  comps.forEach((c) => {
    let perim = 0, open = 0, roofed = 0, doorExit = 0;
    for (const a of c) {
      roofed += cand[a] === 1 ? 1 : 0; let isP = false, isO = false;
      let m = 0; for (let j = P[a]; j < P[a + 1]; j++) { const v = NB[j]; if (ctx.DIR[j] < 4 && cand[v]) m |= 1 << ctx.DIR[j]; if (!cand[v]) { if (DE[j]) doorExit++; else isO = true; } }
      if (m !== 0x0f) isP = true; perim += isP ? 1 : 0; open += isO ? 1 : 0;
    }
    const openness = perim ? open / perim : 0;
    if (c.length < o.bldMinCells) { rej.small++; return; }
    if (c.length > o.bldMaxCells) { rej.large++; return; }
    if (openness > o.bldMaxOpen) { rej.open++; rej.open_cells += c.length; return; }
    const id = blds.length; for (const a of c) R[a] = id;
    blds.push({ id, cells: c, perim, open, openness, roofed, doorExit });
  });
  st.candidates = comps.length; st.rejected = rej; st.buildings = blds.length;
  st.building_cells = blds.reduce((s, b) => s + b.cells.length, 0);
  return { R, blds, stats: st, cand };
}

// ---- plaza regions on the outdoor graph ----
function detectPlazas(ctx, o) {
  const { N, P, NB, DIR, d, keep } = ctx; const core = new Int32Array(N).fill(-1); const list = []; const rej = { small: 0, elongated: 0 };
  for (let u = 0; u < N; u++) {
    if (!keep[u] || !(d[u] >= o.plazaD) || core[u] !== -1) continue;
    const c = bfsComp(u, core, -2, (a, f) => { for (let j = P[a]; j < P[a + 1]; j++) if (d[NB[j]] >= o.plazaD) f(NB[j]); });
    let dm = 0; for (const a of c) if (d[a] < Infinity && d[a] > dm) dm = d[a];
    const t = Math.max(0.5, dm - o.plazaD + 0.5), elong = c.length / (Math.PI * t * t);
    if (c.length < o.plazaMin) { rej.small++; for (const a of c) core[a] = -3; continue; }
    if (elong > o.plazaElong) { rej.elongated++; for (const a of c) core[a] = -3; continue; }
    const id = list.length; for (const a of c) core[a] = id; list.push({ id, core: c.length, dmax: dm, elong });
  }
  // grow each core back to the open area: budget(v) = max over core c of d[c] - dist(c, v); keep cells with budget >= 1.5
  const bud = new Float32Array(N).fill(-Infinity), pid = new Int32Array(N).fill(-1); const h = new SK.Heap();
  for (let u = 0; u < N; u++) if (core[u] >= 0) { bud[u] = Math.min(d[u], 40); pid[u] = core[u]; h.push(-bud[u], u); }
  while (h.size) {
    const u = h.pop(), bu = -h.topKey; if (bu < bud[u]) continue;
    for (let j = P[u]; j < P[u + 1]; j++) { const v = NB[j]; const nb = bu - (DIR[j] < 4 ? 1 : SQ2); if (nb >= 1.5 && nb > bud[v]) { bud[v] = nb; pid[v] = pid[u]; h.push(-nb, v); } }
  }
  const cells = list.map(() => []); for (let u = 0; u < N; u++) if (pid[u] >= 0) cells[pid[u]].push(u);
  list.forEach((p, i) => { p.cells = cells[i]; });
  return { pid, list, rejected: rej };
}
const SQ2 = Math.SQRT2;

// ---- the v2 pipeline ----
function runV2(dataDir, box, userOpts = {}) {
  const opts = Object.assign({}, SK.DEFAULTS, V2, userOpts);
  const T = {}; let t = Date.now(); const lap = (k) => { const n = Date.now(); T[k] = n - t; t = n; };
  const stats = {};
  const ctx = SK.loadBox(dataDir, box, opts); lap('load_ms'); stats.cells = ctx.N; stats.regions = ctx.regions;
  if (opts.reach) { stats.reach = SK.reachFilter(ctx, opts.seeds, (s) => SK.nearestLocal(ctx, s)); lap('reach_ms'); }
  stats.planar_full = SK.buildPlanar(ctx, opts); lap('planar_full_ms');
  const W = new World(opts.world);
  const rs = roofScan(ctx, W, opts); stats.world = Object.assign({}, W.stats); lap('roof_scan_ms');
  stats.floor_check = floorCheck(ctx, W); lap('floor_check_ms');
  let roofCells = 0, kept = 0; for (let u = 0; u < ctx.N; u++) if (ctx.keep[u]) { kept++; roofCells += rs.roof[u]; }
  stats.roof = { kept_cells: kept, roofed_cells: roofCells };
  const full = { P: ctx.P, NB: ctx.NB, DIR: ctx.DIR, DE: ctx.DE, keep: Uint8Array.from(ctx.keep) };
  SK.clearance(ctx, opts); const dFull = ctx.d; lap('clearance_full_ms');
  const B = detectBuildings(ctx, rs, opts); stats.buildings = B.stats; lap('buildings_ms');
  let can = 0; for (let u = 0; u < ctx.N; u++) if (ctx.keep[u]) can += rs.canopy[u]; stats.roof.canopy_cells = can;
  if (opts.hookPreGroves) stats.hook_pre_groves = opts.hookPreGroves(ctx, rs, B, opts); // v3: e.g. walkable canopy tops count as canopy
  stats.groves = opts.groves === false ? null : detectGroves(ctx, rs, B, opts); lap('groves_ms');
  if (opts.hookRegions) { stats.hook_regions = opts.hookRegions(ctx, rs, B, dFull, full, opts); lap('hook_regions_ms'); } // v3: grove absorption / merge / split
  // outdoor graph: building cells removed
  for (let u = 0; u < ctx.N; u++) if (B.R[u] >= 0) ctx.keep[u] = 0;
  stats.planar = SK.buildPlanar(ctx, opts);
  stats.clearance = SK.clearance(ctx, opts);
  const th = SK.thin(ctx, opts); const S = th.S; stats.thin = th.stats; lap('outdoor_thin_ms');
  stats.small_components = SK.dropSmallComponents(ctx, S, opts.minComp);
  stats.prune = SK.prune(ctx, S, opts);
  if (opts.cycles) { stats.cycles = SK.breakCycles(ctx, S, opts); stats.prune2 = SK.prune(ctx, S, opts); }
  stats.small_components_after_prune = SK.dropSmallComponents(ctx, S, opts.minComp); lap('outdoor_prune_ms');
  // plazas
  const PZ = opts.plaza ? detectPlazas(ctx, opts) : { pid: new Int32Array(ctx.N).fill(-1), list: [], rejected: {} };
  let cut = 0; for (let u = 0; u < ctx.N; u++) if (S[u] && PZ.pid[u] >= 0) { S[u] = 0; cut++; }
  stats.plazas = { plazas: PZ.list.length, rejected: PZ.rejected, plaza_cells: PZ.list.reduce((s, p) => s + p.cells.length, 0), skeleton_cells_removed: cut };
  lap('plaza_ms');
  if (opts.hookPlazas) { stats.hook_plazas = opts.hookPlazas(ctx, B, PZ, dFull, full, opts); lap('hook_plazas_ms'); } // v3: plaza split
  // region ids: buildings 0..nb-1, plazas nb..
  const nb = B.blds.length; const REG = new Int32Array(ctx.N).fill(-1);
  for (let u = 0; u < ctx.N; u++) { if (B.R[u] >= 0) REG[u] = B.R[u]; else if (PZ.pid[u] >= 0) REG[u] = nb + PZ.pid[u]; }
  const regions = B.blds.map((b) => ({ kind: b.kind || 'building', cells: b.cells, info: b, exits: [] })).concat(PZ.list.map((p) => ({ kind: 'plaza', cells: p.cells, info: p, exits: [] })));
  // exits. building: outdoor cells reached by a full-graph planar edge (door edges included) from building cells.
  // plaza: skeleton cells outside the plaza that touch plaza cells.
  const extra = []; const linkReg = []; // [cell, region]
  const exitClusters = (cells, isExit) => { // cluster exit cells by full-graph adjacency
    const m = new Map(); for (const c of cells) m.set(c, -1); const out = [];
    for (const c of cells) { if (m.get(c) !== -1) continue; const q = [c]; m.set(c, out.length); for (let i = 0; i < q.length; i++) { const a = q[i]; for (let j = full.P[a]; j < full.P[a + 1]; j++) { const v = full.NB[j]; if (m.get(v) === -1) { m.set(v, out.length); q.push(v); } } } out.push(q); }
    return out;
  };
  regions.forEach((rg, ri) => {
    const ex = new Map(); // outdoor cell -> isDoor
    if (rg.kind !== 'plaza') {
      for (const a of rg.cells) for (let j = full.P[a]; j < full.P[a + 1]; j++) { const v = full.NB[j]; if (REG[v] === ri || B.R[v] >= 0 || !full.keep[v]) continue; ex.set(v, (ex.get(v) || 0) | (full.DE[j] || ((ctx.T[a] | ctx.T[v]) & 16) ? 1 : 0)); }
    } else {
      for (const a of rg.cells) for (let j = ctx.P[a]; j < ctx.P[a + 1]; j++) { const v = ctx.NB[j]; if (S[v] && REG[v] < 0) ex.set(v, 0); }
    }
    for (const cl of exitClusters([...ex.keys()])) {
      let best = cl[0]; for (const c of cl) if ((ex.get(c) & 1) > (ex.get(best) & 1) || ((ex.get(c) & 1) === (ex.get(best) & 1) && ctx.d[c] > ctx.d[best])) best = c;
      const door = cl.some((c) => ex.get(c) & 1);
      const into = REG[best]; // building exit that opens straight into a plaza
      const rec = { cell: best, door, width: cl.length, to_region: into >= 0 ? into : null };
      rg.exits.push(rec);
      if (into < 0) { extra.push([best, rg.kind === 'plaza' ? 'plaza_exit' : door ? rg.kind + '_door' : rg.kind + '_exit']); linkReg.push([best, ri]); }
    }
  });
  lap('exits_ms');
  // forced nodes (teleport/ladder/door outdoors + exits), linked to the outdoor skeleton; the link BFS stays out of regions
  const blockReg = new Uint8Array(ctx.N); for (let u = 0; u < ctx.N; u++) if (REG[u] >= 0) blockReg[u] = 1;
  ctx.keep = full.keep.slice(); for (let u = 0; u < ctx.N; u++) if (B.R[u] >= 0) ctx.keep[u] = 0; // outdoor keep (plaza cells stay but are blocked)
  const fo = SK.forcedNodes(ctx, S, extra, blockReg); stats.forced = fo.stats; lap('forced_ms');
  const g = SK.buildGraph(ctx, S, fo.forced, opts); lap('graph_ms');
  const out = assemble(ctx, S, g, fo, regions, linkReg, REG, B, full, opts, stats); lap('assemble_ms');
  stats.timing_ms = T;
  return { ctx, S, g, fo, out, opts, stats, regions, REG, rs, B, PZ, dFull, full };
}

// v3: internal cell indices as non-enumerable fields (not written to JSON)
const hid = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: false, writable: true });
function assemble(ctx, S, g, fo, regions, linkReg, REG, B, full, opts, stats) {
  const { box, X, Z, F } = ctx; const cp = (c) => SK.cellPos(ctx, c);
  const inBox = (c) => X[c] >= box.x0 && X[c] <= box.x1 && Z[c] >= box.z0 && Z[c] <= box.z1;
  // nodes: skeleton graph nodes, then region nodes
  const nodes = g.nodes.map((n) => {
    const tags = new Set(); for (const c of n.cells) if (fo.tags.has(c)) for (const tg of fo.tags.get(c)) tags.add(tg);
    return { kind: 'sk', tags, rep: n.rep, radius: n.radius, cells: n.cells.length };
  });
  const rnode = regions.map((rg, ri) => {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9, y0 = 1e9, y1 = -1e9, sx = 0, sz = 0, inb = 0;
    for (const c of rg.cells) { x0 = Math.min(x0, X[c]); x1 = Math.max(x1, X[c]); z0 = Math.min(z0, Z[c]); z1 = Math.max(z1, Z[c]); y0 = Math.min(y0, F[c] / 16); y1 = Math.max(y1, F[c] / 16); sx += X[c]; sz += Z[c]; if (inBox(c)) inb++; }
    // representative: cell nearest to the centroid (buildings) / max clearance (plazas)
    let rep = rg.cells[0]; const cx = sx / rg.cells.length, cz = sz / rg.cells.length;
    if (rg.kind === 'plaza') { for (const c of rg.cells) if (ctx.d[c] > ctx.d[rep] && ctx.d[c] < Infinity) rep = c; }
    else { let bd = Infinity; for (const c of rg.cells) { const q = (X[c] - cx) ** 2 + (Z[c] - cz) ** 2; if (q < bd) { bd = q; rep = c; } } }
    nodes.push({ kind: rg.kind, tags: new Set(), rep, region: ri, bbox: [x0, y0, z0, x1, y1, z1], inBox: inb });
    return nodes.length - 1;
  });
  // edges: roads, region links, special
  let R0 = g.edges.map((e) => ({ a: e.a, b: e.b, kind: 'road', cells: e.cells, length: e.length, width_min: e.width_min }));
  const exitNode = new Map();
  for (const [c, ri] of linkReg) {
    const gi = g.cluster[c]; if (gi < 0) continue; // exit not linked to any skeleton (isolated)
    exitNode.set(c, gi);
    R0.push({ a: rnode[ri], b: gi, kind: 'region_link', cells: [c], length: 0, width_min: 0 });
  }
  // fold pure exit nodes into their region node: the road from the exit to the skeleton starts at the region node
  const EXIT_TAG = /^(building|grove)_(exit|door)$|^plaza_exit$|^door$|^gate$/;
  const redir = new Int32Array(nodes.length).map((_, i) => i); let folded = 0;
  for (const [c, ri] of linkReg) {
    const gi = g.cluster[c]; if (gi < 0 || redir[gi] !== gi) continue;
    if (![...nodes[gi].tags].every((t) => EXIT_TAG.test(t))) continue;
    redir[gi] = rnode[ri]; nodes[gi].kind = 'folded'; folded++;
  }
  for (const e of R0) { e.a = redir[e.a]; e.b = redir[e.b]; }
  R0 = R0.filter((e) => !(e.kind === 'region_link' && e.a === e.b));
  for (const [c, gi] of exitNode) exitNode.set(c, redir[gi]);
  stats.exits_folded = folded;
  regions.forEach((rg, ri) => { for (const ex of rg.exits) if (ex.to_region != null) R0.push({ a: rnode[ri], b: rnode[ex.to_region], kind: 'region_link', cells: [ex.cell], length: 0, width_min: 0 }); });
  const nodeOf = (c) => (c < 0 ? -1 : REG[c] >= 0 ? rnode[REG[c]] : g.cluster[c] >= 0 ? redir[g.cluster[c]] : -1);
  const SP = [];
  for (const s of fo.special) {
    const a = nodeOf(s.u), b = s.v >= 0 ? nodeOf(s.v) : null; if (a < 0) continue;
    const rec = { a, b: b < 0 ? null : b, kind: s.kind, u: s.u, v: s.v };
    if (s.kind === 'teleport') rec.dst_gid = s.dst_gid;
    if (s.kind === 'ladder') { rec.length = Math.abs(F[s.u] - F[s.v]) / 16; rec.ladder_cells = s.cells; }
    SP.push(rec);
  }
  // teleport / ladder / door edges whose source is inside a region (forcedNodes only saw outdoor cells): add from the raw specials
  const seenSp = new Set(); let spIn = 0;
  for (const [u, dg, t] of ctx.special) {
    if (!full.keep[u] || REG[u] < 0) continue; if (!(t === SK.ET.teleport || t === SK.ET.ladder_climb || t === SK.ET.ladder_exit)) continue;
    const v = ctx.lookup(dg); const a = rnode[REG[u]]; let b = null;
    if (v >= 0 && full.keep[v]) b = nodeOf(v) >= 0 ? nodeOf(v) : null;
    if (t !== SK.ET.teleport && (b === a || b == null)) continue;
    const key = a + ':' + b + ':' + t; if (seenSp.has(key)) continue; seenSp.add(key);
    SP.push({ a, b, kind: t === SK.ET.teleport ? 'teleport' : 'ladder', u, v, dst_gid: t === SK.ET.teleport ? dg : undefined }); spIn++;
  }
  stats.special_from_regions = spIn;
  // ---- re-merge degree-2 nodes and re-prune spurs on the node graph, until stable ----
  const protectedNode = (i) => nodes[i].kind !== 'sk' || nodes[i].tags.size > 0;
  const stp = (p, q) => Math.sqrt((X[p] - X[q]) ** 2 + (Z[p] - Z[q]) ** 2 + ((F[p] - F[q]) / 16) ** 2);
  const pst = { merged: 0, spurs: 0, rounds: 0 };
  const spDeg = new Int32Array(nodes.length); for (const s of SP) { spDeg[s.a]++; if (s.b != null) spDeg[s.b]++; }
  for (let round = 0; round < 20; round++) {
    let changed = 0; const dead = new Uint8Array(R0.length);
    const inc = nodes.map(() => []); R0.forEach((e, i) => { inc[e.a].push(i); if (e.b !== e.a) inc[e.b].push(i); });
    // prune: untagged sk end node (deg 1, no special edge) on a road shorter than spurLen whose other end has deg >= 3
    for (let n = 0; n < nodes.length; n++) {
      if (protectedNode(n) || spDeg[n] || inc[n].length !== 1) continue; const e = R0[inc[n][0]]; if (dead[inc[n][0]] || e.kind !== 'road') continue;
      const o = e.a === n ? e.b : e.a; if (inc[o].filter((k) => !dead[k]).length < 3) continue;
      if (e.length >= Math.max(opts.spurLen, opts.pK * (nodes[o].radius || 0))) continue;
      dead[inc[n][0]] = 1; nodes[n].kind = 'pruned'; changed++; pst.spurs++;
    }
    const keepE = []; R0.forEach((e, i) => { if (!dead[i]) keepE.push(e); }); R0 = keepE;
    // merge: untagged sk node with exactly two road edges
    const inc2 = nodes.map(() => []); R0.forEach((e, i) => { inc2[e.a].push(i); if (e.b !== e.a) inc2[e.b].push(i); });
    const dead2 = new Uint8Array(R0.length + nodes.length);
    for (let n = 0; n < nodes.length; n++) {
      if (nodes[n].kind !== 'sk' || protectedNode(n) || spDeg[n]) continue;
      const live = inc2[n].filter((i) => !dead2[i]); if (live.length !== 2) continue;
      const [i, j] = live; const e1 = R0[i], e2 = R0[j]; if (e1.kind !== 'road' || e2.kind !== 'road' || e1.a === e1.b || e2.a === e2.b) continue;
      const c1 = e1.b === n ? e1.cells : e1.cells.slice().reverse(); const o1 = e1.b === n ? e1.a : e1.b;
      const c2 = e2.a === n ? e2.cells : e2.cells.slice().reverse(); const o2 = e2.a === n ? e2.b : e2.a;
      const same = c1[c1.length - 1] === c2[0];
      const ne = { a: o1, b: o2, kind: 'road', cells: c1.concat(same ? c2.slice(1) : c2), length: e1.length + e2.length + (same ? 0 : stp(c1[c1.length - 1], c2[0])), width_min: Math.min(e1.width_min, e2.width_min) };
      dead2[i] = dead2[j] = 1; R0.push(ne); const k = R0.length - 1;
      inc2[o1] = inc2[o1].filter((x) => x !== i && x !== j).concat([k]); if (o2 !== o1) inc2[o2] = inc2[o2].filter((x) => x !== i && x !== j).concat([k]);
      inc2[n] = []; nodes[n].kind = 'merged'; changed++; pst.merged++;
    }
    R0 = R0.filter((e, i) => !dead2[i]);
    // drop short self loops
    R0 = R0.filter((e) => !(e.kind === 'road' && e.a === e.b && e.length < opts.selfLoopMin));
    pst.rounds = round + 1; if (!changed) break;
  }
  stats.final_prune_merge = pst;
  // ---- output (keep edges touching the box, regions with cells in the box) ----
  const E = [];
  for (const e of R0) {
    if (e.kind === 'road') {
      if (!e.cells.some(inBox)) continue;
      const pl = []; for (let i = 0; i < e.cells.length; i += opts.polyStep) pl.push(cp(e.cells[i]));
      if ((e.cells.length - 1) % opts.polyStep) pl.push(cp(e.cells[e.cells.length - 1]));
      E.push({ a: e.a, b: e.b, kind: 'road', length: +e.length.toFixed(2), width_min: +e.width_min.toFixed(2), cells: e.cells.length, polyline: pl, _cells: e.cells });
    } else if (inBox(e.cells[0])) E.push(hid({ a: e.a, b: e.b, kind: 'region_link', at: cp(e.cells[0]), length: 0 }, '_cell', e.cells[0]));
  }
  for (const s of SP) if (s.u >= 0 && inBox(s.u)) { const r = Object.assign({}, s); delete r.u; delete r.v; r.at = cp(s.u); if (s.v >= 0) r.to = cp(s.v); hid(r, '_u', s.u); hid(r, '_v', s.v); E.push(r); } // v3: special endpoints (at / to) kept
  // final degrees (roads + region links) decide junction/end
  const used = new Set(); for (const e of E) { used.add(e.a); if (e.b != null) used.add(e.b); }
  const isReg = (k) => k === 'building' || k === 'plaza' || k === 'grove';
  nodes.forEach((n, i) => { if (isReg(n.kind) && n.inBox) used.add(i); });
  const order = [...used].sort((a, b) => a - b); const nid = new Map(order.map((o, i) => [o, i]));
  const deg = new Int32Array(nodes.length); for (const e of E) if (e.kind === 'road' || e.kind === 'region_link') { deg[e.a]++; if (e.b != null) deg[e.b]++; }
  const outNodes = order.map((o, i) => {
    const n = nodes[o]; const tags = [...n.tags];
    if (isReg(n.kind)) {
      const rg = regions[n.region];
      const exits = rg.exits.map((x) => ({ pos: cp(x.cell), door: x.door, width: x.width, node: x.to_region != null ? (nid.has(rnode[x.to_region]) ? nid.get(rnode[x.to_region]) : null) : (exitNode.has(x.cell) && nid.has(exitNode.get(x.cell)) ? nid.get(exitNode.get(x.cell)) : null) }));
      exits.sort((p, q) => (q.door - p.door));
      const r = { id: i, kind: n.kind, pos: cp(n.rep), cells: rg.cells.length, bbox: n.bbox, deg: deg[o], exits, region: n.region };
      if (n.kind === 'building') Object.assign(r, { roofed_cells: rg.info.roofed, openness: +rg.info.openness.toFixed(3) });
      else if (n.kind === 'grove') r.canopy_cells = rg.info.canopy;
      else Object.assign(r, { core_cells: rg.info.core, dmax: +rg.info.dmax.toFixed(2), elong: +rg.info.elong.toFixed(2) });
      r.cell_list = rg.cells.map((c) => [X[c], +(F[c] / 16).toFixed(3), Z[c]]);
      return hid(r, '_rep', n.rep);
    }
    let kind = deg[o] >= 3 ? 'junction' : deg[o] === 1 ? 'end' : deg[o] === 0 ? 'isolated' : 'pass';
    if (tags.length && kind !== 'junction') kind = 'forced';
    return hid({ id: i, kind, tags, pos: cp(n.rep), radius: +n.radius.toFixed(2), cells: n.cells, deg: deg[o] }, '_rep', n.rep);
  });
  for (const e of E) { e.a = nid.get(e.a); if (e.b != null) e.b = nid.get(e.b); }
  const byKind = {}; for (const n of outNodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
  const ek = {}; for (const e of E) ek[e.kind] = (ek[e.kind] || 0) + 1;
  // stats restricted to the box, comparable to v1 (v1 counts every output node)
  stats.graph = { nodes: outNodes.length, nodes_by_kind: byKind, edges: E.length, edges_by_kind: ek,
    road_length_total: +E.filter((e) => e.kind === 'road').reduce((s, e) => s + e.length, 0).toFixed(1),
    buildings_in_box: outNodes.filter((n) => n.kind === 'building').length, plazas_in_box: outNodes.filter((n) => n.kind === 'plaza').length, groves_in_box: outNodes.filter((n) => n.kind === 'grove').length };
  return { nodes: outNodes, edges: E };
}

// ---- PNG: clearance background, building / plaza overlays, skeleton, nodes ----
function renderV2(res, scale = 3) {
  const { ctx, S, out, REG, regions, full } = res; const { box, N, X, Z, F, T } = ctx; const d = res.dFull;
  const W = box.x1 - box.x0 + 1, H = box.z1 - box.z0 + 1, w = W * scale, h = H * scale;
  const top = new Int32Array(W * H).fill(-1);
  for (let u = 0; u < N; u++) {
    if (!full.keep[u]) continue; const x = X[u] - box.x0, z = Z[u] - box.z0; if (x < 0 || z < 0 || x >= W || z >= H) continue;
    const k = z * W + x; if (top[k] < 0 || F[u] > F[top[k]]) top[k] = u;
  }
  // region colour per column: any cell of the column in a region (building wins over plaza)
  const colReg = new Int32Array(W * H).fill(-1);
  for (let u = 0; u < N; u++) {
    if (REG[u] < 0) continue; const x = X[u] - box.x0, z = Z[u] - box.z0; if (x < 0 || z < 0 || x >= W || z >= H) continue;
    const k = z * W + x; const r = REG[u]; if (colReg[k] < 0 || (regions[r].kind !== 'plaza' && regions[colReg[k]].kind === 'plaza')) colReg[k] = r;
  }
  const skTop = new Uint8Array(W * H);
  for (let u = 0; u < N; u++) { if (!S[u]) continue; const x = X[u] - box.x0, z = Z[u] - box.z0; if (x < 0 || z < 0 || x >= W || z >= H) continue; const k = z * W + x; if (top[k] === u) skTop[k] = 1; else if (!skTop[k]) skTop[k] = 2; }
  const img = Buffer.alloc(w * h * 3);
  const put = (px, py, c) => { if (px < 0 || py < 0 || px >= w || py >= h) return; const o = (py * w + px) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; };
  const lerp = (a, b, s) => a.map((v, i) => Math.round(v + (b[i] - v) * s));
  const hue = (i) => { const hh = (i * 0.618034) % 1, s = 0.75, v = 1; const k = (n) => (n + hh * 6) % 6; const f = (n) => v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1)); return [f(5), f(3), f(1)].map((q) => Math.round(q * 255)); };
  const PLAZA = [255, 150, 0], GROVE = [0, 200, 60];
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const k = z * W + x, u = top[k]; let c;
    if (u < 0) c = [28, 28, 32];
    else { const s = Math.min(1, (Math.min(d[u], 8) - 0.5) / 7.5); c = (T[u] & 6) ? lerp([15, 30, 90], [120, 170, 250], s) : lerp([45, 60, 45], [150, 160, 140], s); }
    const r = colReg[k];
    if (r >= 0) { const kd = regions[r].kind; const rc = kd === 'building' ? hue(r) : kd === 'grove' ? GROVE : PLAZA; c = lerp(c, rc, kd === 'building' ? 0.55 : 0.45); }
    if (skTop[k] === 1) c = [235, 20, 20]; else if (skTop[k] === 2) c = [160, 0, 140];
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(x * scale + dx, z * scale + dy, c);
  }
  // region links: thin white line from exit to region marker
  const line = (x0, z0, x1, z1, c) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0)) | 0; for (let i = 0; i <= n; i++) { const t = n ? i / n : 0; put(Math.round(x0 + (x1 - x0) * t), Math.round(z0 + (z1 - z0) * t), c); } };
  const px = (p) => [(p[0] - box.x0) * scale + (scale >> 1), (p[2] - box.z0) * scale + (scale >> 1)];
  for (const e of out.edges) if (e.kind === 'region_link') { const a = out.nodes[e.a], b = out.nodes[e.b]; const pa = px(a.pos), pb = px(b.pos); line(pa[0], pa[1], pb[0], pb[1], [255, 255, 255]); }
  const COL = { junction: [255, 230, 0], end: [40, 110, 255], forced: [0, 240, 240], isolated: [40, 110, 255], pass: [255, 230, 0] };
  for (const n of out.nodes) {
    const [cx, cz] = px(n.pos);
    if (n.kind === 'building' || n.kind === 'plaza' || n.kind === 'grove') {
      const r = 2 * scale; const c = n.kind === 'building' ? [255, 255, 255] : n.kind === 'grove' ? [0, 255, 80] : [255, 120, 0];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) >= r - 1) put(cx + dx, cz + dy, c);
      for (const ex of n.exits) { const [ex0, ez0] = px(ex.pos); const c2 = ex.door ? [0, 255, 120] : [255, 255, 255]; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(ex0 + dx, ez0 + dy, c2); }
      continue;
    }
    const c = COL[n.kind]; if (!c) continue; const r = scale;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 1) put(cx + dx, cz + dy, c);
  }
  return { png: SK.encodePNG(w, h, img), w, h };
}

module.exports = { V2, NOT_ROOF, CANOPY, detectGroves, roofScan, floorCheck, detectBuildings, detectPlazas, runV2, renderV2 };
