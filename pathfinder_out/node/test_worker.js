'use strict';
const { Worker } = require('worker_threads');
const path = require('path');
const w = require('C:/Users/Administrator/Desktop/vake/mc/agent/memory/world.json').places;
let stalls = [], last = Date.now(), max = 0;
const timer = setInterval(() => { const n = Date.now(), d = n - last; last = n; if (d > 100) { stalls.push(d); max = Math.max(max, d); } }, 25);
const wk = new Worker(path.join(__dirname, 'plan_worker.js'), { workerData: { dir: path.join(__dirname, 'data'), maxRegions: 16 } });
let id = 0; const waiters = new Map();
wk.on('message', (m) => {
  if (m.ready) { console.log('worker ready rss', m.mem, 'MB'); return; }
  const w2 = waiters.get(m.id); waiters.delete(m.id); w2 && w2(m);
});
const call = (from, to) => new Promise((res) => { const i = ++id; waiters.set(i, res); wk.postMessage({ type: 'plan', id: i, from, to, opts: { maxNodes: 1500000 } }); });
(async () => {
  const rows = [];
  for (const [a, b] of [['皇城南門', '馬賊刷怪點'], ['馬賊刷怪點', '皇城南門'], ['皇城南門', '村長'], ['馬賊刷怪點', '錢莊']]) {
    const A = w[a], B = w[b];
    const t = Date.now();
    const r = await call([A.x, A.y, A.z], [B.x, B.y, B.z]);
    rows.push({ pair: a + '→' + b, ms: Date.now() - t, ok: r.ok, n: r.cells && r.cells.length, cost: r.info && r.info.cost && +r.info.cost.toFixed(0) });
  }
  await wk.terminate(); clearInterval(timer);
  console.log(JSON.stringify({ rows, mainThreadStalls: stalls.length, maxStallMs: max }));
})();
