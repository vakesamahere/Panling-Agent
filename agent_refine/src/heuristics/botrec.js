// 本地 KiroBot 自己跑路录路线：从 A 走到 B（短距离 goto 分段），成功才存进 routes_recorded.json（src:'bot'）
// h.botrec.rec(from, to, waypoints[[x,y,z],...]) → 逐点 goto，每 0.5s 记坐标；任一点失败=整条作废
const fs = require('fs');
module.exports = (bot, h) => {
  const FILE = require('../paths').mem('routes_recorded.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = { state: 'idle', log: [] };
  const log = (m) => { st.log.push(new Date().toTimeString().slice(0, 8) + ' ' + m); if (st.log.length > 40) st.log.shift(); };
  async function rec(from, to, wps, opts = {}) {
    st.state = 'run'; st.key = from + '->' + to;
    const pts = [], t0 = Date.now();
    const push = () => { const p = bot.entity.position; const l = pts[pts.length - 1]; if (!l || Math.hypot(p.x - l.x, p.z - l.z) > 0.8 || Math.abs(p.y - l.y) > 0.6) pts.push({ x: +p.x.toFixed(1), y: Math.round(p.y * 10) / 10, z: +p.z.toFixed(1), t: +((Date.now() - t0) / 1000).toFixed(1), g: bot.entity.onGround ? 1 : 0 }); };
    push();
    const iv = setInterval(push, 500);
    let fails = 0, tps = 0; const onF = () => {}; 
    try {
      for (const w of wps) {
        let ok = false;
        for (let k = 0; k < 3 && !ok; k++) {
          try { await h.goto(w[0], w[1], w[2], w[3] || 1.5, opts.legMs || 30000); const dd = Math.hypot(bot.entity.position.x - w[0], bot.entity.position.z - w[2]); if (dd < 3) ok = true; else { fails++; log('wp ' + w + ' goto returned but d' + dd.toFixed(0)); await sleep(500); } } catch (e) {
            const d = Math.hypot(bot.entity.position.x - w[0], bot.entity.position.z - w[2]);
            if (d < 3) ok = true; else { fails++; log('wp ' + w + ' ' + String(e.message).slice(0, 25) + ' d' + d.toFixed(0)); }
          }
        }
        if (!ok) throw new Error('stuck at wp ' + w.join(','));
      }
      push(); clearInterval(iv);
      // 有大跳跃(>8格瞬移)说明中途被传送/回弹，不存
      for (let i = 1; i < pts.length; i++) if (Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z) > 8) tps++;
      if (tps && !opts.allowTp) throw new Error('teleport/rubberband in trail ' + tps);
      const d = load();
      d[st.key] = { from, to, sec: Math.round((Date.now() - t0) / 1000), src: 'bot', fails, pts };
      if (opts.rev) { const rp = pts.slice().reverse().map((p, i) => ({ ...p, t: i })); d[to + '->' + from] = { from: to, to: from, sec: d[st.key].sec, src: 'bot-rev', fails, pts: rp }; }
      fs.writeFileSync(FILE, JSON.stringify(d, null, 1));
      st.state = 'done'; log('saved ' + st.key + ' ' + pts.length + 'pts ' + d[st.key].sec + 's fails' + fails);
      return { ok: true, key: st.key, n: pts.length, sec: d[st.key].sec, fails };
    } catch (e) {
      clearInterval(iv); bot.pathfinder.stop(); bot.clearControlStates();
      st.state = 'err'; st.err = String(e.message); log('FAIL ' + st.key + ' ' + st.err);
      return { ok: false, key: st.key, err: st.err, n: pts.length };
    }
  }
  return { st, rec, load };
};
