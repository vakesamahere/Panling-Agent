'use strict';
// Reference loader + A* for the PFG3 walkability graph (see FORMAT_node.md). Pure Node, no dependencies.
//   const G = require('./graph'); G.load('./data');
//   const c = G.nearestCell(x, y, z);            // {id, x, y, z, f, t, fb} or null
//   const cells = G.plan([x,y,z], [x,y,z], {maxNodes: 300000});  // [] if unreachable; cells.info = {cost,length,expanded,ms,...}
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ETN = ['walk', 'jump', 'drop', 'swim', 'water_enter', 'water_exit', 'ladder_climb', 'ladder_exit', 'teleport', 'door_open', 'gate_open'];
const T_TRAP = 64;
let PLANNING = 0; // >0 while plan() runs: no eviction, so one search never reloads a region
let TICK = 0, DIR = null, IDX = null, REG = {}, OFFS = [], BYKEY = new Map(), TPT = [], NAMES = {}, OPTS = {};

function load(dir, opts = {}) {
  DIR = dir; OPTS = Object.assign({ maxRegions: 12 }, opts);
  IDX = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  REG = {}; OFFS = IDX.regions.map((r, i) => [r.offset, i]).sort((a, b) => a[0] - b[0]);
  BYKEY = new Map(IDX.regions.map((r, i) => [r.rx + ',' + r.rz, i]));
  TPT = IDX.teleport_targets; NAMES = IDX.block_names;
  return IDX;
}

function readRegion(i) {
  if (REG[i]) { REG[i].used = ++TICK; return REG[i]; }
  const R = IDX.regions[i];
  let p = path.join(DIR, R.file), buf;
  if (fs.existsSync(p)) buf = fs.readFileSync(p);
  else if (fs.existsSync(p + '.gz')) buf = zlib.gunzipSync(fs.readFileSync(p + '.gz'));
  else return null; // region not shipped
  if (buf.toString('latin1', 0, 4) !== 'PFG3') throw new Error('bad magic ' + p);
  const ab = (buf.byteOffset % 8 === 0 && buf.length === buf.buffer.byteLength) ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const h = new Uint32Array(ab, 4, 7); const n = h[1], m = h[2], off = h[3], nd = h[4];
  let o = 32; const pad = (b) => (b + 3) & ~3;
  const x = new Int16Array(ab, o, n); o += pad(2 * n);
  const z = new Int16Array(ab, o, n); o += pad(2 * n);
  const f = new Int16Array(ab, o, n); o += pad(2 * n);
  const fb = new Uint16Array(ab, o, n); o += pad(2 * n);
  const y = new Uint8Array(ab, o, n); o += pad(n);
  const t = new Uint8Array(ab, o, n); o += pad(n);
  const ptr = new Uint32Array(ab, o, n + 1); o += 4 * (n + 1);
  const dst = new Int32Array(ab, o, m); o += 4 * m;
  const cost = new Float32Array(ab, o, m); o += 4 * m;
  const et = new Uint8Array(ab, o, m); o += pad(m);
  const dr = new Int32Array(ab, o, nd * 5);
  const doors = new Map(); for (let k = 0; k < nd; k++) doors.set(dr[5 * k], [dr[5 * k + 1], dr[5 * k + 2], dr[5 * k + 3], dr[5 * k + 4]]);
  // column index: head[(x-x0)*512 + (z-z0)] -> first cell, nxt[] -> next cell (ascending id order)
  const head = new Int32Array(512 * 512).fill(-1), nxt = new Int32Array(n).fill(-1);
  for (let k = n - 1; k >= 0; k--) { const c = (x[k] - R.x0) * 512 + (z[k] - R.z0); nxt[k] = head[c]; head[c] = k; }
  if (!PLANNING) trimCache(OPTS.maxRegions - 1);
  REG[i] = { R, n, m, off, x, z, f, fb, y, t, ptr, dst, cost, et, doors, head, nxt, used: ++TICK };
  return REG[i];
}

// LRU trim down to `keep` regions; ids are global so an evicted region just reloads later
function trimCache(keep) {
  const keys = Object.keys(REG);
  if (keys.length <= keep) return;
  keys.sort((a, b) => REG[a].used - REG[b].used);
  for (let j = 0; j < keys.length - keep; j++) delete REG[keys[j]];
}

function regionOf(id) { // binary search region by global id
  let lo = 0, hi = OFFS.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (OFFS[mid][0] <= id) lo = mid; else hi = mid - 1; }
  return readRegion(OFFS[lo][1]);
}
function cell(id) {
  const r = regionOf(id); const k = id - r.off;
  return { id, x: r.x[k], y: r.y[k], z: r.z[k], f: r.f[k], t: r.t[k], fb: r.fb[k] };
}
function column(x, z) {
  const i = BYKEY.get(Math.floor(x / 512) + ',' + Math.floor(z / 512)); if (i === undefined) return [];
  const r = readRegion(i); if (!r) return [];
  const out = []; for (let k = r.head[(x - r.R.x0) * 512 + (z - r.R.z0)]; k >= 0; k = r.nxt[k]) out.push(r.off + k);
  return out;
}
// all non-trap cells within horizontal radius rh and |floor - y| <= dy, nearest first (same order as HPC query)
function cellsNear(x, y, z, rh = 2.0, dy = 1.0) {
  x = Math.floor(x); z = Math.floor(z); const R = Math.ceil(rh), out = [];
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
    if (dx * dx + dz * dz > rh * rh + 1e-9) continue;
    for (const id of column(x + dx, z + dz)) { const c = cell(id); if (Math.abs(c.f / 16 - y) <= dy && !(c.t & T_TRAP)) out.push([(c.x - x) ** 2 + (c.z - z) ** 2 + (c.f / 16 - y) ** 2, out.length, c]); }
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out.map((e) => e[2]);
}
function nearestCell(x, y, z) {
  let c = cellsNear(x, y, z, 2.0, 1.0); if (!c.length) c = cellsNear(x, y, z, 3.0, 3.0);
  return c.length ? c[0] : null;
}

// binary min-heap on (f, g, id)
class Heap {
  constructor() { this.f = []; this.g = []; this.v = []; }
  get size() { return this.v.length; }
  less(i, j) { return this.f[i] < this.f[j] || (this.f[i] === this.f[j] && (this.g[i] < this.g[j] || (this.g[i] === this.g[j] && this.v[i] < this.v[j]))); }
  swap(i, j) { [this.f[i], this.f[j]] = [this.f[j], this.f[i]]; [this.g[i], this.g[j]] = [this.g[j], this.g[i]]; [this.v[i], this.v[j]] = [this.v[j], this.v[i]]; }
  push(f, g, v) { this.f.push(f); this.g.push(g); this.v.push(v); let i = this.v.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; this.swap(i, p); i = p; } }
  pop() {
    const r = [this.f[0], this.g[0], this.v[0]]; const lf = this.f.pop(), lg = this.g.pop(), lv = this.v.pop();
    if (this.v.length) { this.f[0] = lf; this.g[0] = lg; this.v[0] = lv; let i = 0; for (;;) { const a = 2 * i + 1, b = a + 1; let s = i; if (a < this.v.length && this.less(a, s)) s = a; if (b < this.v.length && this.less(b, s)) s = b; if (s === i) break; this.swap(i, s); i = s; } }
    return r;
  }
}

function point(c, act, door) {
  const p = { x: c.x + 0.5, y: c.f / 16, z: c.z + 0.5, act, fb: NAMES[c.fb >> 4] || '?' };
  if (door) Object.assign(p, door); else if (act !== 'start' && act !== 'end') p.kind = act;
  return p;
}

// from/to: [x,y,z] or {x,y,z}. Goal = every cell within 2 blocks horizontally / 1 vertically of `to` (fallback 3/3).
// Regions touched during one search stay loaded (may exceed maxRegions temporarily); trimmed after it ends.
function plan(from, to, opts = {}) {
  PLANNING++;
  try { return planSearch(from, to, opts); } finally { if (--PLANNING === 0) trimCache(OPTS.maxRegions); }
}
function planSearch(from, to, opts = {}) {
  const maxNodes = opts.maxNodes || 400000; const t0 = process.hrtime.bigint();
  const P = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]);
  const [fx, fy, fz] = P(from), [tx, ty, tz] = P(to);
  const src = nearestCell(fx, fy, fz);
  let goals = cellsNear(tx, ty, tz, 2.0, 1.0); if (!goals.length) goals = cellsNear(tx, ty, tz, 3.0, 3.0);
  const fail = (why, exp = 0) => { const a = []; a.info = { reachable: false, why, expanded: exp, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; return a; };
  if (!src || !goals.length) return fail('no standable cell near endpoint');
  const G = new Set(goals.map((c) => c.id)); const gx = goals.map((c) => c.x), gz = goals.map((c) => c.z);
  const hd = (x, z) => { let b = Infinity; for (let j = 0; j < gx.length; j++) b = Math.min(b, Math.hypot(x - gx[j], z - gz[j])); return b; };
  // Straight-line distance to the goal is the tightest admissible bound available here.
  // The old bound also considered teleports (nearest landing to goal + 10) but ignored the walk to the
  // teleport source, which capped it at 26-41 and turned A* into Dijkstra. Measured: dropping it cut
  // 110 random pairs from 87.0s to 43.7s with identical route costs (see bench_h.js / cmp_h.js).
  const h = (x, z) => hd(x, z);
  const dist = new Map([[src.id, 0]]), prev = new Map([[src.id, [-1, -1, null]]]); const pq = new Heap();
  pq.push(h(src.x, src.z), 0, src.id); let exp = 0, end = -1, gend = 0;
  while (pq.size) {
    const [, gv, u] = pq.pop();
    if (gv > dist.get(u)) continue;
    if (++exp > maxNodes) return fail('maxNodes exceeded', exp);
    if (G.has(u)) { end = u; gend = gv; break; }
    const r = regionOf(u); const k = u - r.off;
    for (let e = r.ptr[k]; e < r.ptr[k + 1]; e++) {
      const v = r.dst[e]; const rv = regionOf(v); if (!rv) continue; const kv = v - rv.off;
      if (rv.t[kv] & T_TRAP) continue;
      const nd = gv + r.cost[e];
      if (nd < (dist.has(v) ? dist.get(v) : Infinity)) { dist.set(v, nd); prev.set(v, [u, r.et[e], r.doors.get(e) || null]); pq.push(nd + h(rv.x[kv], rv.z[kv]), nd, v); }
    }
  }
  if (end < 0) return fail('unreachable', exp);
  const ids = []; for (let v = end; v >= 0; v = prev.get(v)[0]) ids.push(v); ids.reverse();
  const cs = ids.map(cell); const out = []; let length = 0; const kinds = {};
  for (let j = 0; j < ids.length; j++) {
    let act = 'start', door = null;
    if (j > 0) {
      const [, et, d] = prev.get(ids[j]); act = ETN[et];
      if (act === 'ladder_climb' || act === 'ladder_exit') act = 'ladder';
      if (act === 'water_enter' || act === 'water_exit') act = 'swim';
      if (d) { door = { bx: d[0], by: d[1], bz: d[2], kind: act, block: NAMES[d[3] >> 4] || '?', meta: d[3] & 15 }; act = 'door'; }
      kinds[act] = (kinds[act] || 0) + 1;
      if (et !== 8) { const a = cs[j - 1], b = cs[j]; length += Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2 + ((a.f - b.f) / 16) ** 2); }
    }
    out.push(point(cs[j], j === ids.length - 1 ? 'end' : act, door));
  }
  for (let j = 1; j < out.length; j++) if (prev.get(ids[j])[1] === 8) {
    out[j].act = j === out.length - 1 ? 'end' : 'teleport'; out[j].kind = 'teleport';
    out[j].tp_from = [cs[j - 1].x, cs[j - 1].f / 16, cs[j - 1].z]; out[j].tp_to = [cs[j].x, cs[j].f / 16, cs[j].z]; out[j - 1].tp_trigger = true;
  }
  out.info = { reachable: true, cost: gend, length, kinds, expanded: exp, ms: Number(process.hrtime.bigint() - t0) / 1e6, regionsLoaded: Object.keys(REG).length };
  return out;
}

function memoryMB() { return process.memoryUsage().rss / 1e6; }
module.exports = { load, nearestCell, cellsNear, plan, cell, column, memoryMB, ETN, regionOf, trimCache };
