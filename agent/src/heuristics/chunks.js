// 区块记忆：按 16x16 区块记录"好不好走 / 怪多不多 / 有什么"，复用到下次规划。
// 存 memory/chunks.json：{ "cx,cz": { visits, walkOk, walkFail, stuck, mobs:{name:n}, kills, deaths, loot:{item:n}, tags:[], biome, yMin, yMax, last } }
// 自动采集：
//   - 每 2s 记录 bot 所在区块的 visit、y 范围、周围敌对怪种类计数
//   - h.travel 走通的步行段 → walkOk++，失败/卡住 → walkFail++/stuck++（travel.js 调 h.chunks.walk）
//   - 击杀 / 死亡 / 拾取 → kills / deaths / loot
// 合并：相邻且标签/难度相同的区块在 h.chunks.regions() 里合成一个区域输出（只读视图，不改原数据）。
const fs = require('fs');
const path = require('path');
const FILE = require('../paths').mem('chunks.json');

module.exports = function chunks(bot, h) {
  let db = {};
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  let dirty = false;
  const save = () => { if (!dirty) return; fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); dirty = false; };
  setInterval(save, 15000);

  const key = (x, z) => (Math.floor(x) >> 4) + ',' + (Math.floor(z) >> 4);
  const get = (x, z) => {
    const k = key(x, z);
    return db[k] || (db[k] = { visits: 0, walkOk: 0, walkFail: 0, stuck: 0, mobs: {}, kills: 0, deaths: 0, loot: {}, tags: [], last: 0 });
  };
  const HOSTILE = /zombie|skeleton|spider|creeper|witch|blaze|enderman|slime|magma|ghast|pig_?zombie|silverfish|cave_spider|guardian|endermite/i;
  const mobName = (e) => {
    const cn = e.metadata && typeof e.metadata[2] === 'string' ? e.metadata[2].replace(/§./g, '') : '';
    return cn || e.name || e.mobType || 'mob';
  };

  // 周期采样
  const seen = new Set(); // 已计数的实体 id，避免同一只怪反复计数
  setInterval(() => {
    if (!bot.entity) return;
    const p = bot.entity.position;
    const c = get(p.x, p.z);
    c.visits++; c.last = Date.now(); dirty = true;
    c.yMin = Math.min(c.yMin ?? 999, Math.floor(p.y)); c.yMax = Math.max(c.yMax ?? -999, Math.floor(p.y));
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.position || seen.has(e.id)) continue;
      if (e.type !== 'mob' && !HOSTILE.test(e.name || '')) continue;
      if (!HOSTILE.test(e.name || '')) continue;
      if (e.position.distanceTo(p) > 24) continue;
      seen.add(e.id);
      const cc = get(e.position.x, e.position.z);
      const n = mobName(e);
      cc.mobs[n] = (cc.mobs[n] || 0) + 1;
    }
    if (seen.size > 5000) seen.clear();
  }, 2000);

  // 死亡 / 击杀 / 拾取
  let lastPos = null;
  bot.on('move', () => { if (bot.entity) lastPos = bot.entity.position.clone(); });
  bot.on('death', () => { if (lastPos) { get(lastPos.x, lastPos.z).deaths++; dirty = true; } });
  bot.on('entityDead', (e) => {
    if (!bot.entity || !e.position || !HOSTILE.test(e.name || '')) return;
    if (e.position.distanceTo(bot.entity.position) > 30) return;
    get(e.position.x, e.position.z).kills++; dirty = true;
  });
  bot.on('playerCollect', (collector, item) => {
    if (collector !== bot.entity) return;
    let name = 'item';
    try { const it = item.getDroppedItem && item.getDroppedItem(); if (it) name = (it.customName || it.displayName || it.name || '').replace(/§./g, '') + (it.name ? '' : ''); } catch {}
    const p = bot.entity.position; const c = get(p.x, p.z);
    c.loot[name] = (c.loot[name] || 0) + 1; dirty = true;
  });

  // 评分：越大越不好走/越危险
  const walkScore = (c) => (c.walkFail + 2 * c.stuck + 1) / (c.walkOk + 1);
  const mobCount = (c) => Object.values(c.mobs).reduce((a, b) => a + b, 0);
  const grade = (c) => {
    const w = walkScore(c), m = mobCount(c);
    return {
      walk: c.stuck >= 2 || w > 3 ? 'bad' : w > 1.5 ? 'meh' : (c.walkOk ? 'good' : '?'),
      mobs: m >= 15 ? 'many' : m >= 4 ? 'some' : m ? 'few' : 'none',
      danger: c.deaths >= 2 ? 'high' : c.deaths ? 'mid' : 'low',
    };
  };

  const api = {
    db,
    get: (x, z) => get(x, z),
    here: () => { const p = bot.entity.position; const c = get(p.x, p.z); return { chunk: key(p.x, p.z), ...grade(c), ...c }; },
    // travel 回报一段步行结果；pts=该段经过的点（至少起终点）
    walk(pts, ok, stuckAt) {
      for (const p of pts) { const c = get(p.x, p.z); if (ok) c.walkOk++; else c.walkFail++; }
      if (stuckAt) get(stuckAt.x, stuckAt.z).stuck++;
      dirty = true;
    },
    tag(t, x, z) { const p = x === undefined ? bot.entity.position : { x, z }; const c = get(p.x, p.z); if (!c.tags.includes(t)) c.tags.push(t); dirty = true; return c.tags; },
    note(text, x, z) { const p = x === undefined ? bot.entity.position : { x, z }; get(p.x, p.z).note = text; dirty = true; },
    // 规划代价倍率：难走的区块绕开（travel.js walkCost 用）
    costMul(x, z) { const c = db[key(x, z)]; if (!c) return 1; const g = grade(c); return g.walk === 'bad' ? 4 : g.walk === 'meh' ? 1.8 : 1; },
    // 合并视图：4 邻接 & 评级与标签都相同的区块合成一个区域
    regions(filter) {
      const keys = Object.keys(db); const sig = {};
      for (const k of keys) { const c = db[k]; const g = grade(c); sig[k] = [g.walk, g.mobs, g.danger, c.tags.slice().sort().join('+')].join('|'); }
      const done = new Set(); const out = [];
      for (const k of keys) {
        if (done.has(k)) continue;
        const s = sig[k]; const q = [k]; const mem = []; done.add(k);
        while (q.length) {
          const u = q.pop(); mem.push(u); const [cx, cz] = u.split(',').map(Number);
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const v = (cx + dx) + ',' + (cz + dz); if (!done.has(v) && sig[v] === s) { done.add(v); q.push(v); } }
        }
        const xs = mem.map((m) => +m.split(',')[0]), zs = mem.map((m) => +m.split(',')[1]);
        const agg = { mobs: {}, loot: {}, kills: 0, deaths: 0 };
        for (const m of mem) { const c = db[m]; agg.kills += c.kills; agg.deaths += c.deaths; for (const [n, v] of Object.entries(c.mobs)) agg.mobs[n] = (agg.mobs[n] || 0) + v; for (const [n, v] of Object.entries(c.loot)) agg.loot[n] = (agg.loot[n] || 0) + v; }
        const [walk, mobs, danger, tags] = s.split('|');
        const r = { box: [Math.min(...xs) * 16, Math.min(...zs) * 16, Math.max(...xs) * 16 + 15, Math.max(...zs) * 16 + 15], chunks: mem.length, walk, mobs, danger, tags, ...agg };
        if (!filter || filter(r)) out.push(r);
      }
      return out.sort((a, b) => b.chunks - a.chunks);
    },
    save: () => { dirty = true; save(); },
  };
  return api;
};
