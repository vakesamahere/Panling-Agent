// travel.js — 智能寻路 + 传送阵记忆
//
// h.travel(x,y,z | 'placeName', opts)
//   1. 先查传送阵记忆：若「走到某个传送阵入口 → 传送 → 从出口走」比直接走近，就走传送阵（可串多个）。
//   2. 步行段：nav.js 在 bot 周围建多层地面图做 BFS（能到目标就用全路径，到不了就取离目标最近的可达点），
//      把路径抽成航点交给 h.goto（pathfinder 负责跳台阶/水），每走完一段重新规划；卡住自动重规划，连续失败才报错。
// 传送阵自动学习：踩压力板/走进某处后出现 forcedMove 且位移 > 8 格，就记录 入口→出口 到 memory/world.json。
// h.mem.mark('名字') 记录当前位置为地点；h.mem.ban(x,y,z,'原因') 把某个入口标记为禁用（如 抹除存在）。

const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3');

const MEM_FILE = require('../paths').mem('world.json');
const PLATES = /pressure_plate|portal|tripwire/;

function loadMem() {
  try { return JSON.parse(fs.readFileSync(MEM_FILE, 'utf8')); } catch { return { portals: [], places: {} }; }
}
function saveMem(m) {
  fs.mkdirSync(path.dirname(MEM_FILE), { recursive: true });
  fs.writeFileSync(MEM_FILE, JSON.stringify(m, null, 1));
}
const P = (o) => new Vec3(o.x, o.y, o.z);
const r3 = (v) => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) });

module.exports = function travel(bot, h) {
  const mem = loadMem();
  mem.portals = mem.portals || [];
  mem.places = mem.places || {};

  // ---------- 传送阵自动学习 ----------
  let prevPos = bot.entity ? bot.entity.position.clone() : null;
  let lastTrigger = null; // {pos, t}
  const onTick = () => {
    if (!bot.entity) return;
    const p = bot.entity.position;
    const feet = bot.blockAt(p);
    const under = bot.blockAt(p.offset(0, -0.2, 0));
    const b = (feet && PLATES.test(feet.name)) ? feet : (under && PLATES.test(under.name) ? under : null);
    if (b) lastTrigger = { pos: r3(b.position), t: Date.now(), name: b.name };
    prevPos = p.clone();
  };
  const onForced = () => {
    if (!prevPos) return;
    const to = bot.entity.position;
    if (to.distanceTo(prevPos) < 8) return;
    // 死亡/重生引起的位移不是传送阵；也不记没踩到触发块的 walk-in（误学率太高）
    if (Date.now() - lastDeath < 15000) { lastTrigger = null; return; }
    if (!(lastTrigger && Date.now() - lastTrigger.t < 2500)) return;
    learn(lastTrigger.pos, r3(to), lastTrigger.name);
    lastTrigger = null;
  };
  let lastDeath = 0;
  bot.on('death', () => { lastDeath = Date.now(); });
  bot.on('respawn', () => { lastDeath = Date.now(); });
  bot.on('physicsTick', onTick);
  bot.on('forcedMove', onForced);

  // 所有已知传送入口都让 pathfinder 绕开
  const NavM = require('./navmovements');
  function syncAvoid() { NavM.avoidPlates = mem.portals.filter((q) => q.from).map((q) => q.from); }
  syncAvoid();
  function findPortal(from) {
    return mem.portals.find((q) => Math.abs(q.from.x - from.x) <= 1 && Math.abs(q.from.y - from.y) <= 1 && Math.abs(q.from.z - from.z) <= 1);
  }
  function learn(from, to, kind) {
    let q = findPortal(from);
    if (q) {
      q.uses = (q.uses || 0) + 1; q.last = Date.now();
      if (!q.to || P(q.to).distanceTo(P(to)) > 4) q.to = to; // 出口变了就更新（ban 的条目 to 可能为 null）
    } else {
      q = { from, to, kind, uses: 1, last: Date.now() };
      mem.portals.push(q);
    }
    saveMem(mem); syncAvoid();
    if (h.ev) h.ev('portal-learned', q);
  }

  // ---------- 步行段 ----------
  const pos = () => bot.entity.position;
  // b 是方块坐标（整数）→ 与其中心比较
  const near = (a, b, r) => Math.hypot(a.x - (b.x + 0.5), a.z - (b.z + 0.5)) <= r && Math.abs(a.y - b.y) <= Math.max(2, r);

  // 选航点：每 5 个节点取一个，高度变化处也取，最后一个必取
  function waypoints(nodes) {
    const out = [];
    for (let i = 1; i < nodes.length; i++) {
      const n = nodes[i], prev = nodes[i - 1];
      if (i % 5 === 0 || i === nodes.length - 1 || Math.abs(n.y - prev.y) >= 1) out.push(n);
    }
    // 去掉相邻太近的
    return out.filter((n, i) => i === out.length - 1 || Math.hypot(n.x - out[i + 1].x, n.z - out[i + 1].z) >= 2 || Math.abs(n.y - out[i + 1].y) >= 1);
  }

  // 脱困：面朝目标 forward+jump 1.5s（不走虚空：前方 3 格内无落脚就不跳）
  async function hop(w) {
    // 先朝航点方向，没动就改沿主轴（斜向容易撞墙角）
    const p0 = bot.entity.position.clone();
    const dx = w.x + 0.5 - p0.x, dz = w.z + 0.5 - p0.z;
    const yaws = [Math.atan2(-dx, -dz), Math.abs(dx) > Math.abs(dz) ? Math.atan2(-Math.sign(dx), 0) : Math.atan2(0, -Math.sign(dz))];
    for (const yaw of yaws) {
      const s = bot.entity.position.clone();
      const ahead = s.offset(-Math.sin(yaw) * 1.2, 0, -Math.cos(yaw) * 1.2).floored();
      let ground = false;
      for (let dy = 1; dy >= -3; dy--) { const b = bot.blockAt(ahead.offset(0, dy, 0)); if (b && b.boundingBox === 'block') { ground = true; break; } }
      if (!ground) continue;
      await bot.look(yaw, 0, true);
      h.driveUntil = Date.now() + 2500; bot.setControlState('forward', true); bot.setControlState('jump', true);
      await new Promise((r) => setTimeout(r, 1500));
      bot.clearControlStates();
      if (bot.entity.position.distanceTo(s) > 1.5) return;
    }
  }

  // 卡死兑底：服「劇毒-鶴頂丹」自杀 → 奈何桥满血满饱食（扣等级）。补货：東門外「有經驗的旅行者」(324,44,66) 1金粒/颗
  const isPoison = (i) => i.name === 'potion' && JSON.stringify(i.nbt || '').includes('鶴頂');
  async function suicide() {
    const it = bot.inventory.items().find(isPoison);
    if (!it) return { ok: false, reason: 'no-poison' };
    const dead = new Promise((r) => { bot.once('respawn', () => r(true)); setTimeout(() => r(false), 20000); });
    // 战斗层会每 tick 换回弓，先停掉，否则喝药被打断
    const wasOn = h.combat && h.combat.state().on; if (wasOn) h.combat.stop();
    bot.pathfinder.stop(); bot.clearControlStates();
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      try { await bot.equip(it, 'hand'); await bot.consume(); } catch {}
      ok = await Promise.race([dead, new Promise((r) => setTimeout(() => r(false), 4000))]);
    }
    if (!ok) ok = await dead;
    if (wasOn) setTimeout(() => h.combat.start(), 3000);
    await new Promise((r) => setTimeout(r, 2500));
    return { ok, pos: r3(pos()), left: bot.inventory.items().filter(isPoison).length };
  }
  h.suicide = suicide;

  async function escape(goal) {
    const s = bot.entity.position.clone();
    const g = Math.atan2(-(goal.x - s.x), -(goal.z - s.z));
    const yaws = [0, 1, -1, 2, -2, 3, -3, 4].map((k) => g + k * Math.PI / 4);
    for (const yaw of yaws) {
      const p0 = bot.entity.position.clone();
      await bot.look(yaw, 0, true);
      h.driveUntil = Date.now() + 2500; bot.setControlState('forward', true); bot.setControlState('jump', true);
      await new Promise((r) => setTimeout(r, 1200));
      bot.clearControlStates();
      await new Promise((r) => setTimeout(r, 300));
      if (bot.entity.position.distanceTo(p0) > 2.5) return true;
    }
    return false;
  }

  // 步行段包一层：记录走过的轨迹 → 区块评分 + 成功路径存成路点（下次规划复用）
  async function walk(goal, opts = {}) {
    const trail = [r3(pos())];
    const iv = setInterval(() => { const p = r3(pos()); const l = trail[trail.length - 1]; if (Math.hypot(p.x - l.x, p.z - l.z) >= 6) trail.push(p); }, 500);
    let r;
    try { r = await walkInner(goal, opts); } finally { clearInterval(iv); }
    trail.push(r3(pos()));
    if (h.chunks) h.chunks.walk(trail, r.ok, r.ok ? null : r3(pos()));
    if (r.ok && trail.length >= 3) rememberPath(trail);
    return r;
  }
  // 成功轨迹抽稀（每 ~20 格一个）加入 mem.roads；离已有路点 <8 格的不重复加
  function rememberPath(trail) {
    mem.roads = mem.roads || [];
    let last = trail[0], added = 0;
    for (const p of trail.slice(1)) {
      if (Math.hypot(p.x - last.x, p.z - last.z) < 20) continue;
      last = p;
      if (mem.roads.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 8 && Math.abs(q.y - p.y) < 4)) continue;
      mem.roads.push({ x: p.x, y: p.y, z: p.z, auto: 1 }); added++;
    }
    if (added) saveMem(mem);
  }

  async function walkInner(goal, opts = {}) {
    const { range = 1.5, maxFails = 4, deadline = Date.now() + 180000, log = [] } = opts;
    let fails = 0;
    let best = Math.hypot(pos().x - goal.x, pos().z - goal.z);
    while (Date.now() < deadline) {
      const p = pos();
      if (near(p, goal, range)) return { ok: true, log };
      const d = Math.hypot(p.x - goal.x, p.z - goal.z);
      // 近处直接交给 pathfinder
      if (d < 12) {
        try { await h.goto(goal.x, goal.y, goal.z, Math.max(1, Math.floor(range)), 12000); } catch (e) { log.push('near:' + String(e.message).slice(0, 40)); }
        if (near(pos(), goal, range)) return { ok: true, log };
      }
      // 宏观规划：地面图 BFS，到不了就取最近点
      const map = h.nav.buildGroundMap(Math.floor(p.x), Math.floor(p.z));
      const minY = Math.min(Math.floor(p.y), Math.floor(goal.y)) - 5;
      const nodes = h.nav.findPath(map, null, { x: Math.floor(goal.x), z: Math.floor(goal.z), y: goal.y }, 1, { partial: true, minY });
      if (!nodes || nodes.length < 2) {
        // 规划不出：直接让 pathfinder 朝目标试一段
        try { await h.goto(goal.x, goal.y, goal.z, Math.max(1, Math.floor(range)), 15000); } catch (e) { log.push('direct:' + String(e.message).slice(0, 40)); }
      } else {
        const wps = waypoints(nodes);
        for (const w of wps.slice(0, 8)) { // 每次最多走 8 个航点就重新规划
          try { await h.goto(w.x + 0.5, Math.round(w.y), w.z + 0.5, 1, 10000); }
          catch (e) {
            log.push('wp ' + w.x + ',' + w.y + ',' + w.z + ':' + String(e.message).slice(0, 30));
            // pathfinder 卡在台阶/楼梯背面时：朝航点跳着走一下（实测能翻过倒置楼梯/半砖）
            if (!near(pos(), w, 2) && /stall|timeout/.test(e.message)) {
              await hop(w); log.push('hop→' + Math.round(pos().x) + ',' + Math.round(pos().z));
              try { await h.goto(w.x + 0.5, Math.round(w.y), w.z + 0.5, 1, 8000); } catch {}
            }
            if (!near(pos(), w, 2)) break; // 这个航点到不了 → 重规划
          }
        }
      }
      const nd = Math.hypot(pos().x - goal.x, pos().z - goal.z);
      if (nd < best - 1) { best = nd; fails = 0; } else if (++fails >= maxFails) {
        // 目标被 NPC/方块占着时最后 1~2 格到不了：足够近就算到
        if (nd <= range + 2 && Math.abs(pos().y - goal.y) <= 2) return { ok: true, close: true, log };
        return { ok: false, reason: 'no-progress', left: +nd.toFixed(1), log };
      } else if (fails >= 1) {
        // 树林/蘑菇块里 pathfinder 常报 No path：八方向跳着挤出去，优先朝目标
        const m = await escape(goal);
        log.push('escape ' + (m ? 'moved' : 'none'));
      }
    }
    return { ok: false, reason: 'deadline', log };
  }

  // ---------- 使用传送阵 ----------
  async function usePortal(q) {
    const from = P(q.from);
    if (!near(pos(), from, 3)) {
      const r = await walk({ x: from.x + 0.5, y: from.y, z: from.z + 0.5 }, { range: 2.5 });
      if (!r.ok) return { ok: false, reason: 'cant-reach-portal', ...r };
    }
    // 最后几步用 look+forward 踩到中心（pathfinder 会避开压力板）
    const tp = new Promise((res) => { const f = () => res(true); bot.once('forcedMove', f); setTimeout(() => { bot.removeListener('forcedMove', f); res(false); }, 6000); });
    const c = from.offset(0.5, 0, 0.5);
    const t0 = Date.now();
    let moved = false;
    tp.then((v) => { moved = v; });
    while (!moved && Date.now() - t0 < 6000) {
      const p = pos();
      const dx = c.x - p.x, dz = c.z - p.z;
      if (Math.hypot(dx, dz) > 0.15) {
        bot.look(Math.atan2(-dx, -dz), 0, true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', bot.entity.isCollidedHorizontally);
      } else bot.clearControlStates();
      await h.sleep(100);
    }
    bot.clearControlStates();
    const ok = await tp;
    await h.sleep(800); // 等区块加载
    return { ok, at: r3(pos()) };
  }

  // ---------- 路线规划（Dijkstra：起点、终点、各传送阵入口/出口）----------
  // 步行代价 = 水平距离*1.2 + 垂直*3；传送 = 10。跨度太大的步行（>300）加罚，因为多半是两块不连通的地图。
  function walkCost(a, b) {
    const hd = Math.hypot(a.x - b.x, a.z - b.z), vd = Math.abs(a.y - b.y);
    let c = hd * 1.2 + vd * 3;
    if (h.chunks) c *= (h.chunks.costMul(a.x, a.z) + h.chunks.costMul(b.x, b.z) + h.chunks.costMul((a.x + b.x) / 2, (a.z + b.z) / 2)) / 3;
    if (hd > 60) c += (hd - 60) * 0.6;   // 长腿加罚（太大会绕远路） → 优先串已知路点（mem.roads）
    if (hd > 300) c *= 4;
    return c;
  }
  function plan(goal, banned) {
    const usable = mem.portals.filter((q) => !q.ban && !banned.has(q));
    const N = [{ p: r3(pos()) }, { p: goal }];
    usable.forEach((q) => N.push({ p: q.from, q, entry: true }, { p: q.to, q, exit: true }));
    (mem.roads || []).forEach((p) => N.push({ p, road: true }));
    const dist = N.map(() => Infinity), prev = N.map(() => -1), done = N.map(() => false);
    dist[0] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < N.length; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || dist[u] === Infinity || u === 1) break;
      done[u] = true;
      for (let v = 0; v < N.length; v++) {
        if (done[v] || v === u) continue;
        let c;
        if (N[u].entry && N[v].exit && N[u].q === N[v].q) c = 10;
        else if (N[v].exit) continue;          // 只能经由入口到达出口
        else if (N[u].entry) continue;         // 入口只能接自己的出口
        else c = walkCost(N[u].p, N[v].p);
        if (dist[u] + c < dist[v]) { dist[v] = dist[u] + c; prev[v] = u; }
      }
    }
    const steps = [];
    for (let i = 1; i !== -1 && i !== 0; i = prev[i]) steps.unshift(N[i]);
    // 转成动作：entry → 用传送阵；其余 → 步行
    const acts = [];
    for (const s of steps) {
      if (s.entry) acts.push({ type: 'portal', q: s.q });
      else if (s.exit) continue;
      else acts.push({ type: 'walk', p: s.p });
    }
    return { acts, cost: dist[1] };
  }

  async function travelTo(x, y, z, opts = {}) {
    let goal;
    if (typeof x === 'string') {
      const pl = mem.places[x];
      if (!pl) throw new Error('unknown place ' + x);
      goal = pl; opts = y || {};
      // 固定路线（mem.routes[name]）：先正常走到路线上离自己规划最近的点，再按航点顺序走
      const route = (mem.routes || {})[x];
      if (route && route.length && !opts._noRoute) {
        let bi = 0, bd = Infinity;
        route.forEach((q, i) => { const d = Math.hypot(q.x - pos().x, q.z - pos().z); if (d < bd) { bd = d; bi = i; } });
        const log = ['route ' + x + ' from #' + bi];
        for (let i = bi; i < route.length; i++) {
          const q = route[i];
          const r = await travelTo(q.x, q.y, q.z, { ...opts, range: i === route.length - 1 ? (opts.range || 1.5) : 3, _noRoute: true });
          const hz = Math.hypot(pos().x - q.x, pos().z - q.z);
          if (!r.ok && i < route.length - 1 && hz < 5) { r.ok = true; q.y = Math.floor(pos().y); saveMem(mem); } // 路点高度记错：水平到了就算到，并校正高度
          log.push('#' + i + (r.ok ? ' ok' : ' FAIL'));
          if (!r.ok) return { ...r, log: log.concat(r.log || []) };
        }
        return { ok: true, pos: r3(pos()), log };
      }
    } else goal = { x, y, z };
    const { range = 1.5, maxReplans = 4, suicideOnStuck = true } = opts;
    let usedSuicide = false;
    const banned = new Set();
    const log = [];
    for (let k = 0; k <= maxReplans; k++) {
      if (near(pos(), goal, range)) return { ok: true, pos: r3(pos()), log };
      const { acts } = plan(goal, banned);
      log.push('plan: ' + acts.map((a) => a.type === 'portal' ? 'TP(' + [a.q.from.x, a.q.from.y, a.q.from.z] + ')' : 'walk(' + [a.p.x, a.p.y, a.p.z] + ')').join(' → '));
      let failed = false;
      for (const a of acts) {
        if (a.type === 'walk') {
          const r = await walk(a.p, { range: a.p === goal ? range : 2, log });
          if (!r.ok) {
            log.push('walk fail ' + r.reason); failed = true;
            // 野外卡死（离目标还远）→ 服毒回奈何桥，从村子重新规划（每次 travel 最多一次）
            if (suicideOnStuck && !h.noSuicide && !usedSuicide && r.reason === 'no-progress' && ((r.left || 0) > 15 || pos().y < a.p.y - 6)) {
              usedSuicide = true;
              const s = await suicide();
              log.push('suicide ' + JSON.stringify(s));
            }
            break;
          }
        } else {
          const r = await usePortal(a.q);
          if (!r.ok) { log.push('portal fail ' + JSON.stringify(a.q.from)); banned.add(a.q); failed = true; break; }
          // 实际出口与记忆不符 → 已在 learn 里更新；重规划
          if (P(a.q.to).distanceTo(pos()) > 6) { failed = true; break; }
        }
      }
      if (!failed && near(pos(), goal, range)) return { ok: true, pos: r3(pos()), log };
      if (!failed) continue;
    }
    return { ok: false, pos: r3(pos()), log: log.slice(-30) };
  }

  h.mem = {
    data: mem,
    save: () => saveMem(mem),
    mark: (name, p = r3(pos())) => { mem.places[name] = p; saveMem(mem); return p; },
    ban: (x, y, z, why = '') => {
      let q = findPortal({ x, y, z });
      if (!q) { q = { from: { x, y, z }, to: null, kind: 'manual', uses: 0 }; mem.portals.push(q); }
      q.ban = why || true; saveMem(mem); syncAvoid(); return q;
    },
    addPortal: (from, to, note) => { learn(from, to, 'manual'); const q = findPortal(from); if (note) q.note = note; saveMem(mem); return q; },
    // 路点：走通过的路上的点（路口/城门/路牌），规划时会串起来走，避开树林直穿
    road: (x, y, z) => { mem.roads = mem.roads || []; mem.roads.push({ x, y, z }); saveMem(mem); return mem.roads.length; },
    portals: () => mem.portals.map((q) => ({ from: q.from, to: q.to, uses: q.uses, ban: q.ban, note: q.note })),
  };
  travelTo.plan = (g) => plan(g, new Set());
  return travelTo;
};
