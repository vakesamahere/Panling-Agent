// 录制路线回放（memory/routes_recorded.json，由 recorder.js 录用户实走轨迹）
// h.routes.follow(key|pts) 纯追踪沿折线走；h.routes.travel(goal) 选最佳子路段再交给旧 h.travel 收尾。
const fs = require('fs');
const { Vec3 } = require('vec3');
const FILE = require('../paths').mem('routes_recorded.json');
const GEN = require('../paths').mem('routes_generated.json');

module.exports = (bot, h) => {
  const st = { log: [], last: null };
  // adapt：按速度放大 lookahead / 推进窗口，急弯前减速（松冲刺、换下加速物）。false = 旧行为（固定 2.5）
  const cfg = { adapt: true, slowCorner: false, cornerDeg: 60, cornerDist: 3 }; // slowCorner：实测没有掉头，默认不减速（减速会慢 5-50%）
  const log = (s) => { st.log.push(new Date().toTimeString().slice(0, 8) + ' ' + s); if (st.log.length > 40) st.log.shift(); };
  const pos = () => bot.entity.position;
  const hd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
  // 离线烘好的固定路线（memory/routes_generated.json，由 pathfinder_out/node/gen_route_*.js 生成）：
  // 和录制的路线同格式，录制版优先（人走的路更靠中心、更顺）
  function loadGen() { try { return JSON.parse(fs.readFileSync(GEN, 'utf8')); } catch { return {}; } }
  function all() { return Object.assign({}, loadGen(), load()); }
  // 拆成腿：相邻点水平 >8 视为传送（前一腿最后一点=压力板）
  function legsOf(pts) {
    const legs = [[pts[0]]];
    for (let i = 1; i < pts.length; i++) {
      if (hd(pts[i], pts[i - 1]) > 8) legs.push([]);
      legs[legs.length - 1].push(pts[i]);
    }
    return legs;
  }
  // 所有可用折线：正向整条（可跨传送）；反向只用不含传送的腿（传送不可逆）
  function lines() {
    const d = all(), out = [];
    for (const [k, v] of Object.entries(d)) {
      out.push({ key: k, pts: v.pts });
      const rk = v.to + '->' + v.from;
      if (!d[rk]) for (const leg of legsOf(v.pts)) if (leg.length > 3) out.push({ key: k + '(rev)', pts: leg.slice().reverse() });
    }
    return out;
  }
  function places() {
    const d = all(), p = {};
    for (const v of Object.values(d)) { const a = v.pts[0], b = v.pts[v.pts.length - 1]; p[v.from] = p[v.from] || a; p[v.to] = p[v.to] || b; }
    return p;
  }
  function resolve(goal) {
    if (typeof goal === 'object' && goal) return goal;
    const mem = h.mem && h.mem.data || {};
    if (mem.places && mem.places[goal]) return mem.places[goal];
    if (mem.routes && mem.routes[goal]) { const r = mem.routes[goal]; return r[r.length - 1]; }
    return places()[goal] || null;
  }
  // 选一段：起点离我 ≤joinR(默认40)，按 接入距离+剩余距离 最小；要比现在近 15 格以上
  function bestSegment(P, T, joinR = 40) {
    let best = null;
    const d0 = hd(P, T) + Math.abs(P.y - T.y);
    for (const L of lines()) {
      const p = L.pts;
      let i = -1, di = joinR;
      for (let k = 0; k < p.length; k++) { const d = hd(P, p[k]) + Math.abs(P.y - p[k].y) * 0.5; if (d < di) { di = d; i = k; } }
      if (i < 0) continue;
      let j = -1, dj = Infinity;
      for (let k = i + 1; k < p.length; k++) { const d = hd(p[k], T) + Math.abs(p[k].y - T.y); if (d < dj) { dj = d; j = k; } }
      if (j < 0 || dj > d0 - 15) continue;
      const c = di + dj;
      if (!best || c < best.c - 1) best = { key: L.key, pts: p.slice(i, j + 1), dj, di, c };
    }
    return best;
  }

  const FREE = /stairs|slab|step|carpet|snow_layer|plate|rail|torch|sign|flower|grass$|tallgrass|button|lever|ladder|vine/;
  function shouldJump(t) {
    const p = pos();
    let dx = t.x - p.x, dz = t.z - p.z; const n = Math.hypot(dx, dz) || 1; dx /= n; dz /= n;
    for (const a of [0.55, 0.95]) {
      const fx = Math.floor(p.x + dx * a), fz = Math.floor(p.z + dz * a), fy = Math.floor(p.y + 0.05);
      const b = bot.blockAt(new Vec3(fx, fy, fz)); if (!b || b.boundingBox !== 'block' || FREE.test(b.name)) continue;
      const top = Math.max(...(b.shapes || [[0, 0, 0, 1, 1, 1]]).map((s) => s[4]));
      if (top <= 0.6) continue;
      const u1 = bot.blockAt(new Vec3(fx, fy + 1, fz)), u2 = bot.blockAt(new Vec3(fx, fy + 2, fz));
      if ((!u1 || u1.boundingBox === 'empty') && (!u2 || u2.boundingBox === 'empty')) return true;
    }
    return false;
  }
  const hostileNear = (r) => Object.values(bot.entities).some((e) => e.type === 'mob' && !/Villager|Pig|Cow|Sheep|Chicken|Horse|Bat|Squid|Wolf|Ocelot|Rabbit/.test(e.name) && e.position.distanceTo(pos()) < r);

  // 前方 dist 格内折线最大转角（度）：比较每个点前后 1.5 格的方向
  function cornerAhead(leg, idx, P, dist) {
    const dir = (a, b) => Math.atan2(b.z - a.z, b.x - a.x);
    let mx = 0;
    for (let k = idx + 1; k < leg.length - 1 && hd(P, leg[k]) < dist; k++) {
      let a = k - 1; while (a > 0 && hd(leg[a], leg[k]) < 1.5) a--;
      let b = k + 1; while (b < leg.length - 1 && hd(leg[b], leg[k]) < 1.5) b++;
      if (hd(leg[a], leg[k]) < 0.5 || hd(leg[b], leg[k]) < 0.5) continue;
      let d = Math.abs(dir(leg[k], leg[b]) - dir(leg[a], leg[k])) * 180 / Math.PI; if (d > 180) d = 360 - d;
      if (d > mx) mx = d;
    }
    return mx;
  }
  // 纯追踪：盯前方 lookahead 格，只向前推进索引；传送腿尾踩板等传送
  async function follow(src, opts = {}) {
    const pts = Array.isArray(src) ? src : (all()[src] || {}).pts;
    if (!pts || pts.length < 2) return { ok: false, err: 'no-route' };
    const legs = legsOf(pts);
    const t0 = Date.now(), res = { ok: false, setbacks: 0, stalls: 0, fallbacks: 0, tps: 0, legs: legs.length };
    const onForced = () => { res.setbacks++; };
    bot.on('forcedMove', onForced);
    const ctl = (k, v) => bot.setControlState(k, v);
    const stop = () => { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) ctl(k, false); };
    const look = (t) => bot.lookAt(new Vec3(t.x, pos().y + 1.6, t.z), true).catch(() => {});
    try {
      if (bot.pathfinder) bot.pathfinder.stop();
      for (let li = 0; li < legs.length; li++) {
        const leg = legs[li], last = li < legs.length - 1; // last=该腿尾是传送板
        // 起始索引：第一条腿允许从离我最近的点接上（战斗打断后重试不用走回头路）；后续腿必须从头走
        let idx = 0;
        if (li === 0) {
          let bi = 0, bd = Infinity;
          for (let k = 0; k < leg.length; k++) { const d = hd(pos(), leg[k]) + Math.abs(pos().y - leg[k].y) * 0.5; if (d < bd) { bd = d; bi = k; } }
          if (bd < 8 && bi >= leg.length - 3) idx = leg.length - 1; // 已经在这条腿终点（比如反向任务）：直接算走完
          else if (bd < 40 && bi < leg.length - 2) { idx = bi; res.joined = bi; }
        }
        let lastProg = Date.now(), lastIdx = idx, lastP = pos().clone(), sameStalls = 0;
        // 先接上：离接入点远就 goto
        if (hd(pos(), leg[idx]) > 3) {
          const far = false; // 不再用旧寻路接入
          try { if (far) await h._travelOrig(leg[idx].x, leg[idx].y, leg[idx].z, { range: 2 }); else await h.goto(leg[idx].x, leg[idx].y, leg[idx].z, 1.5, 10000); } catch { res.fallbacks++; }
          if (hd(pos(), leg[idx]) > 6) log('join far ' + Math.round(hd(pos(), leg[idx])) + ', follow anyway');
        }
        const deadline = Date.now() + Math.max(90000, leg.length * 1500);
        while (true) {
          if (opts.abort && opts.abort()) throw new Error('aborted');
          if (Date.now() > deadline) throw new Error('route-timeout leg' + li + ' #' + idx);
          h.driveUntil = Date.now() + 1000;
          const P = pos();
          // 传送检测放最前：传送后离本腿很远，不能当成"偏离"去 goto 回去
          if (last) {
            const nx = legs[li + 1][0];
            if (hd(P, nx) < 12) { res.tps++; stop(); log('tp leg' + li + '→' + (li + 1)); await sleep(600); break; }
          }
          if (hd(P, leg[Math.min(idx, leg.length - 1)]) > 60) throw new Error('teleported-away leg' + li + ' at ' + P.floored());
          const sp = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z); // 格/tick，普通走 0.1 冲刺 0.13，加速物 0.3+
          // 推进：在 idx..idx+W 里取离我最近的点（高速时窗口放大，免得冲过一段后索引跟不上）
          const W = cfg.adapt ? Math.round(Math.min(30, Math.max(12, sp * 60))) : 12;
          let bi = idx, bd = hd(P, leg[idx]);
          for (let k = idx + 1; k < Math.min(leg.length, idx + W); k++) { const d = hd(P, leg[k]); if (d <= bd + 0.3) { bd = d; bi = k; } }
          idx = bi; st.idx = idx; st.li = li; st.off = bd;
          const end = leg[leg.length - 1];
          if (!last && idx >= leg.length - 2 && hd(P, end) < 1.2 && Math.abs(P.y - end.y) < 2) break;
          // 偏离太远：goto 回到前方点
          if (bd > 6) {
            stop(); res.fallbacks++;
            const k = Math.min(leg.length - 1, idx + 3);
            try { await h.goto(leg[k].x, leg[k].y, leg[k].z, 1.5, 9000); } catch (e) { log('regain fail ' + String(e.message).slice(0, 30)); }
            lastProg = Date.now(); continue;
          }
          // lookahead 点
          const la = opts.lookahead || (cfg.adapt ? Math.min(4.5, Math.max(2.5, sp * 12)) : 2.5);
          let t = end;
          for (let k = idx + 1; k < leg.length; k++) if (hd(P, leg[k]) >= la) { t = leg[k]; break; }
          if (last && idx >= leg.length - 3) t = end; // 传送板：直奔板中心
          await look(t);
          ctl('forward', true);
          // 冲刺：前方 6 点基本直且平
          const f = leg[Math.min(leg.length - 1, idx + 6)];
          let slow = false;
          if (cfg.adapt && cfg.slowCorner) { // 前方 cornerDist+速度 格内有急弯 → 减速
            const turn = cornerAhead(leg, idx, P, cfg.cornerDist + sp * 20);
            slow = turn > cfg.cornerDeg || (last && idx >= leg.length - 8);
          }
          if (h.speed) h.speed.hold(slow); // 走路手持加速物（adapt 关时也持，不减速）
          ctl('sprint', !slow && (!last || idx < leg.length - 6) ? (hd(P, f) > 4.5 && Math.abs(f.y - P.y) < 1.5) : false);
          // 水里：一直按住跳+前，才能蹭上高半格的岸
          ctl('jump', bot.entity.isInWater || shouldJump(t) || (bot.entity.isCollidedHorizontally && bot.entity.onGround && t.y > P.y + 0.4));
          // 进度/卡住
          if (idx > lastIdx || hd(P, lastP) > 0.8) { lastIdx = idx; lastP = P.clone(); lastProg = Date.now(); sameStalls = 0; }
          else if (Date.now() - lastProg > (last && idx >= leg.length - 3 ? 2500 : 1500)) {
            res.stalls++; sameStalls++; stop(); log('stall leg' + li + ' #' + idx + ' n' + sameStalls);
            // 已经在整条路的终点附近：终点格可能是 NPC 围栏边的不可走格，卡住不等于没到
            if (hd(P, pts[pts.length - 1]) < 7) { log('near-end accept ' + Math.round(hd(P, pts[pts.length - 1]) * 10) / 10); idx = leg.length - 1; break; }
            if (hostileNear(5) && h.combat) {
              const was = h.combat.state().on; if (!was) h.combat.start();
              for (let w = 0; w < 16 && hostileNear(5); w++) await sleep(500);
              if (!was) h.combat.stop(); stop();
            } else if (bot.entity.isInWater) {
              await look(t); ctl('forward', true); ctl('jump', true); await sleep(1200); ctl('jump', false);
            } else if (last && idx >= leg.length - 8) {
              const pl = leg[leg.length - 1];
              try { await h.goto(pl.x, pl.y, pl.z, 0, 8000); } catch (e) { log('plate goto ' + String(e.message).slice(0, 30)); }
              await look(pl); ctl('forward', true); await sleep(600); ctl('forward', false);
              if (sameStalls > 5) throw new Error('plate-stuck leg' + li);
            } else if (sameStalls <= 2) {
              ctl('back', true); await sleep(450); ctl('back', false); await sleep(sameStalls === 1 ? 400 : 900);
              ctl('forward', true); ctl('jump', true); await sleep(350); ctl('jump', false);
            } else {
              res.fallbacks++;
              const k = Math.min(leg.length - 1, idx + 4);
              try { await h.goto(leg[k].x, leg[k].y, leg[k].z, last && k === leg.length - 1 ? 0.3 : 1.2, 9000); } catch (e) { log('fb fail ' + String(e.message).slice(0, 30)); }
              if (sameStalls > 6) throw new Error('route-stuck leg' + li + ' #' + idx);
            }
            lastProg = Date.now(); lastP = pos().clone();
          }
          await new Promise((r) => { const t = setTimeout(() => { bot.removeListener('physicsTick', f); r(); }, 250); const f = () => { clearTimeout(t); r(); }; bot.once('physicsTick', f); }); // 区块没到时 physicsTick 不触发，不能死等
        }
      }
      res.ok = true;
    } catch (e) { res.err = String(e.message || e); log('ERR ' + res.err); }
    finally { stop(); bot.removeListener('forcedMove', onForced); }
    res.sec = Math.round((Date.now() - t0) / 1000);
    st.last = res; return res;
  }

  // 用录制路线尽量靠近目标，再交给旧 travel 收尾
  async function travel(goal, ...rest) {
    const orig = h._travelOrig;
    const T = typeof goal === 'number' ? { x: goal, y: rest[0], z: rest[1] } : resolve(goal);
    const segs = [];
    if (T) {
      for (let n = 0; n < 4; n++) {
        const s = bestSegment(pos(), T); if (!s) break;
        log('seg ' + s.key + ' ' + s.pts.length + 'pts rem ' + Math.round(s.dj));
        const r = await follow(s.pts); segs.push({ key: s.key, ok: r.ok, sec: r.sec, setbacks: r.setbacks, stalls: r.stalls, fb: r.fallbacks, err: r.err });
        if (!r.ok) break;
      }
    }
    const done = T && hd(pos(), T) < 3 && Math.abs(pos().y - T.y) < 3;
    // 不再 fallback 到旧寻路：录好的路走不到就报失败，由上层（h.home 自杀回奈何桥）处理
    const r = done ? { ok: true, pos: pos().floored() } : { ok: false, err: 'no-recorded-route', pos: pos().floored() };
    if (segs.length) r.segs = segs;
    return r;
  }

  return { st, cfg, cornerAhead, load, loadGen, all, legsOf, lines, places, resolve, bestSegment, follow, travel, list: () => Object.entries(all()).map(([k, v]) => k + ' ' + v.pts.length + 'pts ' + v.sec + 's') };
};
