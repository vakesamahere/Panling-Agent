'use strict';
const G = require('./graph');
G.load('./data', { maxRegions: 40 });
const w = require('C:/Users/Administrator/Desktop/vake/mc/agent/memory/world.json').places;
const pairs = [['皇城南門','馬賊刷怪點'],['馬賊刷怪點','皇城南門'],['皇城南門','村長'],['村長','皇城南門'],['皇城南門','錢莊'],['皇城南門','古董收藏家'],['皇城南門','元素回收員'],['馬賊刷怪點','錢莊'],['村長','古董收藏家'],['皇城南門','人族出生點']];
const rows = [];
for (const [a, b] of pairs) {
  const A = w[a], B = w[b]; if (!A || !B) continue;
  const t = Date.now();
  const cells = G.plan([A.x, A.y, A.z], [B.x, B.y, B.z], { maxNodes: 1500000 });
  const ms = Date.now() - t;
  const i = cells.info || {};
  rows.push({ pair: a + '→' + b, ms, expanded: i.expanded, len: i.length && +i.length.toFixed(0), cost: i.cost && +i.cost.toFixed(0), ok: cells.length > 0 });
  console.log(rows[rows.length - 1]);
}
const tot = rows.reduce((s, r) => s + r.ms, 0), ex = rows.reduce((s, r) => s + (r.expanded || 0), 0);
console.log(JSON.stringify({ totalMs: tot, totalExpanded: ex, maxMs: Math.max(...rows.map(r => r.ms)) }));
