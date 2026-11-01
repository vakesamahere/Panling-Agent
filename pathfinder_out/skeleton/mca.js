'use strict';
// Minimal MC 1.8 Anvil (.mca) reader: region header -> chunk (zlib/gzip) -> NBT -> Level.Sections[].Y/Blocks/Add/Data.
// Pure Node. Read-only. Block ids are the 1.8 numeric ids (Blocks | Add<<8), meta from Data.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- NBT (only what we need; full tag walker so unknown tags are skipped correctly) ----
function parseNBT(buf) {
  let o = 0;
  const u8 = () => buf[o++];
  const i16 = () => { const v = buf.readInt16BE(o); o += 2; return v; };
  const i32 = () => { const v = buf.readInt32BE(o); o += 4; return v; };
  const str = () => { const n = buf.readUInt16BE(o); o += 2; const s = buf.toString('utf8', o, o + n); o += n; return s; };
  function payload(t) {
    switch (t) {
      case 1: return buf.readInt8(o++);
      case 2: return i16();
      case 3: return i32();
      case 4: o += 8; return null;
      case 5: o += 4; return null;
      case 6: o += 8; return null;
      case 7: { const n = i32(); const v = buf.subarray(o, o + n); o += n; return v; }
      case 8: return str();
      case 9: { const et = u8(); const n = i32(); const a = []; for (let i = 0; i < n; i++) a.push(payload(et)); return a; }
      case 10: { const m = {}; for (;;) { const tt = u8(); if (tt === 0) break; const k = str(); m[k] = payload(tt); } return m; }
      case 11: { const n = i32(); const v = new Int32Array(n); for (let i = 0; i < n; i++) v[i] = i32(); return v; }
      case 12: { const n = i32(); o += 8 * n; return null; }
      default: throw new Error('bad nbt tag ' + t + ' at ' + o);
    }
  }
  const t = u8(); str(); return payload(t);
}

// A world reader with a per-region cache. getBlock(x,y,z) -> id (0 if chunk/section missing), getMeta.
class World {
  constructor(regionDir) { this.dir = regionDir; this.regions = new Map(); this.stats = { regions: 0, chunks: 0, sections: 0, bytes: 0 }; }
  region(rx, rz) {
    const key = rx + ',' + rz; if (this.regions.has(key)) return this.regions.get(key);
    const p = path.join(this.dir, `r.${rx}.${rz}.mca`); let R = null;
    if (fs.existsSync(p)) { const buf = fs.readFileSync(p); R = { buf, chunks: new Array(1024).fill(undefined) }; this.stats.regions++; this.stats.bytes += buf.length; }
    this.regions.set(key, R); return R;
  }
  chunk(cx, cz) {
    const R = this.region(cx >> 5, cz >> 5); if (!R) return null;
    const i = (cx & 31) + (cz & 31) * 32; if (R.chunks[i] !== undefined) return R.chunks[i];
    const loc = R.buf.readUInt32BE(4 * i); const off = (loc >>> 8) * 4096, cnt = loc & 255; let C = null;
    if (off && cnt && off + 5 <= R.buf.length) {
      const len = R.buf.readUInt32BE(off), comp = R.buf[off + 4];
      const raw = R.buf.subarray(off + 5, off + 4 + len);
      const data = comp === 1 ? zlib.gunzipSync(raw) : zlib.inflateSync(raw);
      const nbt = parseNBT(data); const lv = nbt.Level || nbt;
      C = { secs: new Array(16).fill(null), xPos: lv.xPos, zPos: lv.zPos };
      for (const s of lv.Sections || []) { if (s.Y >= 0 && s.Y < 16 && s.Blocks) { C.secs[s.Y] = { b: s.Blocks, a: s.Add || null, d: s.Data || null }; this.stats.sections++; } }
      this.stats.chunks++;
    }
    R.chunks[i] = C; return C;
  }
  getBlock(x, y, z) {
    if (y < 0 || y > 255) return 0;
    const C = this.chunk(x >> 4, z >> 4); if (!C) return 0; const s = C.secs[y >> 4]; if (!s) return 0;
    const i = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
    let id = s.b[i]; if (s.a) id |= ((s.a[i >> 1] >> ((i & 1) * 4)) & 15) << 8; return id;
  }
  getMeta(x, y, z) {
    const C = this.chunk(x >> 4, z >> 4); if (!C) return 0; const s = C.secs[y >> 4]; if (!s || !s.d) return 0;
    const i = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15); return (s.d[i >> 1] >> ((i & 1) * 4)) & 15;
  }
}

module.exports = { World, parseNBT };
