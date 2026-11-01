// 刷怪循环：站桩点(anchor) + 战斗层射击 + 空档捡战利品 + 漂远了回站桩点。
// h.farm.start({anchor:{x,y,z}, leash:14, lootR:14}) / stop() / state()
// 依赖：h.combat（射击/风筝）、h.goto（走路）、bot.js 自动吃饭、h.resupply（本地物资）。
const { Vec3 } = require('vec3');
module.exports = (bot, h) => {
  const cfg = { anchor: null, leash: 14, lootR: 14, tickMs: 700, retreat: null, lowHp: 10, okHp: 18,
    spawners: [], // [{n,x,y,z}] 刷出点；估计刷怪间隔，安全时机才进去捡
    spawnR: 9, // 掉落物离刷出点这么近 = 危险区
    minGap: 10, // 默认最短刷怪间隔(s)（1.8 原版 10-40s）
    walkSpd: 4, junk: /^(glass_bottle|carrot)$/, keepFree: 4 };
  const st = { on: false, busy: false, picked: 0, lootSeen: 0, returns: 0, since: 0, log: [] };
  const log = (s) => { st.log.push(new Date().toTimeString().slice(0, 8) + ' ' + s); if (st.log.length > 30) st.log.shift(); };

  // 1.8 掉落物实体：name 'item'（新版 prismarine）或 objectType 'Item'
  const isDrop = (e) => e && e.type === 'object' && /^item$/i.test(e.name || '') && e.isValid !== false;
  const hostileNear = (r) => Object.values(bot.entities).some((e) => e.type === 'mob' && e !== bot.entity &&
    /Skeleton|Zombie|Spider|Creeper|Blaze|PigZombie|LavaSlime|Witch|Enderman|Slime|Silverfish|CaveSpider/.test(e.name || '') &&
    e.position.distanceTo(bot.entity.position) < r);
  const me = () => bot.entity.position;
  const isMob = (e) => e && e.type === 'mob' && /Skeleton|Zombie|Spider|Creeper|Blaze|PigZombie|LavaSlime|Witch/.test(e.name || '');
  const hd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  // 刷怪记录：每个刷出点的上次刷怪时间和观测到的间隔
  bot.on('entitySpawn', (e) => {
    if (!st.on || !isMob(e)) return;
    for (const sp of cfg.spawners) {
      if (hd(e.position, sp) < 3 && Math.abs(e.position.y - sp.y) < 4) {
        const now = Date.now();
        if (sp.last && now - sp.last > 2000) { (sp.gaps = sp.gaps || []).push((now - sp.last) / 1000); if (sp.gaps.length > 12) sp.gaps.shift(); }
        if (!sp.last || now - sp.last > 2000) sp.last = now; sp.n = (sp.n || 0) + 1;
        st.spawnTick = (st.spawnTick || 0) + 1;
      }
    }
  });
  // 估计该刷出点下一次最早刷怪还剩几秒（取观测间隔的较小值，保守）
  function eta(sp) {
    if (!sp.last) return 0;
    const g = (sp.gaps && sp.gaps.length >= 2) ? [...sp.gaps].sort((a, b) => a - b)[Math.floor(sp.gaps.length * 0.2)] : cfg.minGap;
    return Math.max(0, Math.min(g, cfg.minGap * 4) - (Date.now() - sp.last) / 1000);
  }
  // 安全时机：路上/目标附近没怪；目标若在刷出点危险区，那个点的估计刷怪时间要大于一来一回的时间
  function safeTrip(d) {
    const p = me(), q = d.position;
    const dist = hd(p, q), trip = (2 * dist) / cfg.walkSpd + 1.5;
    const mid = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
    for (const e of Object.values(bot.entities)) {
      if (!isMob(e)) continue;
      if (!seeFrom(q, e) && !seeFrom(p, e) && !seeFrom(mid0(p, q), e)) continue; // 关在屋里、看不到路线的怪不算
      if (hd(e.position, q) < 10 || hd(e.position, mid) < 9 || hd(e.position, p) < 10) return { ok: false, why: 'mob' };
    }
    for (const sp of cfg.spawners) {
      if (hd(q, sp) < cfg.spawnR || hd(mid, sp) < cfg.spawnR - 2) { const t = eta(sp); if (t < trip + 2) return { ok: false, why: 'spawn ' + sp.n + ' in ' + t.toFixed(0) + 's' }; }
    }
    return { ok: true, trip };
  }
  // 视线：从点 p(脚) 眼睛高度到怪身上，中间没有实心方块
  function seeFrom(p, e) {
    try {
      const eye = new Vec3(p.x, p.y + 1.62, p.z);
      for (const hgt of [0.5, 1.4]) {
        const t = e.position.offset(0, hgt, 0), d = t.minus(eye), L = d.norm();
        if (L < 0.5) return true;
        const n = Math.ceil(L / 0.25); let clear = true;
        for (let i = 1; i < n; i++) {
          const b = bot.blockAt(eye.plus(d.scaled(i / n)));
          if (b && b.boundingBox === 'block' && !/glass|fence|bars|leaves/.test(b.name)) { clear = false; break; }
        }
        if (clear) return true;
      }
    } catch {}
    return false;
  }
  // 屋里有射手但站桩点看不到 → 走到门口狙击点射它，射完回站桩点
  async function peek() {
    if (!cfg.peek || !cfg.peekPts || !cfg.peekPts.length) return false;
    const hid = Object.values(bot.entities).filter((e) => isMob(e) && cfg.peekOnly.test(e.name + ':' + ((e.metadata && e.metadata[13]) || 0)) &&
      e.position.distanceTo(me()) < 24 && !seeFrom(me(), e));
    if (!hid.length) { st.hidSince = 0; return false; }
    if (!st.hidSince) st.hidSince = Date.now();
    if (Date.now() - st.hidSince < (cfg.peekDelay || 2000)) return false;
    const tgt = hid[0];
    const pt = cfg.peekPts.find((q) => seeFrom(q, tgt));
    if (!pt) return false;
    st.peeks = (st.peeks || 0) + 1; log('peek → ' + pt.x + ',' + pt.z);
    try { await h.goto(pt.x, pt.y, pt.z, 0.6, 8000); } catch {}
    for (let w = 0; w < 16 && bot.entities[tgt.id] && bot.health > cfg.lowHp; w++) await sleep(500);
    st.hidSince = 0;
    try { await h.goto(cfg.anchor.x, cfg.anchor.y, cfg.anchor.z, 1, 8000); } catch {}
    return true;
  }
  const mid0 = (p, q) => ({ x: (p.x + q.x) / 2, y: Math.max(p.y, q.y), z: (p.z + q.z) / 2 });
  // 有威胁的怪：r 格内且能看到我
  const threatNear = (r) => Object.values(bot.entities).some((e) => isMob(e) && e.position.distanceTo(me()) < r && seeFrom(me(), e));
  async function tossJunk() {
    return; // 用户要求：任何东西都不扔
    if (bot.inventory.emptySlotCount() > cfg.keepFree) return;
    for (const i of bot.inventory.items()) if (cfg.junk.test(i.name) && !i.customName) { try { await bot.tossStack(i); log('toss ' + i.name); } catch {} }
  }

  // —— 捡东西（简化版）——
  // 能看见我的怪（墙后的不算）
  const visMobs = (r, at) => Object.values(bot.entities).filter((m) => isMob(m) && m.position.distanceTo(at || me()) < r && seeFrom(me(), m));
  const lowDrop = (e) => e.position.y < me().y - 3;
  function nearestDrop(from, maxD) {
    let best = null, bd = Infinity; const o = from || me();
    for (const e of Object.values(bot.entities)) {
      if (!isDrop(e) || lowDrop(e)) continue;
      if (cfg.anchor && hd(e.position, cfg.anchor) > (cfg.lootLeash || 20)) continue;
      const d = e.position.distanceTo(o);
      if (d < (maxD || cfg.lootR) && d < bd) { bd = d; best = e; }
    }
    return best;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 一趟：走到最近掉落 → 顺路把 6 格内的都吸了 → 回站桩点。
  // 路上：≥2 只看得见的怪贴近(8格) 或 低血 → 立刻回；只来 1 只 → 原地停下等战斗层射死再继续（单怪秒不了我）。
  async function pick(e) {
    const inv0 = bot.inventory.items().reduce((a, i) => a + i.count, 0);
    const kite0 = h.combat.cfg.kite; h.combat.cfg.kite = false; // 捡东西途中不风筝（风筝会在屋里乱绕）
    let tgt = e, n = 0;
    // 1.8 这服要踩到掉落物上才算捡：goto 到格子后再对准实体位置往前挤一下
    const stepOn = async (t) => {
      try { await h.goto(t.position.x, t.position.y, t.position.z, 0, 5000); } catch {}
      for (let k = 0; k < 8 && bot.entities[t.id] && hd(me(), t.position) > 0.25; k++) {
        await bot.lookAt(t.position.offset(0, 1.6, 0), true).catch(() => {});
        bot.setControlState('forward', true); await sleep(120); bot.setControlState('forward', false);
      }
    };
    try {
      while (tgt && n++ < 12) {
        if (bot.health <= cfg.lowHp) { st.pickAborts = (st.pickAborts || 0) + 1; log('pick abort lowhp'); break; }
        // 有怪看见我：站住别动，让战斗层射死（单怪秒不了我）；8s 还没完就撤
        if (visMobs(10).length) {
          bot.pathfinder.stop(); bot.clearControlStates();
          let w = 0; while (w++ < 16 && visMobs(10).length && bot.health > cfg.lowHp) await sleep(500);
          if (visMobs(10).length) { st.pickAborts = (st.pickAborts || 0) + 1; log('pick abort mobs'); break; }
          continue;
        }
        await stepOn(tgt);
        tgt = nearestDrop(me(), 8);
      }
    } finally { h.combat.cfg.kite = kite0; }
    // 回固定站桩点（屋外）；卡住重试
    for (let k = 0; k < 3 && cfg.anchor && hd(me(), cfg.anchor) > 2; k++) { try { await h.goto(cfg.anchor.x, cfg.anchor.y, cfg.anchor.z, 1, 8000); } catch {} }
    const inv1 = bot.inventory.items().reduce((a, i) => a + i.count, 0);
    if (inv1 > inv0) { st.picked += inv1 - inv0; return true; }
    return false;
  }

  async function step() {
    if (!st.on || st.busy || !bot.entity) return;
    st.busy = true;
    try {
      // 0) 低血：停战斗，跑到撤退点（离刷怪笼 25+ 格、骷髅射不到）回血，满了再回来
      if (cfg.retreat && bot.health <= cfg.lowHp && !st.healing) {
        st.healing = true; st.heals = (st.heals || 0) + 1; h.combat.stop(); log('low hp ' + Math.round(bot.health) + ' → retreat');
        try { await h.goto(cfg.retreat.x, cfg.retreat.y, cfg.retreat.z, 2, 20000); } catch (e) { log('retreat ' + String(e.message).slice(0, 25)); }
        h.combat.start({ approach: false });
        return;
      }
      if (st.healing) {
        // 在撤退点等回血；血不再涨（饱食满但服务器不回血）超过 15s 且已高于 lowHp+4，就不等了
        if (!st.hpMark || bot.health > st.hpMark.hp + 0.5) st.hpMark = { hp: bot.health, t: Date.now() };
        const stuckHeal = Date.now() - st.hpMark.t > 10000 && bot.health > cfg.lowHp; // 血不再涨=已满（手持物会改上限）
        if (bot.health < cfg.okHp && !stuckHeal) return;
        st.hpMark = null;
        st.healing = false; log('healed ' + Math.round(bot.health) + ' → back');
        try { await h.goto(cfg.anchor.x, cfg.anchor.y, cfg.anchor.z, 2, 20000); } catch {}
        return;
      }
      // 死了/被传走：离站桩点很远 → 停战斗，走固定路线回来
      // 离站桩点远 或 箭/吃的不够 → 固定流程 h.home：自杀→奈何桥→录好的路→南门买→录好的路回来（不寻路）
      const far = cfg.anchor && hd(me(), cfg.anchor) > 60;
      if (h.home && (far || (h.home.needShop() && !hostileNear(10)))) {
        h.combat.stop(); log((far ? 'far' : 'need supply') + ' → home.run'); st.travels = (st.travels || 0) + 1;
        const r = await h.home.run({ force: true, fromFarm: true }); log('home ' + r);
        if (r.startsWith('err')) { st.homeErr = (st.homeErr || 0) + 1; if (st.homeErr >= 5) { log('home failed 5x, stop'); st.on = false; return; } log('home err #' + st.homeErr + ', retry in 20s'); await new Promise((r) => setTimeout(r, 20000)); }
        else st.homeErr = 0;
        h.combat.start({ approach: false }); return;
      }
      if (far) return;
      // 王員外货够一批（cfg.wang，默认 ≥120）→ 去沙漠马贼营地换金锭再回来
      if (h.home && h.home.wangDue && h.home.wangDue() && !hostileNear(10) && !h.combat.state().target && !st.healing) {
        h.combat.stop(); log('wang trip goods ' + h.home.goodsN());
        const out = []; const r = await h.home.wang(out); log('wang ' + r + ' ' + out.join(' | ').slice(0, 80));
        h.combat.start({ approach: false }); return;
      }
      // 缺箭/缺面包/背包满 → 回皇城补给变卖（cfg.town=true 时），完了上面的 far→travel 会自己走回来
      if (cfg.town && h.town && !hostileNear(8) && !(st.townCool > Date.now())) {
        const why = h.town.need();
        if (why.length) {
          log('town trip: ' + why.join(',')); st.townTrips = (st.townTrips || 0) + 1;
          h.combat.stop(); bot.pathfinder.stop();
          try { log('town ' + (await h.town.run({ noCombat: true })).slice(0, 120)); } catch (e) { log('town err ' + String(e.message).slice(0, 40)); }
          st.townCool = Date.now() + 10 * 60000; // 补给后 10 分钟内不再触发，避免卖不掉东西时反复跑
          h.combat.start({ approach: false });
          return;
        }
      }
      await tossJunk();
      if (!h.combat.state().target && !st.healing && await peek()) return;
      const fighting = h.combat.state().target;
      // 1) 没在打、周围 10 格没怪 → 捡东西
      if (h.loot) { if (await h.loot.tick()) return; }
      else if (visMobs(16).length === 0 && bot.health > cfg.lowHp + 2) {
        const d = nearestDrop();
        if (d) { st.lootSeen++; const ok = await pick(d); if (ok) log('picked → ' + st.picked); return; }
      }
      // 2) 漂离站桩点（被追/风筝退远）且没在打 → 走回去
      if (cfg.anchor && !fighting && !st.healing) {
        const a = cfg.anchor, p = me();
        if (Math.hypot(p.x - a.x, p.z - a.z) > (fighting ? cfg.leash : 2.5)) {
          st.returns++; log('return to anchor');
          try { await h.goto(a.x, a.y, a.z, 2, 15000); } catch (e) { log('return fail ' + String(e.message).slice(0, 30)); }
        }
      }
    } finally { st.busy = false; }
  }

  let iv = null;
  // 掉落物捡取：1.8 走到掉落物 1 格内自动拾取
  bot.on('playerCollect', (collector, item) => { if (collector === bot.entity) log('collect ' + (item.name || 'item')); });

  return {
    cfg, st, log,
    start(opts = {}) {
      Object.assign(cfg, opts);
      if (!cfg.anchor) cfg.anchor = { x: Math.floor(me().x), y: Math.floor(me().y), z: Math.floor(me().z) };
      st.on = true; st.since = Date.now();
      h.combat.start();
      if (!iv) iv = setInterval(() => step().catch((e) => { const m = String(e && e.message || e).slice(0, 60); if (m !== st.lastErr) { st.lastErr = m; log('ERR ' + m); } }), cfg.tickMs);
      log('farm on @' + JSON.stringify(cfg.anchor));
      return 'on';
    },
    stop() { st.on = false; if (iv) { clearInterval(iv); iv = null; } h.combat.stop(); return 'off'; },
    state() {
      const c = h.combat.state();
      return { on: st.on, travels: st.travels || 0, townTrips: st.townTrips || 0, heals: st.heals || 0, healing: !!st.healing, min: +((Date.now() - st.since) / 60000).toFixed(1), anchor: cfg.anchor, picked: st.picked, returns: st.returns,
        hp: Math.round(bot.health), food: bot.food, shots: c.shots, hits: c.hits, kills: c.kills, deaths: c.deaths,
        arrow: h.count('arrow'), free: bot.inventory.emptySlotCount(), peeks: st.peeks || 0, whyNo: st.whyNo, pickAborts: st.pickAborts || 0, spawners: cfg.spawners.map((sp) => sp.k + ':' + (sp.n || 0) + ' gap' + (sp.gaps && sp.gaps.length ? Math.round(Math.min(...sp.gaps)) + '-' + Math.round(Math.max(...sp.gaps)) : '?') + ' eta' + Math.round(eta(sp))), log: st.log.slice(-6) };
    },
  };
};
