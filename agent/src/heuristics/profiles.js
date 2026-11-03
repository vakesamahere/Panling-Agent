// 刷怪路线档案（profile）：一条路线 = 站桩/巡逻点 + 刷怪籠 + 捡东西规则 + 战利品卖给谁
// memory/farm_profiles.json 里可以放多个档案；当前用哪个记在 memory/farm_profile.txt（看板可切）
// 目的：不同地方刷出来的东西不一样（馬賊营地=王員外货、墓園=怨氣的結晶），
//       所以「路线」和「销售方式」绑在一个档案里，切换档案就整条循环都换掉。
const fs = require('fs');
const P = require('../paths');
const FILE = P.mem('farm_profiles.json'), CUR = P.mem('farm_profile.txt');
const DEFAULT = '馬賊刷怪點';

function all() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function names() { return Object.keys(all()); }
function active() {
  let n = ''; try { n = fs.readFileSync(CUR, 'utf8').trim(); } catch {}
  const A = all();
  if (A[n]) return n;
  if (A[DEFAULT]) return DEFAULT;
  return names()[0] || null;
}
function get(n) { const A = all(); return A[n || active()] || null; }
function setActive(n) { if (!all()[n]) throw new Error('没有这个档案 ' + n); fs.writeFileSync(CUR, n); return n; }
// 给看板用：名字 + 中文标签 + 是否当前
function list() {
  const A = all(), cur = active();
  return Object.keys(A).map((k) => ({ name: k, label: A[k].label || k, kind: A[k].kind || 'camp', active: k === cur }));
}

module.exports = { all, names, active, get, setActive, list, FILE };
