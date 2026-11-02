'use strict';
// Measures main-thread stalls caused by G.plan: a 50ms sampler records gaps > 150ms.
const G = require('./graph');
G.load('./data', { maxRegions: 40 });
const w = require('C:/Users/Administrator/Desktop/vake/mc/agent/memory/world.json').places;
const pairs = [['皇城南門','馬賊刷怪點'],['馬賊刷怪點','皇城南門'],['皇城南門','村長'],['馬賊刷怪點','錢莊'],['村長','古董收藏家'],['皇城南門','錢莊']];
let last = Date.now(), stalls = [], max = 0;
const timer = setInterval(() => { const now = Date.now(), d = now - last; last = now; if (d > 150) { stalls.push(d); max = Math.max(max, d); } }, 50);
(async () => {
  const rows = [];
  for (const [a, b] of pairs) {
    const A = w[a], B = w[b];
    const t = Date.now();
    const c = G.plan([A.x, A.y, A.z], [B.x, B.y, B.z], { maxNodes: 1500000 });
    rows.push({ pair: a + '→' + b, planMs: Date.now() - t, exp: c.info.expanded });
    await new Promise(r => setTimeout(r, 200));
  }
  clearInterval(timer);
  console.log(JSON.stringify({ rows, stalls: stalls.length, maxStallMs: max, planSumMs: rows.reduce((s, r) => s + r.planMs, 0) }, null, 1));
})();
