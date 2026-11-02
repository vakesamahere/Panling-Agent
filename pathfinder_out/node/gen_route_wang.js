'use strict';
// Bake fixed polylines for the 王員外 trip so the bot replays a route instead of running A* every time.
//   node gen_route_wang.js            # default: farm anchor <-> 王員外
//   node gen_route_wang.js A B NAME   # custom, A/B are "x,y,z"
// Writes agent/memory/routes_generated.json (read by agent/src/heuristics/routes.js).
const fs = require('fs'), path = require('path');
const G = require('./graph');
G.load(path.join(__dirname, 'data'), { maxRegions: 60 });
const OUT = 'C:/Users/Administrator/Desktop/vake/mc/agent/memory/routes_generated.json';
const file = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const vec = (s) => s.split(',').map(Number);
const A = process.argv[2] ? vec(process.argv[2]) : [-164, 45, 673]; // 刷怪点 anchor
const W = process.argv[3] ? vec(process.argv[3]) : [-283, 54, 397]; // 王員外
const NA = process.argv[4] || '馬賊刷怪點', NW = process.argv[5] || '王員外';
function bake(from, to, name) {
  const c = G.plan(from, to, { maxNodes: 1500000 });
  if (!c.length) throw new Error('plan failed ' + name + ' ' + c.info.why);
  // 存格子中心（+0.5）和地板高度；act 只用于看，follow 只按折线走
  const pts = c.map((p) => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(2), z: +p.z.toFixed(1) }));
  const acts = {}; for (const p of c) acts[p.act] = (acts[p.act] || 0) + 1;
  file[name] = { from: name.split('->')[0], to: name.split('->')[1], by: 'gmap', at: new Date().toISOString(), sec: Math.round(c.info.cost / 5), pts };
  console.log(name, pts.length, 'pts', JSON.stringify(acts), 'cost', c.info.cost.toFixed(0));
}
bake(A, W, NA + '->' + NW);
bake(W, A, NW + '->' + NA);
fs.writeFileSync(OUT, JSON.stringify(file));
console.log('wrote', OUT, Object.keys(file));
