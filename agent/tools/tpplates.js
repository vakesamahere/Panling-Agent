// 全图统计传送：扫所有命令方块里的 tp 命令 + 所有压力板方块，把"板 → 落点"配起来。
// 用法: node tools/tpplates.js [out.json]   输出 JSON + 控制台摘要
// 配对规则：
//  1) 命令选择器带坐标（@p[x,y,z,r] 或 @p[x=..,y=..,z=..,r=..]）→ 选择器坐标附近 r 内的压力板就是触发板
//  2) 选择器不带坐标 → 命令方块 8 格内最近的压力板（多半是红石直连），标 guess
const fs = require('fs'), zlib = require('zlib'), nbt = require('prismarine-nbt');
const dir = 'C:/Users/Administrator/Desktop/vake/.server/盘灵古域/world/region/';
const out = process.argv[2] || 'memory/tp_plates.json';
const PLATE = { 70: 'stone', 72: 'wood', 147: 'gold', 148: 'iron' };

function parseSel(sel) {
  // 1.8: @p[x,y,z,r,...] 位置参数 或 key=value
  const m = sel.match(/^@([parae])(?:\[(.*)\])?$/); if (!m) return null;
  const o = { who: m[1] }; if (!m[2]) return o;
  const parts = m[2].split(','); let pos = 0; const keys = ['x', 'y', 'z', 'r'];
  for (const p of parts) {
    const kv = p.split('=');
    if (kv.length === 1) { if (pos < 4) o[keys[pos++]] = +kv[0]; }
    else o[kv[0]] = isNaN(+kv[1]) ? kv[1] : +kv[1];
  }
  return o;
}

(async () => {
  const tps = [], plates = [], marks = [];
  for (const fn of fs.readdirSync(dir)) {
    if (!fn.endsWith('.mca')) continue;
    const buf = fs.readFileSync(dir + fn); if (buf.length < 8192) continue;
    for (let i = 0; i < 1024; i++) {
      const off = buf.readUIntBE(i * 4, 3) * 4096; if (!off || off + 5 > buf.length) continue;
      let s;
      try { const len = buf.readUInt32BE(off); s = nbt.simplify((await nbt.parse(zlib.inflateSync(buf.slice(off + 5, off + 4 + len)))).parsed); } catch { continue; }
      const L = s.Level;
      for (const te of (L.TileEntities || [])) {
        if (te.id !== 'Control' || !te.Command) continue;
        // 一条命令里可能是 tp 或 execute ... tp
        const c = te.Command.trim().replace(/^\//, '');
        // 两步传送：板旁的命令方块先给玩家打分，另一个命令方块按分数 tp
        const sm = c.match(/^scoreboard\s+players\s+(?:set|add)\s+(@[parae]\[[^\]]*\])\s+(\S+)\s+(-?\d+)/);
        if (sm) { const se = parseSel(sm[1]); if (se && se.x != null) marks.push({ cmd: [te.x, te.y, te.z], sel: se, obj: sm[2], val: +sm[3] }); }
        const m = c.match(/(?:^|\s)(?:tp|teleport)\s+(@[parae](?:\[[^\]]*\])?)\s+(~?-?[\d.]+)\s+(~?-?[\d.]+)\s+(~?-?[\d.]+)/);
        if (!m) continue;
        const rel = /~/.test(m[2] + m[3] + m[4]);
        const n = (v, b) => v.startsWith('~') ? b + (+v.slice(1) || 0) : +v;
        tps.push({ cmd: [te.x, te.y, te.z], sel: parseSel(m[1]), selRaw: m[1], to: [n(m[2], te.x), n(m[3], te.y), n(m[4], te.z)], rel, text: c.slice(0, 200) });
      }
      // 压力板方块
      for (const sec of (L.Sections || [])) {
        const B = sec.Blocks; if (!B) continue;
        for (let k = 0; k < 4096; k++) {
          const id = B[k] & 0xff; if (!PLATE[id]) continue;
          const y = sec.Y * 16 + (k >> 8), z = L.zPos * 16 + ((k >> 4) & 15), x = L.xPos * 16 + (k & 15);
          plates.push({ p: [x, y, z], kind: PLATE[id] });
        }
      }
    }
  }
  // 配对
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // 粗网格索引压力板
  const G = new Map(); const key = (x, z) => (Math.floor(x / 16)) + ',' + (Math.floor(z / 16));
  for (const pl of plates) { const k = key(pl.p[0], pl.p[2]); (G.get(k) || G.set(k, []).get(k)).push(pl); }
  const near = (p, r) => { const res = []; for (let cx = Math.floor((p[0] - r) / 16); cx <= Math.floor((p[0] + r) / 16); cx++) for (let cz = Math.floor((p[2] - r) / 16); cz <= Math.floor((p[2] + r) / 16); cz++) for (const pl of (G.get(cx + ',' + cz) || [])) if (d3(pl.p, p) <= r) res.push(pl); return res; };
  const pairs = [];
  for (const t of tps) {
    const s = t.sel || {};
    const cond = Object.keys(s).filter(k => !['who', 'x', 'y', 'z', 'r'].includes(k)).map(k => k + '=' + s[k]).join(',');
    let src = [], how;
    if (s.x != null && s.y != null && s.z != null) {
      const r = (s.r != null ? s.r : 1) + 0.9; src = near([s.x, s.y, s.z], r); how = 'selector';
      if (!src.length) how = 'selector-noplate';
    } else {
      // 选择器里的 score_X(_min) 条件是否由某个带坐标的"打分"命令给出
      const objs = Object.keys(s).filter(k => /^score_/.test(k)).map(k => k.replace(/^score_/, '').replace(/_min$/, ''));
      const mk = marks.filter(m => objs.includes(m.obj) && d3(m.cmd, t.cmd) < 64);
      for (const m of mk) for (const q of near([m.sel.x, m.sel.y, m.sel.z], (m.sel.r != null ? m.sel.r : 1) + 0.9)) if (!src.includes(q)) src.push(q);
      if (src.length) how = 'score-mark';
      else { src = near(t.cmd, 8).sort((a, b) => d3(a.p, t.cmd) - d3(b.p, t.cmd)).slice(0, 1); how = src.length ? 'guess-near-cmd' : 'no-plate'; }
    }
    pairs.push({ how, plates: src.map(q => q.p), plateKind: src.map(q => q.kind), selPos: s.x != null ? [s.x, s.y, s.z, s.r] : null, cond, to: t.to, rel: t.rel, cmd: t.cmd, dist: src.length ? Math.round(d3(src[0].p, t.to)) : null, text: t.text });
  }
  fs.writeFileSync(out, JSON.stringify({ t: new Date().toISOString(), nPlates: plates.length, nTp: tps.length, pairs }, null, 0));
  const by = {}; for (const p of pairs) by[p.how] = (by[p.how] || 0) + 1;
  const kinds = {}; for (const p of plates) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
  console.log('压力板总数', plates.length, JSON.stringify(kinds));
  console.log('tp 命令方块', tps.length, '配对方式', JSON.stringify(by));
  console.log('带条件(score/tag等)', pairs.filter(p => p.cond).length, '相对坐标', pairs.filter(p => p.rel).length);
  const plateSet = new Set(pairs.flatMap(p => p.plates.map(q => q.join(','))));
  console.log('有传送的压力板(去重)', plateSet.size);
  console.log('写入', out);
})();
