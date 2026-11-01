// nav.js — 地形感知导航层 for command-block RPG maps (盘灵古域).
// 替代 A* 体素寻路。这个图的房间浮空/埋地下，外面是虚空，A* 会把虚空当可走格。
// 方案：**多层地面高度图**——每 (x,z) 柱可存多个可站立高度（处理悬空走道/台阶层），
// 在其上做 BFS 于 (x,z,h) 三元组（8邻接，允许上台阶 Δh<=1、下坡 Δh<=3），得到实体可行走路径，
// 然后 look+forward+jump 逐格走。天然规避：虚空柱=无地面不可走；传送板不踩；水格站不上。
const Vec3 = require('vec3');

const PLATE = new Set(['stone_pressure_plate', 'wooden_pressure_plate', 'light_weighted_pressure_plate', 'heavy_weighted_pressure_plate']);
const WATER = new Set(['water', 'flowing_water']);
const AIR = new Set(['air', 'cave_air', 'void_air']);

// Block top-surface height (Y offset of the highest collision surface), or -1 if not solid.
// Full blocks: 1.0. Upper half-slab: 1.0 (it occupies the top half — stand on top). Lower half-slab: 0.5.
// Stairs: uses the full-box top (0.5 for low half, 1.0 for back half). Non-solid (air/water/plates-as-walk): -1.
function blockTop(b) {
  if (!b) return -1;
  if (b.boundingBox === 'empty') return -1; // air / water / non-colliding
  if (b.shapes && Array.isArray(b.shapes) && b.shapes.length) {
    // top surface = max shape[5] (y2). Use it to know where the bot can stand ON this block.
    let top = -1;
    for (const s of b.shapes) top = Math.max(top, s[5]);
    return top;
  }
  if (b.boundingBox === 'block') return 1; // full solid
  return 1; // default solid
}
function isSolid(b) { return blockTop(b) >= 0.5; }
function isWater(b) { return b && WATER.has(b.name); }
function isAir(b) { return !b || AIR.has(b.name); }
function isPlate(b) { return b && PLATE.has(b.name); }
function isStandable(b) { return isSolid(b) || isWater(b); }

function nav(bot, h) {
  const cfg = { scanRadius: 64, scanUp: 28, scanDown: 26, maxStepUp: 1, maxStepDown: 3 };

  // Collect ALL standable heights for a column: heights h where blockAt(x,h,z) is solid,
  // blockAt(x,h+1,z) is air (can stand), blockAt(x,h+2,z) is air-or-low (headroom), and not a plate.
  function columnHeights(x, z, yRef) {
    const hs = [];
    const yMax = yRef + cfg.scanUp, yMin = yRef - cfg.scanDown;
    for (let y = yMax; y >= yMin; y--) {
      const b = bot.blockAt(new Vec3(x, y, z), false);
      if (!isSolid(b)) continue;
      const top = blockTop(b);
      // stand surface = block bottom + top. Feet stand at y + top.
      const standY = y + top;
      // standing cell must be air (or a lower slab) — allow low headroom
      const cell = bot.blockAt(new Vec3(x, y + 1, z), false);
      if (!isAir(cell) && !(cell && isSolid(cell) && blockTop(cell) < 0.4)) continue;
      if (isPlate(b)) continue;
      hs.push({ x, z, y: standY, topY: y, top });
    }
    // Water surface node: bot floats on topmost water block.
    for (let y = yMax; y >= yMin; y--) {
      const wb = bot.blockAt(new Vec3(x, y, z), false);
      if (isWater(wb)) {
        const above = bot.blockAt(new Vec3(x, y + 1, z), false);
        if (isAir(above)) { hs.push({ x, z, y: y + 1, topY: y, water: true }); break; }
      }
    }
    return hs;
  }

  // Build multi-level ground map. Returns Map key "x,z" -> array of standing-height nodes.
  function buildGroundMap(cx, cz, radius = cfg.scanRadius) {
    const map = new Map();
    const yRef = bot.entity.position.y;
    for (let x = cx - radius; x <= cx + radius; x++) {
      for (let z = cz - radius; z <= cz + radius; z++) {
        const hs = columnHeights(x, z, yRef);
        if (hs.length) map.set(x + ',' + z, hs);
      }
    }
    return map;
  }

  // BFS over (x,z,h) triples. start/goal are {x,z} (start h = bot's actual feet).
  // Neighbors: 8-dir, |dh| <= maxStepUp (up) or <= maxStepDown (down). Cost euclid.
  // Returns array of {x,z,y} nodes (dedup by (x,z,y)) start->goal, or null.
  function findPath(map, start, goal, goalR = 1, fopts = {}) {
    const p = bot.entity.position;
    const startH = Math.floor(p.y);
    // bot's actual column = the block its feet occupy (floor(x)).
    const sx = Math.floor(p.x), sz = Math.floor(p.z);
    const startCol = map.get(sx + ',' + sz);
    if (!startCol || !startCol.length) return null;
    let sn = startCol[0];
    for (const c of startCol) if (Math.abs(c.y - startH) < Math.abs(sn.y - startH)) sn = c;
    const key = (x, z, y) => x + ',' + z + ',' + y;
    const dist = new Map([[key(sn.x, sn.z, sn.y), 0]]);
    const prev = new Map();
    const q = [{ ...sn }];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    let found = null;
    let guard = 0;
    // partial mode: remember the reachable node closest to the goal (horizontal, then vertical)
    let closest = sn, closestD = Infinity;
    const gd = (n) => Math.hypot(n.x - goal.x, n.z - goal.z) + (goal.y != null ? Math.abs(n.y - goal.y) * 0.5 : 0);
    while (q.length && guard < 400000) {
      guard++;
      const cur = q.shift();
      const cdg = gd(cur);
      if (cdg < closestD) { closestD = cdg; closest = cur; }
      if (Math.abs(cur.x - goal.x) <= goalR && Math.abs(cur.z - goal.z) <= goalR) { found = cur; break; }
      const ck = key(cur.x, cur.z, cur.y);
      const cd = dist.get(ck);
      for (const [dx, dz] of dirs) {
        const nx = cur.x + dx, nz = cur.z + dz;
        const col = map.get(nx + ',' + nz);
        if (!col) continue;
        for (const n of col) {
          const dy = n.y - cur.y;
          if (dy > cfg.maxStepUp || dy < -cfg.maxStepDown) continue;
          if (fopts.minY != null && n.y < fopts.minY) continue; // 不下到坑里（坑里多半出不来）
          const nk = key(n.x, n.z, n.y);
          const nd = cd + (dx && dz ? Math.SQRT2 : 1);
          if (nd < (dist.get(nk) ?? Infinity)) {
            dist.set(nk, nd); prev.set(nk, cur); q.push(n);
          }
        }
      }
    }
    if (!found && fopts.partial) found = closest;
    if (!found) return null;
    const path = [];
    let c = found;
    while (c) { path.unshift(c); c = prev.get(key(c.x, c.z, c.y)); }
    return path;
  }

  // Walk a path: look toward next node, forward (+jump if step up). Timeout & stall detection.
  async function walkPath(path, opts = {}) {
    const { perNodeMs = 4500, stallMs = 3000, maxNodes = 400 } = opts;
    let reached = 0;
    // skip node 0 if bot is already at/near it (start node)
    let i = 0;
    const p0 = bot.entity.position;
    // Skip node 0 if the bot is horizontally at that column — it is effectively "on" node0's (x,z).
    // The dy mismatch is a map-rounding artifact (bot on a neighboring column's floor);
    // targeting node1 onward is correct and the bot walks/steers toward it.
    // Only skip node0 if the bot is truly AT it (feet == node0.y AND same column).
    if (path[0] && Math.abs(path[0].y - p0.y) < 0.4 && Math.hypot(path[0].x - p0.x, path[0].z - p0.z) < 0.6) i = 1;
    for (; i < path.length; i++) {
      const n = path[i];
      const t0 = Date.now();
      let lastMove = Date.now();
      let lastPos = bot.entity.position.clone();
      while (Date.now() - t0 < perNodeMs) {
        const p = bot.entity.position;
        const dx = n.x - p.x, dz = n.z - p.z;
        const d = Math.hypot(dx, dz);
        const dyFeet = n.y - p.y;
        if (d < 0.6 && Math.abs(dyFeet) < 1.2) { reached = i + 1; break; }
        // If the bot is already at/below the node's height AND within 1 block horizontally,
        // it's effectively at the node — accept it and move on (prevents oscillation on climbs).
        if (dyFeet < 0.4 && d < 1.1) { reached = i + 1; break; }
        // Skip the node if it's already at/below the bot (bot is past it) AND horizontally far from it —
        // the bot overshot; move to next node instead of backtracking.
        if (dyFeet < -1.5 && d > 2.5) { reached = i + 1; break; }
        const yaw = Math.atan2(-dx, -dz);
        bot.look(yaw, 0, true);
        bot.setControlState('forward', true);
        if (dyFeet > 0.25 || bot.entity.isCollidedHorizontally) bot.setControlState('jump', true);
        else bot.setControlState('jump', false);
        const hd = Math.hypot(p.x - lastPos.x, p.z - lastPos.z);
        if (hd > 0.25) { lastPos = p.clone(); lastMove = Date.now(); }
        else if (Date.now() - lastMove > stallMs) {
          // unstick: back up, jump-spam, re-approach. Retry up to 3x.
          let unstuck = false;
          for (let k = 0; k < 3; k++) {
            bot.setControlState('forward', false);
            bot.setControlState('back', true);
            bot.setControlState('jump', true);
            await h.sleep(400);
            bot.setControlState('back', false);
            bot.setControlState('forward', true);
            bot.setControlState('jump', true);
            await h.sleep(700);
            const hd2 = Math.hypot(bot.entity.position.x - lastPos.x, bot.entity.position.z - lastPos.z);
            if (hd2 > 0.4) { unstuck = true; break; }
          }
          bot.setControlState('jump', false);
          if (!unstuck) { bot.clearControlStates(); throw new Error('nav-stall at ' + n.x + ',' + n.z + ' (node ' + i + '/' + path.length + ')'); }
          lastMove = Date.now();
        }
        await h.sleep(100);
      }
      bot.clearControlStates();
      if (reached !== i + 1) { bot.clearControlStates(); throw new Error('nav-timeout at ' + n.x + ',' + n.z + ' (node ' + i + '/' + path.length + ')'); }
      if (i >= maxNodes) break;
    }
    bot.clearControlStates();
    return { reached, total: path.length };
  }

  const api = {
    cfg, columnHeights, buildGroundMap, findPath, walkPath,
    async navigate(start, goal, opts = {}) {
      const { goalR = 1, retries = 2 } = opts;
      const sx = Math.round(start.x), sz = Math.round(start.z);
      const map = buildGroundMap(sx, sz);
      let path = findPath(map, { x: sx, z: sz }, { x: goal.x, z: goal.z }, goalR);
      if (!path) return { ok: false, reason: 'no-path', mapSize: map.size };
      try {
        const r = await walkPath(path, opts);
        return { ok: true, path, ...r };
      } catch (e) {
        if (retries > 0) return api.navigate(bot.entity.position, goal, { ...opts, retries: retries - 1 });
        return { ok: false, reason: String(e.message || e), path, mapSize: map.size };
      }
    },
  };
  return api;
}

module.exports = nav;
