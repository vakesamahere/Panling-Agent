// Per-tick archer combat layer for mineflayer (MC 1.8).
// Usage (bot.js): h.combat = require('./combat')(bot, h); then h.combat.start() / stop() / stats().
const Vec3 = require('vec3');

const HOSTILE = new Set(['Zombie', 'Skeleton', 'Spider', 'CaveSpider', 'Creeper', 'Witch', 'Slime', 'MagmaCube', 'Blaze',
  'PigZombie', 'Enderman', 'Silverfish', 'Endermite', 'Guardian', 'Ghast', 'WitherSkeleton', 'Wolf', 'Giant']);

module.exports = function (bot, h) {
  const cfg = {
    range: 20, // max acquisition distance (28 太远，射不准又浪费箭)
    minDist: 7, // kite: back off below this
    maxDist: 16, // approach above this (only if approach=true)
    approach: false,
    meleeDist: 3, // use dagger below this when kiting fails / no arrows
    chargeTicks: 21, // 1.8 bow full charge = 20 ticks
    lowHp: 8, // retreat/eat below this
    kite: true,
    fleeDist: 5, // 任何敌对怪进这个距离 → 停止拉弓，转身冲刺拉开
    safeDist: 9, // 拉开到这个距离再回头射
    archerBonus: 12, // 射手优先级
    strafe: false, // 旧的定时左右横移（被躲箭替代）
    dodge: true, // 看到朝我飞的箭 → 横向冲刺闪开
    dodgeMs: 450,
    fleePts: null, // [{x,z}] 撤退空地点
    whitelistNames: null, // optional array: only target entities whose customName includes one of these
    filter: null, // optional fn(entity)->bool extra filter
  };
  const st = { on: false, target: null, charging: 0, aimed: false, meleeCd: 0, eating: false, hist: new Map(), lastShot: null };
  const stats = { shots: 0, hits: 0, kills: 0, melee: 0, deaths: 0, started: 0 };

  // Friendly named mobs (village guards etc.) must never be targeted.
  const FRIENDLY = /守衛|守卫|村|NPC|引導|商人/;
  const isHostile = (e) => e && e.type === 'mob' && HOSTILE.has(e.name) && e.isValid !== false &&
    !FRIENDLY.test(String(e.metadata?.[2] || '')) &&
    (!cfg.whitelistNames || cfg.whitelistNames.some((n) => String(e.metadata?.[2] || '').includes(n))) &&
    (!cfg.filter || cfg.filter(e));

  // 视线检查：眼睛到目标身体中部之间有实心方块 → 隔墙，不打（之前隔沙石墙射屋里的怪，189 箭中 19）
  function canSee(e) {
    const eye = bot.entity.position.offset(0, 1.62, 0);
    for (const fy of [0.5, 0.85]) {
      const tgt = e.position.offset(0, (e.height || 1.8) * fy, 0);
      const dir = tgt.minus(eye); const dist = dir.norm();
      if (dist < 1) return true;
      const hit = bot.world.raycast(eye, dir.scaled(1 / dist), dist, (b) => b.boundingBox === 'block');
      if (!hit) return true;
    }
    return false;
  }

  function pickTarget() {
    const me = bot.entity.position;
    let best = null; let bd = Infinity;
    for (const e of Object.values(bot.entities)) {
      if (!isHostile(e)) continue;
      const d = e.position.distanceTo(me);
      // 优先射手（普通骷髅，会远程）：评分=距离-12；凋零骷髅/僵尸只有近身威胁，靠风筝处理
      const archer = e.name === 'Skeleton' && !(e.metadata && e.metadata[13] === 1);
      const sc = d - (archer ? cfg.archerBonus : 0);
      if (d < cfg.range && sc < bd && (d < cfg.meleeDist || canSee(e))) { bd = sc; best = e; }
    }
    return best;
  }

  // track target velocity from position deltas (blocks/tick), smoothed
  function trackVel(e) {
    const prev = st.hist.get(e.id);
    const p = e.position.clone();
    let v = new Vec3(0, 0, 0);
    if (prev) {
      const raw = p.minus(prev.p);
      v = prev.v.scaled(0.6).plus(raw.scaled(0.4));
      if (raw.norm() > 2) v = new Vec3(0, 0, 0); // teleport
    }
    st.hist.set(e.id, { p, v });
    return v;
  }

  // Simulate 1.8 arrow: per tick pos+=vel; vel*=0.99; vel.y-=0.05. Returns height at horizontal dist d, and ticks.
  function simArrow(pitch, d, v0) {
    let x = 0; let y = 0; let vx = Math.cos(pitch) * v0; let vy = Math.sin(pitch) * v0;
    for (let t = 1; t < 120; t++) {
      x += vx; y += vy; vx *= 0.99; vy = vy * 0.99 - 0.05;
      if (x >= d) return { y, t };
      if (vy < 0 && y < -30) break;
    }
    return null;
  }
  // find lowest pitch hitting (d, dy); binary search on low arc
  function solvePitch(d, dy, v0 = 3) {
    let lo = -Math.PI / 2 + 0.01; let hi = Math.PI / 4; // low trajectory: height at d increases with pitch up to ~45deg
    if (!simArrow(hi, d, v0) || simArrow(hi, d, v0).y < dy) return null; // out of range
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2; const r = simArrow(m, d, v0);
      if (!r || r.y < dy) lo = m; else hi = m;
    }
    const r = simArrow(hi, d, v0);
    return { pitch: hi, t: r ? r.t : 20 };
  }

  function aimAt(e) {
    const eye = bot.entity.position.offset(0, 1.62 - 0.1, 0); // arrow spawns 0.1 below eye
    const v = trackVel(e);
    let aim = e.position.offset(0, (e.height || 1.8) * 0.6, 0);
    let sol = null;
    for (let i = 0; i < 3; i++) { // iterate lead: predicted pos after flight time
      const dlt = aim.minus(eye);
      const d = Math.hypot(dlt.x, dlt.z);
      sol = solvePitch(d, dlt.y);
      if (!sol) return false;
      aim = e.position.offset(v.x * sol.t, (e.height || 1.8) * 0.6 + (e.onGround ? 0 : v.y * sol.t * 0.5), v.z * sol.t);
    }
    const dlt = aim.minus(eye);
    const yaw = Math.atan2(-dlt.x, -dlt.z);
    bot.look(yaw, sol.pitch, true);
    return true;
  }

  const findItem = (pred) => bot.inventory.items().find(pred);
  const hasArrows = () => !!findItem((i) => i.name === 'arrow');
  const bow = () => findItem((i) => i.name === 'bow' && /北斗/.test(i.customName || '')) || findItem((i) => i.name === 'bow');
  const melee = () => findItem((i) => /sword|netherbrick|axe/.test(i.name)) ;
  async function hold(item) {
    if (item && (!bot.heldItem || bot.heldItem.slot !== item.slot)) { try { await bot.equip(item, 'hand'); } catch {} }
  }

  function stopCharge() { if (st.charging) { bot.deactivateItem(); st.charging = 0; } }

  const hostiles = () => Object.values(bot.entities).filter((e) => isHostile(e));
  // 地面可走：前方 1、2 格脚/头是空的，且 2 格处脚下 3 格内有地（不跑进坑/墙）
  function dirOk(yaw) {
    const p = bot.entity.position;
    for (const k of [1, 2, 3]) {
      const x = p.x - Math.sin(yaw) * k, z = p.z - Math.cos(yaw) * k;
      const f = bot.blockAt(new Vec3(x, p.y + 0.5, z)), u = bot.blockAt(new Vec3(x, p.y + 1.5, z));
      if (!f || !u) return false;
      if (u.boundingBox === 'block') return false;
      if (f.boundingBox === 'block') { const f2 = bot.blockAt(new Vec3(x, p.y + 2.5, z)); if (!f2 || f2.boundingBox === 'block') return false; }
      let ground = false;
      for (let dy = 0; dy <= 3; dy++) { const g = bot.blockAt(new Vec3(x, p.y - 0.5 - dy, z)); if (g && g.boundingBox === 'block') { ground = true; break; } }
      if (!ground) return false;
    }
    return true;
  }
  // 选逃跑方向：16 个方向里，走 4 格后离所有怪最近距离最大、且可走的；偏向站桩点
  function fleeYaw(ms) {
    const p = bot.entity.position;
    // 优先：往预设的空地撤退点跑（cfg.fleePts，门口外的空地）。选“离怪最远且不用穿过怪”的那个
    if (cfg.fleePts && cfg.fleePts.length) {
      let bp = null, bsc = -Infinity;
      for (const q of cfg.fleePts) {
        const dq = Math.hypot(q.x - p.x, q.z - p.z); if (dq < 2) continue;
        const ux = (q.x - p.x) / dq, uz = (q.z - p.z) / dq;
        let sc = 0, blocked = false;
        for (const m of ms) {
          const mx = m.position.x - p.x, mz = m.position.z - p.z; const along = mx * ux + mz * uz;
          const side = Math.abs(mx * uz - mz * ux);
          if (along > 0 && along < dq && side < 2.5) blocked = true; // 怪挡在路上
          sc += Math.min(12, Math.hypot(m.position.x - q.x, m.position.z - q.z));
        }
        if (blocked) continue;
        sc = sc / Math.max(1, ms.length) - dq * 0.2;
        if (sc > bsc) { bsc = sc; bp = q; }
      }
      if (bp) { const yaw = Math.atan2(-(bp.x - p.x), -(bp.z - p.z)); if (dirOk(yaw)) { st.fleePt = bp; return yaw; } }
    }
    const a = h.farm && h.farm.cfg && h.farm.cfg.anchor;
    let best = null, bs = -Infinity;
    for (let i = 0; i < 16; i++) {
      const yaw = i * Math.PI / 8;
      if (!dirOk(yaw)) continue;
      const q = { x: p.x - Math.sin(yaw) * 4, z: p.z - Math.cos(yaw) * 4 };
      let md = Infinity;
      for (const m of ms) md = Math.min(md, Math.hypot(m.position.x - q.x, m.position.z - q.z));
      let s = md;
      if (a) s -= Math.max(0, Math.hypot(q.x - a.x, q.z - a.z) - 12) * 0.5; // 别跑太远
      if (s > bs) { bs = s; best = yaw; }
    }
    return best;
  }

  function moveRel(e, d) {
    // 赶路中（pathfinder 在走）就不抢方向键，只射箭
    if (bot.pathfinder && bot.pathfinder.isMoving()) return;
    st.drove = true;
    // face-independent movement: we look at target, so forward=approach, back=retreat
    bot.setControlState('back', cfg.kite && d < cfg.minDist);
    bot.setControlState('forward', cfg.approach && d > cfg.maxDist);
    bot.setControlState('sprint', false);
    // jump if stuck while retreating
    bot.setControlState('jump', cfg.kite && d < cfg.minDist && bot.entity.isCollidedHorizontally);
    // 远程骷髅（非凋零）在射程外时左右横移躲箭
    if (cfg.strafe && e.name === 'Skeleton' && !(e.metadata && e.metadata[13] === 1) && d > cfg.fleeDist) {
      const ph = Math.floor(Date.now() / 900) % 2;
      const l = ph === 0 && dirOk(bot.entity.yaw + Math.PI / 2), r = ph === 1 && dirOk(bot.entity.yaw - Math.PI / 2);
      bot.setControlState('left', l); bot.setControlState('right', r);
    } else { bot.setControlState('left', false); bot.setControlState('right', false); }
  }

  async function tryEat() {
    if (st.eating) return;
    const pot = findItem((i) => i.name === 'potion' && !JSON.stringify(i.nbt || '').includes('鶴頂') && i.metadata !== 8234); // 别把毒药当补药
    const food = findItem((i) => ['bread', 'cooked_beef', 'cooked_porkchop', 'apple', 'golden_apple', 'cooked_chicken', 'baked_potato', 'carrot', 'cookie', 'melon', 'mushroom_stew', 'cooked_fish'].includes(i.name));
    const it = pot || (bot.food < 20 ? food : null);
    if (!it) return;
    st.eating = true; stopCharge();
    try { await bot.equip(it, 'hand'); await bot.consume(); } catch {}
    st.eating = false;
  }

  // 躲箭：每 tick 扫来箭，线性外推最近接近距离
  function incomingArrow() {
    const me = bot.entity.position.offset(0, 1, 0);
    for (const e of Object.values(bot.entities)) {
      if (e.name !== 'Arrow' && e.displayName !== 'Arrow') continue;
      const v = e.velocity; const sp = v.norm(); if (sp < 0.3) continue; // 插地上的
      if (st.myArrows && st.myArrows.has(e.id)) continue;
      const r = me.minus(e.position); const t = (r.x * v.x + r.y * v.y + r.z * v.z) / (sp * sp); // tick
      if (t < 0 || t > 30) continue;
      const c = e.position.plus(v.scaled(t)); const miss = Math.hypot(c.x - me.x, c.z - me.z);
      st.seenArrows = (st.seenArrows || 0) + 1;
      if (miss < 1.6) return { e, t, v };
    }
    return null;
  }
  function onTick() {
    if (!st.on || st.eating || bot._eating || !bot.entity) return;
    // 躲箭（优先级最高）：朝来箭方向的垂直方向冲刺
    if (cfg.dodge) {
      const now = Date.now();
      if (!st.dodgeUntil || now > st.dodgeUntil) {
        const a = incomingArrow();
        if (a && a.t > 2) {
          const ay = Math.atan2(-a.v.x, -a.v.z); // 箭飞行方向的 yaw
          const cands = [ay + Math.PI / 2, ay - Math.PI / 2].filter(dirOk);
          if (cands.length) { st.dodgeYaw = cands[(st.dodges = (st.dodges || 0) + 1) % cands.length]; st.dodgeUntil = now + cfg.dodgeMs; }
        }
      }
      if (st.dodgeUntil && now < st.dodgeUntil) {
        stopCharge(); st.drove = true; h.driveUntil = now + 300;
        bot.look(st.dodgeYaw, 0, true);
        bot.setControlState('back', false); bot.setControlState('left', false); bot.setControlState('right', false);
        bot.setControlState('forward', true); bot.setControlState('sprint', true);
        return;
      } else if (st.dodgeUntil) { st.dodgeUntil = 0; bot.clearControlStates(); }
    }
    const t = st.target && st.target.isValid !== false && bot.entities[st.target.id] ? st.target : null;
    if (!t || t.position.distanceTo(bot.entity.position) > cfg.range || ((st.losTick = (st.losTick || 0) + 1) % 10 === 0 && (!canSee(t) || (!st.charging && pickTarget() !== t)))) {
      stopCharge();
      st.target = pickTarget();
      if (!st.target) { stopCharge(); if (st.drove) { st.drove = false; bot.clearControlStates(); } return; }
    }
    const e = st.target;
    const d = e.position.distanceTo(bot.entity.position);

    if (bot.health <= cfg.lowHp) tryEat();


    // 没箭了：不硬拼（怪 35-50 血），只在贴脸时还手，并发事件让上层撤
    if (!hasArrows() && !st.noArrowSent) { st.noArrowSent = true; bot.emit('combat-no-arrows'); }
    if (hasArrows()) st.noArrowSent = false;
    if (!hasArrows() && d >= cfg.meleeDist) { stopCharge(); return; }

    // 风筝：有怪贴近 → 停拉弓，转身冲刺到 safeDist 再回头（拉弓时移动只有 20% 速度，倒退躲不开）
    if (cfg.kite && !(bot.pathfinder && bot.pathfinder.isMoving())) {
      const ms = hostiles();
      let nd = Infinity; for (const m of ms) { let dd = m.position.distanceTo(bot.entity.position); if (m.name === 'Skeleton' && m.metadata && m.metadata[13] === 1) dd -= (cfg.witherExtra || 3); nd = Math.min(nd, dd); } // 凋零骷髅一刀 6.7+凋零效果，提前 3 格撤
      const now = Date.now();
      // 多怪：12 格内每多一只，开始撤的距离 +1.5、拉开的安全距离 +3（击退一只时另一只会贴上来）
      let near = 0; for (const m of ms) if (m.position.distanceTo(bot.entity.position) < 12) near++;
      const extra = Math.min(3, Math.max(0, near - 1));
      // 上界：开始撤 ≤ maxFleeDist，拉开 ≤ maxSafeDist，时长 ≤ maxFleeMs；离刷怪锚点超过 fleeLeash 就停（防止堆怪时跑太远）
      const fd = Math.min(cfg.maxFleeDist || 9, cfg.fleeDist + extra * 1.5), sd = Math.min(cfg.maxSafeDist || 15, cfg.safeDist + extra * 3);
      st.multi = extra;
      const anc = h.farm && h.farm.cfg && h.farm.cfg.anchor;
      const tooFar = anc && Math.hypot(bot.entity.position.x - anc.x, bot.entity.position.z - anc.z) > (cfg.fleeLeash || 16);
      if (nd < fd && !st.fleeUntil && !tooFar) { st.fleeUntil = now + Math.min(cfg.maxFleeMs || 4000, 2500 + extra * 1000); if (extra) st.multiFlees = (st.multiFlees || 0) + 1; }
      if (st.fleeUntil && (nd >= sd || now > st.fleeUntil || tooFar)) { if (tooFar) st.leashStops = (st.leashStops || 0) + 1; st.fleeUntil = 0; bot.clearControlStates(); }
      if (st.fleeUntil) {
        const yaw = fleeYaw(ms);
        if (yaw != null) {
          stopCharge(); st.drove = true; st.flees = (st.flees || 0) + 1;
          h.driveUntil = now + 600;
          bot.look(yaw, 0, true);
          bot.setControlState('back', false); bot.setControlState('left', false); bot.setControlState('right', false);
          bot.setControlState('forward', true); bot.setControlState('sprint', true);
          bot.setControlState('jump', bot.entity.isCollidedHorizontally);
          return;
        }
        st.fleeUntil = 0; // 无路可逃 → 下面近战
      }
    }

    // melee fallback: too close or no ammo
    if ((d < cfg.meleeDist && (bot.entity.isCollidedHorizontally || !cfg.kite)) || !hasArrows() || !bow()) {
      stopCharge();
      const m = melee();
      bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.8, 0), true);
      moveRel(e, d);
      if (st.meleeCd-- <= 0 && d < 3.5) {
        if (m && bot.heldItem?.slot !== m.slot) hold(m);
        bot.attack(e); stats.melee++; st.meleeCd = 10;
      }
      return;
    }

    const b = bow();
    if (bot.heldItem?.slot !== b.slot) { stopCharge(); hold(b); return; }
    moveRel(e, d);
    if (!st.charging) { bot.activateItem(); st.charging = 1; return; }
    st.charging++;
    const ok = aimAt(e); // re-aim every tick; look packet goes out this tick
    if (st.charging > cfg.chargeTicks && ok && st.aimed) {
      bot.deactivateItem(); st.charging = 0; st.aimed = false;
      stats.shots++; st.lastShot = { id: e.id, at: Date.now() };
      if (st.lastShotHit === false) st.miss = (st.miss || 0) + 1;
    } else st.aimed = ok;
  }

  const L = {
    physicsTick: onTick,
    entitySpawn: (e) => { if ((e.name === 'Arrow' || e.displayName === 'Arrow') && e.position.distanceTo(bot.entity.position) < 2.5) { (st.myArrows = st.myArrows || new Set()).add(e.id); if (st.myArrows.size > 50) st.myArrows = new Set([e.id]); } },
    entityHurt: (e) => { if (st.lastShot && e.id === st.lastShot.id && Date.now() - st.lastShot.at < 3000) { stats.hits++; st.lastShot = null; } },
    entityDead: (e) => { if (st.target && e.id === st.target.id) { stats.kills++; st.target = null; } },
    death: () => { if (st.on) stats.deaths++; st.charging = 0; },
    entityGone: (e) => { st.hist.delete(e.id); if (st.target && e.id === st.target.id) st.target = null; },
  };
  for (const [k, f] of Object.entries(L)) bot.on(k, f);

  return {
    cfg, stats,
    dispose() { for (const [k, f] of Object.entries(L)) bot.removeListener(k, f); },
    start(opts = {}) { Object.assign(cfg, opts); st.on = true; stats.started = Date.now(); return 'on'; },
    stop() { st.on = false; stopCharge(); bot.clearControlStates(); return 'off'; },
    state: () => ({ on: st.on, flees: st.flees || 0, dodges: st.dodges || 0, multiFlees: st.multiFlees || 0, leashStops: st.leashStops || 0, seenArrows: st.seenArrows || 0, target: st.target && { id: st.target.id, n: st.target.name, d: +st.target.position.distanceTo(bot.entity.position).toFixed(1) }, charging: st.charging, hp: bot.health, food: bot.food, ...stats }),
    resetStats() { Object.assign(stats, { shots: 0, hits: 0, kills: 0, melee: 0, deaths: 0 }); },
    solvePitch, simArrow,
  };
};
