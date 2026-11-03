// 捡东西：屋外 A 逻辑 / 屋内 B 逻辑（冲进去捡完马上出来）
// 屋内：屋里没怪 + 用 pathfinder 算来回时间 T + 按刷怪间隔记录估计 T 内刷怪概率 < 阈值 才进；进去时记录撤退路线。
const { Vec3 } = require('vec3');
const fs = require('fs'), path = require('path');
module.exports = (bot, h, farm) => {
  const { cfg, st, log } = farm;
  const SPF = require('../paths').mem('spawns_' + (process.env.ONLINE ? 'online' : 'local') + '.json');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const me = () => bot.entity.position;
  const hd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const isMob = (e) => e && e.type === 'mob' && /Skeleton|Zombie|Spider|Creeper|Blaze|PigZombie|LavaSlime|Witch/.test(e.name || '');
  const isDrop = (e) => e && e.type === 'object' && /^item$/i.test(e.name || '') && e.isValid !== false;
  const mobs = () => Object.values(bot.entities).filter(isMob);
  const L = {
    cfg: { houses: [], walkSpd: 4.0, pPick: 0.15, outMobR: 7, meMobR: 7, lootLeash: 22, maxTrip: 25, pSpawnMax: 0.25,
      outMobRFree: 4, meMobRFree: 3, dangerRFree: 3.5 },
    gaps: {}, last: {}, firstSeen: new Map(), stats: { inTrips: 0, inOk: 0, inAborts: 0, outTrips: 0, outOk: 0, skipped: {} },
  };
  try { L.gaps = JSON.parse(fs.readFileSync(SPF, 'utf8')); } catch {}
  const saveGaps = () => { try { fs.writeFileSync(SPF, JSON.stringify(L.gaps)); } catch {} };
  const onSpawn = (e) => {
    if (isDrop(e)) L.firstSeen.set(e.id, Date.now());
    if (!isMob(e)) return;
    for (const sp of cfg.spawners || []) {
      if (hd(e.position, sp) < 3 && Math.abs(e.position.y - sp.y) < 4) {
        const now = Date.now(), last = L.last[sp.k];
        if (last && now - last > 2000) {
          const g = (L.gaps[sp.k] = L.gaps[sp.k] || []);
          g.push(+((now - last) / 1000).toFixed(1)); if (g.length > 60) g.shift(); saveGaps();
        }
        if (!last || now - last > 2000) L.last[sp.k] = now;
      }
    }
  };
  const onGone = (e) => L.firstSeen.delete(e.id);
  bot.on('entitySpawn', onSpawn); bot.on('entityGone', onGone);
  L.dispose = () => { bot.removeListener('entitySpawn', onSpawn); bot.removeListener('entityGone', onGone); };

  // 刷出点在 T 秒内刷怪的概率：经验分布条件概率 P(gap<=e+T | gap>e)；数据不够用 1.8 原版 U(10,40)s
  function pSpawn(sp, T) {
    const e = L.last[sp.k] ? (Date.now() - L.last[sp.k]) / 1000 : (Date.now() - (st.since || Date.now())) / 1000;
    const all = L.gaps[sp.k] || [];
    const g = all.filter((x) => x > e);
    if (g.length >= 4) return g.filter((x) => x <= e + T).length / g.length;
    // 样本不够 / 已超过观测到的间隔：按平均间隔做无记忆（指数）估计 P=1-exp(-T/mean)，最低间隔前不会刷
    const mean = all.length >= 2 ? all.reduce((a, x) => a + x, 0) / all.length : 30;
    const lo = all.length >= 2 ? Math.min(...all) : 10;
    const wait = Math.max(0, lo - e);
    return T <= wait ? 0 : 1 - Math.exp(-(T - wait) / mean);
  }
  const inBox = (p, b) => p.x >= b[0] && p.x <= b[1] + 1 && p.z >= b[2] && p.z <= b[3] + 1 && p.y > 42 && p.y < 49;
  const houseOf = (p) => L.cfg.houses.find((ho) => inBox(p, ho.box));

  // pathfinder 实算路径长度（不走）
  function pathLen(to) {
    try {
      const { goals } = require('mineflayer-pathfinder');
      const r = bot.pathfinder.getPathTo(bot.pathfinder.movements, new goals.GoalNear(to.x, to.y, to.z, 0.8), 400);
      if (!r || r.status !== 'success' || !r.path || !r.path.length) return null;
      let len = 0, prev = me();
      for (const n of r.path) { len += prev.distanceTo(n); prev = n; }
      return len;
    } catch { return null; }
  }
  // 地上掉落物（站桩点附近；自由打怪时按自己位置算，否则沿巡逻点走远了就看不到东西）
  function drops() {
    const a = cfg.anchor;
    return Object.values(bot.entities).filter((e) => isDrop(e) && (cfg.freeRoam ? e.position.distanceTo(me()) < (L.cfg.lootLeash || 20) : hd(e.position, a) < L.cfg.lootLeash) && e.position.y > me().y - 6)
      .map((e) => ({ e, ho: houseOf(e.position), age: (Date.now() - (L.firstSeen.get(e.id) || Date.now())) / 1000 }));
  }
  const skip = (w) => { L.stats.skipped[w] = (L.stats.skipped[w] || 0) + 1; st.whyNo = w; return false; };
  const goto = async (p, r, ms) => { try { await h.goto(p.x, p.y, p.z, r, ms); return true; } catch { return false; } };
  const backTo = async () => { if (cfg.freeRoam) return; for (let k = 0; k < 3 && hd(me(), cfg.anchor) > 2; k++) await goto(cfg.anchor, 1, 8000); };
  const mid = (p, q) => ({ x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 });
  const invCount = () => bot.inventory.items().reduce((a, i) => a + i.count, 0);

  // 走到掉落物上（这服要踩上去）；danger() 为真立刻停
  async function stepTo(t, danger) {
    const { goals } = require('mineflayer-pathfinder');
    bot.pathfinder.setGoal(new goals.GoalNear(t.position.x, t.position.y, t.position.z, 0.3));
    const t0 = Date.now();
    while (Date.now() - t0 < 7000 && bot.entities[t.id]) {
      if (danger()) { bot.pathfinder.stop(); bot.clearControlStates(); return 'mob'; }
      if (hd(me(), t.position) < 0.6) break;
      if (!bot.pathfinder.isMoving() && Date.now() - t0 > 600) {
        bot.pathfinder.stop();
        await bot.lookAt(t.position.offset(0, 1.6, 0), true).catch(() => {});
        bot.setControlState('forward', true); await sleep(150); bot.setControlState('forward', false);
      }
      await sleep(100);
    }
    bot.pathfinder.stop(); bot.clearControlStates();
    for (let k = 0; k < 5 && bot.entities[t.id] && hd(me(), t.position) > 0.3 && !danger(); k++) {
      await bot.lookAt(t.position.offset(0, 1.6, 0), true).catch(() => {});
      bot.setControlState('forward', true); await sleep(120); bot.setControlState('forward', false);
    }
    return bot.entities[t.id] ? 'left' : 'ok';
  }
  function nearestOut(r) {
    let b = null, bd = r;
    for (const d of drops()) if (!d.ho) { const x = d.e.position.distanceTo(me()); if (x < bd) { bd = x; b = d.e; } }
    return b;
  }

  // —— 屋外 A：附近没怪就去捡，路上怪靠近 8 格就停下交给战斗层 ——
  // 自由打怪（墓园 42 个刷怪籠）怪永远清不完：要求半径放小（只躲 3 格内贴脸的），否则永远 A:mob-near-me 不捡东西
  async function outside(list) {
    const R = cfg.freeRoam ? (L.cfg.meMobRFree || 3) : L.cfg.meMobR;
    const RD = cfg.freeRoam ? (L.cfg.outMobRFree || 4) : L.cfg.outMobR;
    const ms = mobs();
    if (ms.some((m) => m.position.distanceTo(me()) < R)) return skip('A:mob-near-me');
    const t = h.combat.state().target;
    if (t && t.d < (cfg.freeRoam ? 6 : 16)) return skip('A:fighting');
    const ok = list.filter((d) => !ms.some((m) => hd(m.position, d.e.position) < RD || hd(m.position, mid(me(), d.e.position)) < RD - 1));
    if (!ok.length) return skip('A:mob-at-drop');
    for (let i = ok.length - 1; i >= 0; i--) {
      const q = ok[i].e.position, T = (2 * q.distanceTo(me())) / L.cfg.walkSpd + 1.5;
      if ((cfg.spawners || []).some((sp) => hd(q, sp) < 4 && pSpawn(sp, T) > L.cfg.pSpawnMax)) ok.splice(i, 1);
    }
    if (!ok.length) return skip('A:near-spawn');
    ok.sort((x, y) => (x.e.position.distanceTo(me()) - x.age / 30) - (y.e.position.distanceTo(me()) - y.age / 30));
    L.stats.outTrips++; st.mode = 'A';
    const inv0 = invCount();
    const danger = () => mobs().some((m) => m.position.distanceTo(me()) < (cfg.freeRoam ? (L.cfg.dangerRFree || 3.5) : 8));
    let tgt = ok[0].e;
    for (let n = 0; tgt && n < 8; n++) {
      const r = await stepTo(tgt, danger);
      if (r === 'mob') { log('A abort mob'); break; }
      tgt = nearestOut(4);
    }
    st.mode = '';
    if (invCount() > inv0) { L.stats.outOk++; st.picked += invCount() - inv0; }
    if (!danger()) await backTo();
    return true;
  }

  // —— 屋内 B：屋里没怪 + 刷怪概率低才冲进去，捡完沿进来的路线倒着跑出来 ——
  async function inside(ho, list) {
    const ms = mobs();
    if (ms.some((m) => inBox(m.position, ho.box))) return skip('B:' + ho.k + ':mob-inside');
    if (ms.some((m) => hd(m.position, ho.door) < 6)) return skip('B:' + ho.k + ':mob-at-door');
    if (ms.some((m) => m.position.distanceTo(me()) < L.cfg.meMobR)) return skip('B:mob-near-me');
    if (bot.health < cfg.okHp) return skip('B:hp');
    list.sort((x, y) => x.e.position.distanceTo(me()) - y.e.position.distanceTo(me()));
    const first = list[0].e;
    const len = pathLen(first.position);
    if (len == null) return skip('B:' + ho.k + ':no-path');
    const T = (2 * len) / L.cfg.walkSpd + 0.8 * list.length + 1.5;
    if (T > L.cfg.maxTrip) return skip('B:too-long ' + T.toFixed(0));
    const rel = (cfg.spawners || []).filter((sp) => ho.sp.includes(sp.k));
    let pNone = 1; const ps = [];
    for (const sp of rel) { const p = pSpawn(sp, T); ps.push(sp.k + Math.round(p * 100)); pNone *= 1 - p; }
    const pAny = 1 - pNone;
    // 想捡程度：东西越多、越老（5 分钟消失）越愿意冒险
    const oldest = Math.max(...list.map((d) => d.age));
    const thr = Math.min(0.4, L.cfg.pPick + 0.02 * Math.min(10, list.length) + (oldest > 200 ? 0.1 : 0));
    st.lastB = { k: ho.k, T: +T.toFixed(1), p: +pAny.toFixed(2), thr: +thr.toFixed(2), ps: ps.join(',') };
    if (pAny > thr) return skip('B:' + ho.k + ':p' + Math.round(pAny * 100));

    L.stats.inTrips++; st.mode = 'B'; log('B in ' + ho.k + ' T' + T.toFixed(0) + ' p' + Math.round(pAny * 100) + ' n' + list.length);
    const kite0 = h.combat.cfg.kite; h.combat.cfg.kite = false; // 屋里不风筝（会乱绕）
    const crumbs = [me().clone()]; const hp0 = bot.health, t0 = Date.now(), inv0 = invCount();
    const rec = setInterval(() => { const p = me(); if (p.distanceTo(crumbs[crumbs.length - 1]) > 1) crumbs.push(p.clone()); }, 250);
    let why = '';
    const danger = () => {
      if (mobs().some((m) => inBox(m.position, ho.box) || m.position.distanceTo(me()) < 6)) return (why = 'mob');
      if (bot.health < hp0 - 4) return (why = 'hurt');
      if (Date.now() - t0 > T * 1800) return (why = 'slow');
      return '';
    };
    try {
      let tgt = first;
      for (let n = 0; tgt && n < 10; n++) {
        const r = await stepTo(tgt, danger);
        if (r === 'mob' || why) break;
        const rest = drops().filter((d) => d.ho === ho);
        rest.sort((x, y) => x.e.position.distanceTo(me()) - y.e.position.distanceTo(me()));
        tgt = rest.length ? rest[0].e : null;
      }
    } finally { clearInterval(rec); }
    if (why) { L.stats.inAborts++; log('B abort ' + why); }
    bot.pathfinder.stop();
    // 沿进来的路倒着冲出去
    for (let i = crumbs.length - 1; i >= 0; i--) {
      const c = crumbs[i]; const tt = Date.now();
      while (hd(me(), c) > 0.8 && Date.now() - tt < 2500) {
        await bot.lookAt(new Vec3(c.x, me().y + 1.6, c.z), true).catch(() => {});
        bot.setControlState('forward', true); bot.setControlState('sprint', true);
        bot.setControlState('jump', bot.entity.isCollidedHorizontally && c.y > me().y + 0.4);
        await sleep(50);
      }
    }
    bot.clearControlStates();
    h.combat.cfg.kite = kite0; st.mode = '';
    if (invCount() > inv0) { L.stats.inOk++; st.picked += invCount() - inv0; }
    if (!mobs().some((m) => m.position.distanceTo(me()) < 8)) await backTo();
    return true;
  }

  // 每个 farm tick：主动看地上有什么，决定去不去捡
  L.tick = async () => {
    const list = drops();
    st.drops = list.length;
    if (!list.length) return false;
    if (bot.health <= cfg.lowHp + 4) return skip('hp');
    const out = list.filter((d) => !d.ho);
    if (out.length && await outside(out)) return true;
    for (const ho of L.cfg.houses) {
      const inl = list.filter((d) => d.ho === ho);
      if (inl.length && await inside(ho, inl)) return true;
    }
    return false;
  };
  L.pSpawn = pSpawn; L.houseOf = houseOf; L.drops = drops;
  return L;
};
