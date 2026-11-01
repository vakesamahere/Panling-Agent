'use strict';
// Skeletonization of the PFG3 walkability graph (2.5D) -> L1 road network (nodes + edges).
// Everything follows graph edges only; no adjacency is inferred from coordinates.
// Pure Node, no dependencies. See README.md for the algorithm.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ETN = ['walk', 'jump', 'drop', 'swim', 'water_enter', 'water_exit', 'ladder_climb', 'ladder_exit', 'teleport', 'door_open', 'gate_open'];
const ET = Object.fromEntries(ETN.map((n, i) => [n, i]));
const T_TRAP = 64, T_WATER = 2 | 4;
const SQ2 = Math.SQRT2;
// direction codes: 0..3 cardinal (E W S N), 4..7 diagonal
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const DCODE = new Int8Array(9).fill(-1);
DIRS.forEach(([dx, dz], k) => { DCODE[(dx + 1) * 3 + (dz + 1)] = k; });

const DEFAULTS = {
  pad: 24,            // load this many extra blocks around the box so the box edge is not a fake wall
  planarTypes: ['walk', 'jump', 'drop', 'swim', 'door_open', 'gate_open'],
  borderDiag: false,  // boundary cell = missing one of 4 cardinal (false) or one of 8 (true) directions
  endpoint: 'anchor', // 'deg': never delete a cell with <=1 skeleton neighbour; 'anchor': delete it unless d is a local max
  pruneRule: 'junction', // spur threshold uses radius of the junction ('junction') or of the end ('end')
  pMin: 4,            // spur shorter than max(pMin, pK*r) is pruned
  pK: 2,
  minComp: 10,        // drop skeleton components with fewer cells (roofs, closets)
  selfLoopMin: 8,     // drop self loops shorter than this
  plazaD: 6,          // cells with d >= plazaD form plazas
  plazaMin: 40,       // plaza component must have at least this many cells
  plaza: true,
  corners: true,      // allow neighbour connectivity through corner cells in the simple-point test
  polyStep: 4,
  reach: true,        // keep only cells strongly connected with seeds (or the largest SCC)
  seeds: null,        // [[x,y,z], ...]
  cycles: true,       // break short cycles around small obstacles
  cycleMin: 16,       // cycle shorter than max(cycleMin, cycleK*r) is broken
  cycleK: 4,
  oneway: false,      // experiment: also use one-way planar edges (drop-only terraces) as undirected adjacency
};

// ---------- loading ----------
function readRegionFile(dir, R) {
  let p = path.join(dir, R.file), buf;
  if (fs.existsSync(p)) buf = fs.readFileSync(p);
  else if (fs.existsSync(p + '.gz')) buf = zlib.gunzipSync(fs.readFileSync(p + '.gz'));
  else return null;
  if (buf.toString('latin1', 0, 4) !== 'PFG3') throw new Error('bad magic ' + p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const h = new Uint32Array(ab, 4, 7); const n = h[1], m = h[2], off = h[3];
  let o = 32; const pad = (b) => (b + 3) & ~3;
  const x = new Int16Array(ab, o, n); o += pad(2 * n);
  const z = new Int16Array(ab, o, n); o += pad(2 * n);
  const f = new Int16Array(ab, o, n); o += pad(2 * n);
  const fb = new Uint16Array(ab, o, n); o += pad(2 * n); // block under the feet: id<<4 | meta
  o += pad(n);     // y (block y; f/16 is the floor height)
  const t = new Uint8Array(ab, o, n); o += pad(n);
  const ptr = new Uint32Array(ab, o, n + 1); o += 4 * (n + 1);
  const dst = new Int32Array(ab, o, m); o += 4 * m;
  o += 4 * m;      // cost
  const et = new Uint8Array(ab, o, m);
  return { R, n, m, off, x, z, f, fb, t, ptr, dst, et };
}

// box = {x0,z0,x1,z1} inclusive. Loads every region touching box+pad, keeps non-trap cells inside box+pad.
function loadBox(dataDir, box, opts = {}) {
  const pad = opts.pad != null ? opts.pad : DEFAULTS.pad;
  const idx = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
  const L = { x0: box.x0 - pad, z0: box.z0 - pad, x1: box.x1 + pad, z1: box.z1 + pad };
  const rx0 = Math.floor(L.x0 / 512), rx1 = Math.floor(L.x1 / 512), rz0 = Math.floor(L.z0 / 512), rz1 = Math.floor(L.z1 / 512);
  const regs = [];
  for (const R of idx.regions) {
    if (R.rx < rx0 || R.rx > rx1 || R.rz < rz0 || R.rz > rz1 || !R.n_cells) continue;
    const r = readRegionFile(dataDir, R); if (r) regs.push(r);
  }
  regs.sort((a, b) => a.off - b.off);
  let N = 0;
  for (const r of regs) {
    r.map = new Int32Array(r.n).fill(-1);
    for (let k = 0; k < r.n; k++) {
      const x = r.x[k], z = r.z[k];
      if (x < L.x0 || x > L.x1 || z < L.z0 || z > L.z1 || (r.t[k] & T_TRAP)) continue;
      r.map[k] = N++;
    }
  }
  const X = new Int16Array(N), Z = new Int16Array(N), F = new Int16Array(N), FB = new Uint16Array(N), T = new Uint8Array(N), GID = new Int32Array(N), RI = new Uint8Array(N), RK = new Int32Array(N);
  regs.forEach((r, ri) => {
    for (let k = 0; k < r.n; k++) {
      const u = r.map[k]; if (u < 0) continue;
      X[u] = r.x[k]; Z[u] = r.z[k]; F[u] = r.f[k]; FB[u] = r.fb[k]; T[u] = r.t[k]; GID[u] = r.off + k; RI[u] = ri; RK[u] = k;
    }
  });
  const lookup = (gid) => {
    for (const r of regs) if (gid >= r.off && gid < r.off + r.n) return r.map[gid - r.off];
    return -1;
  };
  const keep = new Uint8Array(N).fill(1);
  return { idx, regs, box, L, N, X, Z, F, FB, T, GID, RI, RK, lookup, keep, regions: regs.map((r) => r.R.name) };
}

// ---------- step 0: keep only cells mutually reachable with the seeds (all edge types, local graph) ----------
// Rooftops, wall tops and closed yards that you cannot walk to (or back from) are dropped. Without seeds the
// largest strongly connected component is kept.
function reachFilter(ctx, seeds, nearest) {
  const { N, regs, RI, RK, lookup } = ctx;
  const fp = new Int32Array(N + 1); const fd = [];
  for (let u = 0; u < N; u++) {
    const r = regs[RI[u]], k = RK[u];
    for (let e = r.ptr[k]; e < r.ptr[k + 1]; e++) { const v = lookup(r.dst[e]); if (v >= 0) fd.push(v); }
    fp[u + 1] = fd.length;
  }
  const FD = Int32Array.from(fd); const rp = new Int32Array(N + 1);
  for (let j = 0; j < FD.length; j++) rp[FD[j] + 1]++;
  for (let u = 0; u < N; u++) rp[u + 1] += rp[u];
  const RD = new Int32Array(FD.length); const fill = rp.slice(0, N);
  for (let u = 0; u < N; u++) for (let j = fp[u]; j < fp[u + 1]; j++) RD[fill[FD[j]]++] = u;
  const bfs = (src, p, a, mark) => { const q = src.slice(); for (const s of q) mark[s] = 1; for (let i = 0; i < q.length; i++) { const u = q[i]; for (let j = p[u]; j < p[u + 1]; j++) { const v = a[j]; if (!mark[v]) { mark[v] = 1; q.push(v); } } } };
  const keep = new Uint8Array(N); const info = { seeds: [] };
  if (seeds && seeds.length) {
    const src = [];
    for (const s of seeds) { const u = nearest(s); info.seeds.push({ at: s, cell: u >= 0 ? [ctx.X[u], ctx.F[u] / 16, ctx.Z[u]] : null }); if (u >= 0) src.push(u); }
    // union of the SCCs of all seeds: cells reachable from some seed and reaching some seed
    const fw = new Uint8Array(N), bw = new Uint8Array(N); bfs(src, fp, FD, fw); bfs(src, rp, RD, bw);
    for (let u = 0; u < N; u++) keep[u] = fw[u] & bw[u];
  } else { // largest SCC via iterative Kosaraju
    const order = []; const seen = new Uint8Array(N); const st = new Int32Array(N), it = new Int32Array(N);
    for (let s = 0; s < N; s++) {
      if (seen[s]) continue; let sp = 0; st[sp] = s; it[sp] = fp[s]; seen[s] = 1;
      while (sp >= 0) { const u = st[sp]; if (it[sp] < fp[u + 1]) { const v = FD[it[sp]++]; if (!seen[v]) { seen[v] = 1; sp++; st[sp] = v; it[sp] = fp[v]; } } else { order.push(u); sp--; } }
    }
    const comp = new Int32Array(N).fill(-1); let best = -1, bestN = 0, nc = 0;
    for (let i = order.length - 1; i >= 0; i--) {
      const s = order[i]; if (comp[s] >= 0) continue; const q = [s]; comp[s] = nc;
      for (let k = 0; k < q.length; k++) { const u = q[k]; for (let j = rp[u]; j < rp[u + 1]; j++) { const v = RD[j]; if (comp[v] < 0) { comp[v] = nc; q.push(v); } } }
      if (q.length > bestN) { bestN = q.length; best = nc; } nc++;
    }
    for (let u = 0; u < N; u++) keep[u] = comp[u] === best ? 1 : 0;
    info.scc_count = nc;
  }
  let k = 0; for (let u = 0; u < N; u++) k += keep[u];
  ctx.keep = keep; info.kept = k; info.dropped = N - k;
  return info;
}

function nearestLocal(ctx, [x, y, z]) {
  let best = -1, bd = Infinity;
  for (let u = 0; u < ctx.N; u++) { const dd = (ctx.X[u] - x) ** 2 + (ctx.Z[u] - z) ** 2; if (dd > 9) continue; const q = dd + (ctx.F[u] / 16 - y) ** 2; if (q < bd) { bd = q; best = u; } }
  return best;
}

// ---------- step 1: planar adjacency ----------
function buildPlanar(ctx, opts) {
  const { N, X, Z, GID, RI, RK, regs, lookup } = ctx;
  const PL = new Uint8Array(16); for (const n of opts.planarTypes) PL[ET[n]] = 1;
  const ptr = new Int32Array(N + 1), nb = [], dir = [], de = []; // de: 1 if the edge is door_open/gate_open
  const st = { candidate: 0, bidir: 0, oneway: 0, oneway_by_type: {}, multi_same_dir: 0 };
  const special = []; // [u_local, dst_gid, et]
  const ow = [];
  const keep = ctx.keep;
  for (let u = 0; u < N; u++) {
    const r = regs[RI[u]], k = RK[u];
    const start = nb.length;
    if (!keep[u]) { ptr[u + 1] = nb.length; continue; }
    for (let e = r.ptr[k]; e < r.ptr[k + 1]; e++) {
      const t = r.et[e];
      if (t === ET.teleport || t === ET.ladder_climb || t === ET.ladder_exit || t === ET.door_open || t === ET.gate_open) special.push([u, r.dst[e], t]);
      if (!PL[t]) continue;
      const v = lookup(r.dst[e]); if (v < 0 || !keep[v]) continue;
      const dx = X[v] - X[u], dz = Z[v] - Z[u];
      if (dx < -1 || dx > 1 || dz < -1 || dz > 1 || (dx === 0 && dz === 0)) continue;
      st.candidate++;
      const rv = regs[RI[v]], kv = RK[v]; let back = false;
      for (let e2 = rv.ptr[kv]; e2 < rv.ptr[kv + 1]; e2++) if (rv.dst[e2] === GID[u] && PL[rv.et[e2]]) { back = true; break; }
      if (!back) { st.oneway++; st.oneway_by_type[ETN[t]] = (st.oneway_by_type[ETN[t]] || 0) + 1; if (opts.oneway) ow.push([u, v]); continue; }
      st.bidir++;
      let dup = false; for (let j = start; j < nb.length; j++) if (nb[j] === v) { dup = true; break; }
      if (dup) continue;
      const dc = DCODE[(dx + 1) * 3 + (dz + 1)];
      for (let j = start; j < nb.length; j++) if (dir[j] === dc) { st.multi_same_dir++; break; }
      nb.push(v); dir.push(dc); de.push(t === ET.door_open || t === ET.gate_open ? 1 : 0);
    }
    ptr[u + 1] = nb.length;
  }
  if (opts.oneway && ow.length) { // symmetrise one-way planar edges (drop-only slopes) into the adjacency
    const lists = Array.from({ length: N }, () => null);
    const add = (a, b) => { (lists[a] || (lists[a] = [])).push(b); };
    for (const [a, b] of ow) { add(a, b); add(b, a); }
    const nb2 = [], dir2 = [], de2 = [], p2 = new Int32Array(N + 1);
    for (let u = 0; u < N; u++) {
      const s = nb2.length;
      for (let j = ptr[u]; j < ptr[u + 1]; j++) { nb2.push(nb[j]); dir2.push(dir[j]); de2.push(de[j]); }
      if (lists[u]) for (const v of lists[u]) {
        let dup = false; for (let j = s; j < nb2.length; j++) if (nb2[j] === v) { dup = true; break; }
        if (dup) continue; nb2.push(v); de2.push(0); dir2.push(DCODE[(X[v] - X[u] + 1) * 3 + (Z[v] - Z[u] + 1)]); st.oneway_added = (st.oneway_added || 0) + 1;
      }
      p2[u + 1] = nb2.length;
    }
    st.undirected_edges = nb2.length / 2;
    ctx.P = p2; ctx.NB = Int32Array.from(nb2); ctx.DIR = Int8Array.from(dir2); ctx.DE = Uint8Array.from(de2); ctx.special = special;
    return st;
  }
  st.undirected_edges = nb.length / 2;
  ctx.P = ptr; ctx.NB = Int32Array.from(nb); ctx.DIR = Int8Array.from(dir); ctx.DE = Uint8Array.from(de); ctx.special = special;
  return st;
}

// ---------- step 2+3: boundary + clearance (Dijkstra, 1 / sqrt2) ----------
class Heap { // min-heap on (key, id)
  constructor() { this.k = []; this.v = []; }
  get size() { return this.v.length; }
  push(key, id) {
    const K = this.k, V = this.v; let i = V.length; K.push(key); V.push(id);
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] < key || (K[p] === key && V[p] <= id)) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = key; V[i] = id;
  }
  pop() {
    const K = this.k, V = this.v; const top = V[0]; this.topKey = K[0];
    const lk = K.pop(), lv = V.pop(); const n = V.length;
    if (n) {
      let i = 0;
      for (;;) {
        const a = 2 * i + 1, b = a + 1; let s = -1, sk = lk, sv = lv;
        if (a < n && (K[a] < sk || (K[a] === sk && V[a] < sv))) { s = a; sk = K[a]; sv = V[a]; }
        if (b < n && (K[b] < sk || (K[b] === sk && V[b] < sv))) { s = b; sk = K[b]; sv = V[b]; }
        if (s < 0) break; K[i] = K[s]; V[i] = V[s]; i = s;
      }
      K[i] = lk; V[i] = lv;
    }
    return top;
  }
}

function clearance(ctx, opts) {
  const { N, P, NB, DIR } = ctx;
  const full = opts.borderDiag ? 0xff : 0x0f;
  const boundary = new Uint8Array(N); let nb = 0;
  const d = new Float32Array(N).fill(Infinity); const h = new Heap();
  for (let u = 0; u < N; u++) {
    if (!ctx.keep[u]) continue;
    let m = 0; for (let j = P[u]; j < P[u + 1]; j++) m |= 1 << DIR[j];
    if ((m & full) !== full) { boundary[u] = 1; nb++; d[u] = 0.5; h.push(0.5, u); }
  }
  while (h.size) {
    const u = h.pop(), du = h.topKey; if (du > d[u]) continue;
    for (let j = P[u]; j < P[u + 1]; j++) {
      const v = NB[j], nd = du + (DIR[j] < 4 ? 1 : SQ2);
      if (nd < d[v]) { d[v] = nd; h.push(nd, v); }
    }
  }
  ctx.d = d; ctx.boundary = boundary;
  let dmax = 0; for (let u = 0; u < N; u++) if (d[u] > dmax && d[u] < Infinity) dmax = d[u];
  return { boundary: nb, dmax };
}

// ---------- step 4: distance-ordered homotopic thinning ----------
function thin(ctx, opts) {
  const { N, P, NB, DIR, d } = ctx;
  const alive = Uint8Array.from(ctx.keep);
  const anchor = new Uint8Array(N);
  for (let u = 0; u < N; u++) { let a = 1; for (let j = P[u]; j < P[u + 1]; j++) if (d[NB[j]] > d[u] + 1e-6) { a = 0; break; } anchor[u] = a; }
  const { X, Z } = ctx;
  const mk = new Int32Array(N), pos = new Int32Array(N); let stamp = 0;
  const mk2 = new Int32Array(N), own = new Int32Array(N); let stamp2 = 0;
  const L = new Int32Array(64), par = new Int32Array(64);
  const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const h = new Heap();
  for (let u = 0; u < N; u++) if (ctx.boundary[u]) h.push(d[u], u);
  function isBorder(c) {
    let m = 0; for (let j = P[c]; j < P[c + 1]; j++) if (alive[NB[j]] && DIR[j] < 4) m |= 1 << DIR[j];
    return m !== 0x0f;
  }
  let deleted = 0, pops = 0;
  while (h.size) {
    const c = h.pop(); pops++;
    if (!alive[c] || !isBorder(c)) continue;
    let n = 0; stamp++;
    for (let j = P[c]; j < P[c + 1]; j++) { const v = NB[j]; if (alive[v] && mk[v] !== stamp) { mk[v] = stamp; pos[v] = n; L[n] = v; par[n] = n; n++; } }
    if (n === 0) continue;
    if (n === 1) { if (opts.endpoint === 'deg' || anchor[c]) continue; }
    else {
      // neighbours connect directly (edge between them) or through a 'corner' cell b: an alive non-neighbour of c
      // that is adjacent (by graph edge) to >=2 neighbours and lies in c's 3x3 xz window (window only limits the
      // search; adjacency is still graph edges). Without corners a 4-connected patch (no diagonal edges, e.g. on
      // slopes/stairs) never has a deletable cell.
      let comps = n; stamp2++;
      for (let i = 0; i < n; i++) {
        const a = L[i];
        for (let j = P[a]; j < P[a + 1]; j++) {
          const b = NB[j]; if (b === c || !alive[b]) continue;
          let other = -1;
          if (mk[b] === stamp) other = pos[b];
          else if (opts.corners) {
            const ex = X[b] - X[c], ez = Z[b] - Z[c];
            if (ex < -1 || ex > 1 || ez < -1 || ez > 1 || (ex === 0 && ez === 0)) continue;
            if (mk2[b] !== stamp2) { mk2[b] = stamp2; own[b] = i; continue; }
            other = own[b];
          } else continue;
          const ra = find(i), rb = find(other); if (ra !== rb) { par[ra] = rb; comps--; }
        }
      }
      if (comps !== 1) continue;
    }
    alive[c] = 0; deleted++;
    for (let i = 0; i < n; i++) h.push(d[L[i]], L[i]);
  }
  let left = 0; for (let u = 0; u < N; u++) left += alive[u];
  return { S: alive, stats: { deleted, skeleton: left, pops } };
}

// ---------- step 5: skeleton -> graph ----------
function buildGraph(ctx, S, forced, opts) {
  const { N, P, NB, X, Z, F, d } = ctx;
  const deg = new Uint8Array(N);
  for (let u = 0; u < N; u++) if (S[u]) { let k = 0; for (let j = P[u]; j < P[u + 1]; j++) if (S[NB[j]]) k++; deg[u] = k; }
  const isNode = new Uint8Array(N);
  for (let u = 0; u < N; u++) if (S[u] && (deg[u] !== 2 || (forced && forced[u]))) isNode[u] = 1;
  const cluster = new Int32Array(N).fill(-1); const nodes = [];
  const mkNode = (cells) => {
    let best = cells[0]; for (const c of cells) if (d[c] > d[best]) best = c;
    const id = nodes.length; for (const c of cells) cluster[c] = id;
    nodes.push({ id, cells, rep: best, radius: d[best] });
    return id;
  };
  for (let u = 0; u < N; u++) {
    if (!isNode[u] || cluster[u] >= 0) continue;
    const cells = [u]; cluster[u] = -2;
    for (let q = 0; q < cells.length; q++) { const a = cells[q]; for (let j = P[a]; j < P[a + 1]; j++) { const b = NB[j]; if (isNode[b] && cluster[b] === -1) { cluster[b] = -2; cells.push(b); } } }
    mkNode(cells);
  }
  const edges = []; const visited = new Uint8Array(N); const seen = new Set();
  const step = (a, b) => Math.sqrt((X[a] - X[b]) ** 2 + (Z[a] - Z[b]) ** 2 + ((F[a] - F[b]) / 16) ** 2);
  const finish = (pathc) => {
    let len = 0, wmin = Infinity;
    for (let i = 0; i < pathc.length; i++) { if (i) len += step(pathc[i - 1], pathc[i]); wmin = Math.min(wmin, 2 * d[pathc[i]]); }
    const a = cluster[pathc[0]], b = cluster[pathc[pathc.length - 1]];
    if (a === b && len < opts.selfLoopMin) return;
    edges.push({ a, b, cells: pathc, length: len, width_min: wmin });
  };
  const trace = (c, nb) => {
    const pathc = [c]; let prev = c, cur = nb;
    for (;;) {
      pathc.push(cur);
      if (isNode[cur]) break;
      visited[cur] = 1;
      let nxt = -1; for (let j = P[cur]; j < P[cur + 1]; j++) { const v = NB[j]; if (S[v] && v !== prev) { nxt = v; break; } }
      if (nxt < 0) break;
      prev = cur; cur = nxt;
    }
    return pathc;
  };
  const walkNode = (i) => {
    for (const c of nodes[i].cells) for (let j = P[c]; j < P[c + 1]; j++) {
      const v = NB[j]; if (!S[v] || cluster[v] === i) continue;
      if (isNode[v]) { const key = Math.min(c, v) + ',' + Math.max(c, v); if (seen.has(key)) continue; seen.add(key); finish([c, v]); }
      else if (!visited[v]) finish(trace(c, v));
    }
  };
  for (let i = 0; i < nodes.length; i++) walkNode(i);
  for (let u = 0; u < N; u++) if (S[u] && deg[u] === 2 && !isNode[u] && !visited[u]) { // pure cycles
    isNode[u] = 1; const i = mkNode([u]); nodes[i].loop = true; walkNode(i);
  }
  const gdeg = new Int32Array(nodes.length);
  for (const e of edges) { gdeg[e.a]++; gdeg[e.b]++; }
  nodes.forEach((n, i) => { n.deg = gdeg[i]; });
  return { nodes, edges, cluster, deg };
}

// ---------- step 6: prune spurs + tiny components ----------
function dropSmallComponents(ctx, S, minComp) {
  const { N, P, NB } = ctx; const seen = new Uint8Array(N); let dropped = 0, comps = 0;
  for (let u = 0; u < N; u++) {
    if (!S[u] || seen[u]) continue; const q = [u]; seen[u] = 1;
    for (let i = 0; i < q.length; i++) for (let j = P[q[i]]; j < P[q[i] + 1]; j++) { const v = NB[j]; if (S[v] && !seen[v]) { seen[v] = 1; q.push(v); } }
    if (q.length < minComp) { for (const c of q) S[c] = 0; dropped += q.length; } else comps++;
  }
  return { dropped_cells: dropped, components: comps };
}

function prune(ctx, S, opts) {
  const st = { rounds: 0, spurs: 0, cells: 0 };
  for (let round = 0; round < 20; round++) {
    const g = buildGraph(ctx, S, null, opts); let removed = 0;
    for (const e of g.edges) {
      let end, jn;
      if (g.nodes[e.a].deg === 1 && g.nodes[e.b].deg >= 3) { end = e.a; jn = e.b; }
      else if (g.nodes[e.b].deg === 1 && g.nodes[e.a].deg >= 3) { end = e.b; jn = e.a; }
      else continue;
      const r = opts.pruneRule === 'end' ? g.nodes[end].radius : g.nodes[jn].radius;
      if (e.length >= Math.max(opts.pMin, opts.pK * r)) continue;
      for (const c of e.cells) if (g.cluster[c] !== jn && S[c]) { S[c] = 0; st.cells++; }
      removed++;
    }
    st.rounds = round + 1; st.spurs += removed;
    if (!removed) break;
  }
  return st;
}

// ---------- step 6b: break short cycles (holes left by poles, trees, lamps, single blocks) ----------
// A cycle whose total length is below cycleMax(r) encloses a small obstacle; the road around it is one road.
// Remove the narrowest edge of such a cycle (its interior cells), shortest cycles first, then re-prune.
function breakCycles(ctx, S, opts) {
  const st = { rounds: 0, edges_removed: 0, cells: 0 };
  for (let round = 0; round < 10; round++) {
    const g = buildGraph(ctx, S, null, opts);
    const adj = g.nodes.map(() => []); g.edges.forEach((e, i) => { if (e.a !== e.b) { adj[e.a].push(i); adj[e.b].push(i); } });
    const cand = [];
    g.edges.forEach((e, i) => {
      if (e.a === e.b) { cand.push([e.length, i]); return; }
      const lim = Math.max(opts.cycleMin, opts.cycleK * Math.max(g.nodes[e.a].radius, g.nodes[e.b].radius)) - e.length;
      if (lim <= 0) return;
      // bounded Dijkstra a -> b without edge i
      const dist = new Map([[e.a, 0]]); const h = new Heap(); h.push(0, e.a); let found = Infinity;
      while (h.size) {
        const u = h.pop(), du = h.topKey; if (du > dist.get(u)) continue; if (du > lim) break;
        if (u === e.b) { found = du; break; }
        for (const k of adj[u]) { if (k === i) continue; const f = g.edges[k]; const v = f.a === u ? f.b : f.a; const nd = du + f.length; if (nd <= lim && nd < (dist.has(v) ? dist.get(v) : Infinity)) { dist.set(v, nd); h.push(nd, v); } }
      }
      if (found < Infinity) cand.push([e.length + found, i]);
    });
    // narrowest first within a cycle: sort by width then by cycle length; one removal per node pair per round
    cand.sort((p, q) => g.edges[p[1]].width_min - g.edges[q[1]].width_min || p[0] - q[0]);
    const touched = new Uint8Array(g.nodes.length); let removed = 0;
    for (const [, i] of cand) {
      const e = g.edges[i]; if (touched[e.a] || touched[e.b]) continue;
      touched[e.a] = touched[e.b] = 1;
      const inner = e.cells.slice(1, -1).filter((c) => g.cluster[c] < 0);
      if (!inner.length) { // edge is a direct node-node step: cut by removing nothing safe -> skip
        continue;
      }
      for (const c of inner) { S[c] = 0; st.cells++; }
      removed++;
    }
    st.rounds = round + 1; st.edges_removed += removed;
    if (!removed) break;
  }
  return st;
}

// ---------- step 8: forced nodes (teleport / ladder / door) ----------
// extra: [[cell, tag], ...] more forced cells (v2 region exits); block: Uint8Array, cells the link BFS may not enter (v2 regions)
function forcedNodes(ctx, S, extra, block) {
  const { N, P, NB, lookup, special } = ctx;
  const forced = new Uint8Array(N); const tags = new Map(); const sp = [];
  const tag = (u, t) => { forced[u] = 1; if (!tags.has(u)) tags.set(u, new Set()); tags.get(u).add(t); };
  const lpar = new Map(); const lf = (a) => { while (lpar.get(a) !== a) { lpar.set(a, lpar.get(lpar.get(a))); a = lpar.get(a); } return a; };
  const st = { teleport: 0, teleport_external: 0, door: 0, ladder_components: 0, linked: 0, unlinked: 0, link_cells: 0 };
  for (const [u, dg, t] of special) {
    let v = lookup(dg); if (!ctx.keep[u]) continue; if (v >= 0 && !ctx.keep[v]) v = -1;
    if (t === ET.teleport) { tag(u, 'teleport_src'); if (v >= 0) tag(v, 'teleport_dst'); else st.teleport_external++; sp.push({ kind: 'teleport', u, v, dst_gid: dg }); st.teleport++; }
    else if (t === ET.door_open || t === ET.gate_open) { tag(u, ETN[t] === 'door_open' ? 'door' : 'gate'); if (v >= 0) tag(v, ETN[t] === 'door_open' ? 'door' : 'gate'); st.door++; }
    else if (v >= 0) { // ladder: union cells
      for (const a of [u, v]) if (!lpar.has(a)) lpar.set(a, a);
      const ra = lf(u), rb = lf(v); if (ra !== rb) lpar.set(ra, rb);
    }
  }
  const lcomp = new Map(); for (const a of lpar.keys()) { const r = lf(a); if (!lcomp.has(r)) lcomp.set(r, []); lcomp.get(r).push(a); }
  for (const cells of lcomp.values()) {
    st.ladder_components++;
    let att = cells.filter((c) => P[c + 1] > P[c]);
    if (!att.length) att = [cells[0]];
    att.sort((a, b) => ctx.F[a] - ctx.F[b]);
    for (const c of att) tag(c, 'ladder');
    for (let i = 1; i < att.length; i++) sp.push({ kind: 'ladder', u: att[0], v: att[i], cells: cells.length });
  }
  if (extra) for (const [c, tg] of extra) tag(c, tg);
  // link every forced cell to nearest skeleton cell: multi-source BFS from skeleton over planar edges
  const par = new Int32Array(N).fill(-2); const q = [];
  for (let u = 0; u < N; u++) if (S[u]) { par[u] = -1; q.push(u); }
  for (let i = 0; i < q.length; i++) { const a = q[i]; for (let j = P[a]; j < P[a + 1]; j++) { const b = NB[j]; if (par[b] === -2 && !(block && block[b])) { par[b] = a; q.push(b); } } }
  for (const u of tags.keys()) {
    if (S[u]) { st.linked++; continue; }
    if (par[u] === -2) { S[u] = 1; st.unlinked++; continue; }
    st.linked++;
    for (let c = u; c >= 0 && !S[c]; c = par[c]) { S[c] = 1; st.link_cells++; }
  }
  return { forced, tags, special: sp, stats: st };
}

// ---------- step 7: plazas ----------
function plazas(ctx, opts) {
  const { N, P, NB, d } = ctx; const pid = new Int32Array(N).fill(-1); const list = [];
  for (let u = 0; u < N; u++) {
    if (d[u] < opts.plazaD || pid[u] !== -1) continue;
    const q = [u]; pid[u] = -2;
    for (let i = 0; i < q.length; i++) for (let j = P[q[i]]; j < P[q[i] + 1]; j++) { const v = NB[j]; if (d[v] >= opts.plazaD && pid[v] === -1) { pid[v] = -2; q.push(v); } }
    const id = q.length >= opts.plazaMin ? list.length : -3;
    if (id >= 0) { let best = q[0]; for (const c of q) if (d[c] > d[best]) best = c; list.push({ size: q.length, rep: best }); }
    for (const c of q) pid[c] = id;
  }
  return { pid, list };
}

// ---------- full pipeline ----------
function run(dataDir, box, userOpts = {}) {
  const opts = Object.assign({}, DEFAULTS, userOpts);
  const T = {}; let t = Date.now(); const lap = (k) => { const n = Date.now(); T[k] = n - t; t = n; };
  const ctx = loadBox(dataDir, box, opts); lap('load_ms');
  const stats = { regions: ctx.regions, cells: ctx.N };
  if (opts.reach) { stats.reach = reachFilter(ctx, opts.seeds, (s) => nearestLocal(ctx, s)); lap('reach_ms'); }
  stats.planar = buildPlanar(ctx, opts); lap('planar_ms');
  stats.clearance = clearance(ctx, opts); lap('clearance_ms');
  const th = thin(ctx, opts); const S = th.S; stats.thin = th.stats; lap('thin_ms');
  stats.small_components = dropSmallComponents(ctx, S, opts.minComp);
  stats.prune = prune(ctx, S, opts);
  if (opts.cycles) { stats.cycles = breakCycles(ctx, S, opts); stats.prune2 = prune(ctx, S, opts); }
  stats.small_components_after_prune = dropSmallComponents(ctx, S, opts.minComp);
  let sk = 0; for (let u = 0; u < ctx.N; u++) sk += S[u]; stats.skeleton_after_prune = sk; lap('prune_ms');
  const fo = forcedNodes(ctx, S); stats.forced = fo.stats; lap('forced_ms');
  const g = buildGraph(ctx, S, fo.forced, opts); lap('graph_ms');
  const out = toOutput(ctx, S, g, fo, opts, stats); lap('plaza_output_ms');
  stats.timing_ms = T;
  return { ctx, S, g, fo, out, opts, stats };
}

function cellPos(ctx, c) { return [ctx.X[c], +(ctx.F[c] / 16).toFixed(3), ctx.Z[c]]; }

function toOutput(ctx, S, g, fo, opts, stats) {
  const { box, X, Z } = ctx;
  const inBox = (c) => X[c] >= box.x0 && X[c] <= box.x1 && Z[c] >= box.z0 && Z[c] <= box.z1;
  // node kinds
  const nmap = g.nodes.map((n) => {
    const tags = new Set(); for (const c of n.cells) if (fo.tags.has(c)) for (const tg of fo.tags.get(c)) tags.add(tg);
    let kind = n.deg >= 3 ? 'junction' : n.deg === 1 ? 'end' : n.deg === 0 ? 'isolated' : n.loop ? 'loop' : 'pass';
    if (tags.size && kind !== 'junction') kind = 'forced';
    return { kind, tags: [...tags], pos: cellPos(ctx, n.rep), radius: +n.radius.toFixed(2), cells: n.cells.length, rep: n.rep };
  });
  // plaza merge: non-forced nodes whose cells touch a plaza component collapse into one plaza node
  let remap = g.nodes.map((_, i) => i), plazaNodes = 0;
  if (opts.plaza) {
    const pz = plazas(ctx, opts); const pnode = new Map();
    g.nodes.forEach((n, i) => {
      if (nmap[i].tags.length) return;
      let p = -1; for (const c of n.cells) if (pz.pid[c] >= 0) { p = pz.pid[c]; break; }
      if (p < 0) return;
      if (!pnode.has(p)) { const P0 = pz.list[p]; pnode.set(p, nmap.length); nmap.push({ kind: 'plaza', tags: [], pos: cellPos(ctx, P0.rep), radius: +ctx.d[P0.rep].toFixed(2), cells: 0, area: P0.size, merged: 0, rep: P0.rep }); }
      remap[i] = pnode.get(p); nmap[remap[i]].merged++;
    });
    stats.plaza = { components: pz.list.length, used: pnode.size, merged_nodes: [...pnode.values()].reduce((s, k) => s + nmap[k].merged, 0) };
    plazaNodes = pnode.size;
  }
  const E = []; const R0 = [];
  for (const e of g.edges) {
    const a = remap[e.a], b = remap[e.b];
    if (a === b && nmap[a].kind === 'plaza') continue; // internal plaza edge
    R0.push({ a, b, cells: e.cells.slice(), length: e.length, width_min: e.width_min });
  }
  // merge chains through untagged degree-2 nodes (clusters of adjacent junction cells that end up with 2 roads)
  const inc = nmap.map(() => []); R0.forEach((e, i) => { inc[e.a].push(i); if (e.b !== e.a) inc[e.b].push(i); });
  const dead = []; let merged = 0;
  const stp = (p, q) => Math.sqrt((X[p] - X[q]) ** 2 + (Z[p] - Z[q]) ** 2 + ((ctx.F[p] - ctx.F[q]) / 16) ** 2);
  for (let n = 0; n < nmap.length; n++) {
    if (nmap[n].kind === 'plaza' || nmap[n].tags.length) continue;
    const live = inc[n].filter((i) => !dead[i]); if (live.length !== 2) continue;
    const [i, j] = live; const e1 = R0[i], e2 = R0[j]; if (e1.a === e1.b || e2.a === e2.b) continue;
    const c1 = e1.b === n ? e1.cells : e1.cells.slice().reverse(); const o1 = e1.b === n ? e1.a : e1.b;
    const c2 = e2.a === n ? e2.cells : e2.cells.slice().reverse(); const o2 = e2.a === n ? e2.b : e2.a;
    const join = c1[c1.length - 1] === c2[0] ? 0 : stp(c1[c1.length - 1], c2[0]);
    const ne = { a: o1, b: o2, cells: c1.concat(c1[c1.length - 1] === c2[0] ? c2.slice(1) : c2), length: e1.length + e2.length + join, width_min: Math.min(e1.width_min, e2.width_min) };
    dead[i] = dead[j] = 1; R0.push(ne);
    const k = R0.length - 1; inc[o1] = inc[o1].filter((x) => x !== i && x !== j).concat([k]); if (o2 !== o1) inc[o2] = inc[o2].filter((x) => x !== i && x !== j).concat([k]);
    inc[n] = []; nmap[n].kind = 'merged'; merged++;
  }
  stats.merged_pass_nodes = merged;
  for (let i = 0; i < R0.length; i++) {
    if (dead[i]) continue; const e = R0[i]; const { a, b } = e;
    if (!e.cells.some(inBox)) continue;
    const pl = []; for (let i = 0; i < e.cells.length; i += opts.polyStep) pl.push(cellPos(ctx, e.cells[i]));
    if ((e.cells.length - 1) % opts.polyStep) pl.push(cellPos(ctx, e.cells[e.cells.length - 1]));
    E.push({ a, b, kind: 'road', length: +e.length.toFixed(2), width_min: +e.width_min.toFixed(2), cells: e.cells.length, polyline: pl });
  }
  for (const s of fo.special) {
    const a = remap[g.cluster[s.u]]; const rec = { a, b: s.v >= 0 ? remap[g.cluster[s.v]] : null, kind: s.kind };
    if (s.kind === 'teleport') rec.dst_gid = s.dst_gid;
    if (s.kind === 'ladder') { rec.length = Math.abs(ctx.F[s.u] - ctx.F[s.v]) / 16; rec.ladder_cells = s.cells; }
    if (s.u >= 0 && inBox(s.u)) E.push(rec);
  }
  // keep referenced nodes + nodes inside box, renumber
  const used = new Set(); for (const e of E) { used.add(e.a); if (e.b != null) used.add(e.b); }
  nmap.forEach((n, i) => { if (inBox(n.rep) && n.kind !== 'pass' && n.kind !== 'merged') used.add(i); });
  const order = [...used].sort((x, y) => x - y); const nid = new Map(order.map((o, i) => [o, i]));
  const nodes = order.map((o, i) => { const n = nmap[o]; const r = Object.assign({ id: i }, n); delete r.rep; return r; });
  for (const e of E) { e.a = nid.get(e.a); if (e.b != null) e.b = nid.get(e.b); }
  const dg = new Int32Array(nodes.length); for (const e of E) if (e.kind === 'road') { dg[e.a]++; dg[e.b]++; }
  nodes.forEach((n, i) => { n.deg = dg[i]; });
  const byKind = {}; for (const n of nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
  const ek = {}; for (const e of E) ek[e.kind] = (ek[e.kind] || 0) + 1;
  stats.graph = { nodes: nodes.length, nodes_by_kind: byKind, edges: E.length, edges_by_kind: ek, plaza_nodes: plazaNodes,
    road_length_total: +E.filter((e) => e.kind === 'road').reduce((s, e) => s + e.length, 0).toFixed(1) };
  return { nodes, edges: E, remap, nmap, nid };
}

// ---------- multi-level stats ----------
function levelStats(ctx, S) {
  const { N, X, Z, box } = ctx; const col = new Map(); let inb = 0;
  for (let u = 0; u < N; u++) { if (!ctx.keep[u] || X[u] < box.x0 || X[u] > box.x1 || Z[u] < box.z0 || Z[u] > box.z1) continue; inb++; const k = X[u] * 65536 + Z[u]; col.set(k, (col.get(k) || 0) + 1); }
  let multi = 0, maxl = 0; for (const v of col.values()) { if (v > 1) multi++; if (v > maxl) maxl = v; }
  // skeleton cells in multi-level columns, and columns with skeleton on >1 level
  const sc = new Map(); let skIn = 0, skMulti = 0;
  for (let u = 0; u < N; u++) { if (!S[u] || X[u] < box.x0 || X[u] > box.x1 || Z[u] < box.z0 || Z[u] > box.z1) continue; skIn++; const k = X[u] * 65536 + Z[u]; if (col.get(k) > 1) skMulti++; sc.set(k, (sc.get(k) || 0) + 1); }
  let skStack = 0; for (const v of sc.values()) if (v > 1) skStack++;
  return { cells_in_box: inb, columns: col.size, multi_level_columns: multi, max_levels: maxl, skeleton_cells_in_box: skIn, skeleton_in_multi_level_columns: skMulti, columns_with_skeleton_on_2plus_levels: skStack };
}

// ---------- PNG ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}
function encodePNG(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function render(res, scale = 3) {
  const { ctx, S, out } = res; const { box, N, X, Z, F, T, d } = ctx;
  const W = box.x1 - box.x0 + 1, H = box.z1 - box.z0 + 1, w = W * scale, h = H * scale;
  const top = new Int32Array(W * H).fill(-1);
  for (let u = 0; u < N; u++) {
    const x = X[u] - box.x0, z = Z[u] - box.z0; if (x < 0 || z < 0 || x >= W || z >= H) continue;
    if (!ctx.keep[u]) continue;
    const k = z * W + x; if (top[k] < 0 || F[u] > F[top[k]]) top[k] = u;
  }
  const skTop = new Uint8Array(W * H); // 1 = skeleton on top cell, 2 = skeleton on a lower level only
  for (let u = 0; u < N; u++) {
    if (!S[u]) continue; const x = X[u] - box.x0, z = Z[u] - box.z0; if (x < 0 || z < 0 || x >= W || z >= H) continue;
    const k = z * W + x; if (top[k] === u) skTop[k] = 1; else if (!skTop[k]) skTop[k] = 2;
  }
  const img = Buffer.alloc(w * h * 3);
  const put = (px, py, c) => { if (px < 0 || py < 0 || px >= w || py >= h) return; const o = (py * w + px) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; };
  const lerp = (a, b, s) => a.map((v, i) => Math.round(v + (b[i] - v) * s));
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const k = z * W + x, u = top[k]; let c;
    if (u < 0) c = [28, 28, 32];
    else {
      const s = Math.min(1, (d[u] - 0.5) / 7.5);
      c = (T[u] & T_WATER) ? lerp([15, 30, 90], [120, 170, 250], s) : lerp([25, 70, 30], [215, 235, 175], s);
    }
    if (skTop[k] === 1) c = [235, 20, 20]; else if (skTop[k] === 2) c = [160, 0, 140];
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(x * scale + dx, z * scale + dy, c);
  }
  const COL = { junction: [255, 230, 0], end: [40, 110, 255], forced: [0, 240, 240], plaza: [255, 140, 0], loop: [255, 230, 0], isolated: [40, 110, 255] };
  for (const n of out.nodes) {
    const c = COL[n.kind]; if (!c) continue;
    const cx = (n.pos[0] - box.x0) * scale + (scale >> 1), cz = (n.pos[2] - box.z0) * scale + (scale >> 1);
    const r = n.kind === 'plaza' ? 3 * scale : scale;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const q = dx * dx + dy * dy;
      if (n.kind === 'plaza' ? (q <= r * r && q >= (r - 2) * (r - 2)) : q <= r * r + 1) put(cx + dx, cz + dy, c);
    }
  }
  return { png: encodePNG(w, h, img), w, h };
}

module.exports = { DEFAULTS, ETN, ET, Heap, SQ2, cellPos, toOutput, nearestLocal, loadBox, reachFilter, breakCycles, buildPlanar, clearance, thin, buildGraph, prune, dropSmallComponents, forcedNodes, plazas, run, render, levelStats, encodePNG };
