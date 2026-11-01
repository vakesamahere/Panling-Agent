// 地点名表（memory/places.json）：{名字:{x,y,z,src}}。不依赖 bot，可直接 require。
// 由 memory/world.json 旧地点 + 录制路线端点生成；h.places.mark('名字') 把当前位置记成地点。
const fs = require('fs');
const FILE = require('../paths').mem('places.json');

function all() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function get(name) { const p = all()[name]; return p ? { x: p.x, y: p.y, z: p.z } : null; }
// goal: 名字 | [x,y,z] | {x,y,z} -> {x,y,z} | null
function resolve(goal) {
  if (Array.isArray(goal)) return { x: goal[0], y: goal[1], z: goal[2] };
  if (goal && typeof goal === 'object') return { x: goal.x, y: goal.y, z: goal.z };
  return get(goal);
}
function set(name, p, src = 'manual') {
  const P = all(); P[name] = { x: +(+p.x).toFixed(1), y: Math.round(p.y), z: +(+p.z).toFixed(1), src };
  fs.writeFileSync(FILE, JSON.stringify(P, null, 1)); return P[name];
}
module.exports = { FILE, all, get, resolve, set };
