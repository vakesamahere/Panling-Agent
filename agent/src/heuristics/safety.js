// Safety/navigation layers for mineflayer on command-block RPG maps (盘灵古域).
// - water.js: per-tick swim-up when in water; auto-steer to nearest shore. Prevents drowning.
// - roomnav.js: teleport-room navigation. Do NOT use pathfinder inside these rooms; scan
//   pressure plates / buttons / portals and walk onto them with look+forward until a
//   forcedMove/teleport event fires. Rooms are floating/underground voids — voxel pathfinding
//   treats void as walkable and gets confused, so we bypass it entirely.
const Vec3 = require('vec3');

function water(bot, h) {
  const cfg = { jumpEveryTick: true, steerToShore: true, maxSpeed: 0.3 };
  const st = { on: false, saved: null };
  function shoreDir() {
    // find nearest non-water walkable block within 6, return yaw toward it
    const p = bot.entity.position.floored();
    let best = null; let bd = 1e9;
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
      if (!dx && !dz) continue;
      const q = p.offset(dx, 0, dz);
      const b = bot.blockAt(q);
      const under = bot.blockAt(q.offset(0, -1, 0));
      const d = Math.hypot(dx, dz);
      if (b && under && b.name === 'air' && under.name !== 'water' && under.name !== 'flowing_water' && d < bd) {
        bd = d; best = q;
      }
    }
    if (!best) return null;
    const dy = bot.entity.position.y - p.y;
    return Math.atan2(-(best.x - p.x), -(best.z - p.z));
  }
  function tick() {
    if (!st.on) return;
    const e = bot.entity;
    if (e.isInWater || (e.position.y < (e.lastPosition ? e.lastPosition.y : 0) && e.position.y > 0 && e.position.y < -0 && false)) {
      // in water: hold jump to float up
      bot.setControlState('jump', true);
      st.held = true;
      // only steer when nobody else (pathfinder/travel) is driving
      if (cfg.steerToShore && !bot.pathfinder.isMoving() && !(h && h.driveUntil > Date.now())) {
        const yaw = shoreDir();
        if (yaw !== null) { bot.look(yaw, -0.2, true); bot.setControlState('forward', true); }
      }
    } else if (st.held) {
      // release ONLY keys we pressed; never stomp other movers every tick
      st.held = false;
      bot.setControlState('jump', false);
      if (!bot.pathfinder.isMoving()) bot.setControlState('forward', false);
    }
  }
  const api = {
    start() { st.on = true; bot.on('physicsTick', tick); return 'water-safety on'; },
    stop() { st.on = false; bot.removeListener('physicsTick', tick); bot.setControlState('jump', false); bot.setControlState('forward', false); return 'water-safety off'; },
    state: () => ({ on: st.on, inWater: bot.entity.isInWater, y: +bot.entity.position.y.toFixed(2) }),
  };
  return api;
}

// Teleport-room navigator. `room` = {plates:[{p,need}], name}. Steps: list triggers via scan, then walk.
function roomnav(bot, h) {
  const st = { on: false };
  const TRIGGERS = ['stone_pressure_plate', 'wooden_pressure_plate', 'light_weighted_pressure_plate', 'heavy_weighted_pressure_plate', 'stone_button', 'wooden_button', 'lever', 'portal', 'end_portal', 'trapdoor', 'wooden_door', 'iron_door'];
  async function triggers(r = 12) {
    return bot.findBlocks({ matching: (b) => b && TRIGGERS.includes(b.name), maxDistance: r, count: 100 })
      .map((q) => { const b = bot.blockAt(q); return { p: q, n: b.name, text: (b.signText || '').replace(/\n/g, ' ') }; })
      .sort((a, b) => a.p.distanceTo(bot.entity.position) - b.p.distanceTo(bot.entity.position));
  }
  async function walkTo(q, ms = 5000) {
    const p0 = bot.entity.position.clone();
    const t0 = Date.now();
    let last = Date.now();
    const mover = setInterval(() => {
      const d = q.clone().subtract(bot.entity.position);
      const yaw = Math.atan2(-d.x, -d.z);
      const pitch = -Math.atan2(d.y, Math.hypot(d.x, d.z));
      bot.look(yaw, pitch, true);
      bot.setControlState('forward', true);
      if (Math.abs(d.x) + Math.abs(d.z) > 0.5) bot.setControlState('jump', bot.entity.isCollidedHorizontally);
      last = Date.now();
    }, 100);
    // wait for teleport event or arrival or timeout
    return new Promise((resolve) => {
      const done = (why) => { clearInterval(mover); bot.clearControlStates(); resolve(why); };
      const onMove = () => done('teleport:' + JSON.stringify(bot.entity.position.floored()));
      bot.once('forcedMove', onMove);
      bot.once('teleport', onMove);
      bot.once('death', () => done('death'));
      setTimeout(() => {
        bot.removeListener('forcedMove', onMove); bot.removeListener('teleport', onMove);
        if (bot.entity.position.distanceTo(q) < 1.2) done('arrived');
        else if (Date.now() - last > 2500) done('stuck');
        else { setTimeout(() => { bot.removeListener('forcedMove', onMove); bot.removeListener('teleport', onMove); done('timeout'); }, 4000); }
      }, ms);
    });
  }
  const api = {
    // find all plates/buttons/portals around, dedupe by proximity
    triggers,
    // walk onto each trigger in order until teleport fires; returns which one triggered
    async tryAll(r = 12, perMs = 3500) {
      const ts = await triggers(r);
      for (const t of ts) {
        const why = await walkTo(t.p, perMs);
        if (why.startsWith('teleport:')) return { why, trigger: t };
        if (why === 'death') return { why };
      }
      return { why: 'none', count: ts.length };
    },
    walkTo, state: () => ({ on: st.on }),
  };
  return api;
}

module.exports = { water, roomnav, stairnav };

// BFS stair/terrace walker: find a walkable path (jump up to `step` blocks) from current pos
// to a target xz, then walk it with look+forward+jump. Avoids triggering teleport plates
// by treating pressure_plate blocks as non-walkable (we jump over/around them).
// Only for outdoor/terrain navigation; not for teleport rooms.
function stairnav(bot, h) {
  const stepUp = 1; // max block height we can jump up
  const PLATE = new Set(['stone_pressure_plate', 'wooden_pressure_plate', 'light_weighted_pressure_plate', 'heavy_weighted_pressure_plate']);
  function V(x, y, z) { return new Vec3(x, y, z); }
  function solid(u) {
    if (!u) return false;
    // mineflayer 1.8: boundingBox is the string 'block' for full solids; or object with height
    if (u.boundingBox === 'block') return true;
    if (u.boundingBox && typeof u.boundingBox === 'object' && u.boundingBox.height >= 0.5) return true;
    // fallback: use shapes (some blocks give [[0,0,0,1,1,1]])
    if (u.shapes && Array.isArray(u.shapes) && u.shapes.length) {
      return u.shapes.some((s) => (s[5] - s[2]) >= 0.5);
    }
    return false;
  }
  function walkable(p) {
    const b = bot.blockAt(V(p.x, p.y, p.z));
    if (!b || b.name !== 'air') return false;
    const u = bot.blockAt(V(p.x, p.y - 1, p.z));
    if (!solid(u)) return false;
    if (PLATE.has(u.name)) return false; // avoid stepping on teleport plates
    return true;
  }
  function passableFrom(from, to) {
    // can we stand on `to` coming from `from`?
    if (!walkable(to)) return false;
    const fromY = from.y, toY = to.y;
    // headroom
    const head = bot.blockAt(V(to.x, to.y + 1, to.z));
    if (head && head.boundingBox) return false;
    return toY - fromY <= stepUp && fromY - toY <= 2;
  }
  async function find(start, goal, range = 40) {
    // BFS on grid; start/goal are Vec3-ish {x,y,z}
    const key = (p) => p.x + ',' + p.y + ',' + p.z;
    const startK = key(start);
    const visited = new Set([startK]);
    const q = [start];
    const prev = new Map();
    const goalXZ = [goal.x, goal.z];
    let found = null;
    let guard = 0;
    while (q.length && guard < 6000) {
      const cur = q.shift(); guard++;
      if (Math.abs(cur.x - goalXZ[0]) <= 1 && Math.abs(cur.z - goalXZ[1]) <= 1) { found = cur; break; }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const np = { x: cur.x + dx, y: cur.y, z: cur.z + dz };
        // same level
        if (walkable(np) && !visited.has(key(np))) {
          visited.add(key(np)); prev.set(key(np), cur); q.push(np);
          if (Math.abs(np.x - goalXZ[0]) <= 1 && Math.abs(np.z - goalXZ[1]) <= 1) { found = np; }
        }
        // up/down a block
        for (const dy of [1, -1]) {
          const up = { x: np.x, y: cur.y + dy, z: np.z };
          if (passableFrom(cur, up) && !visited.has(key(up))) {
            visited.add(key(up)); prev.set(key(up), cur); q.push(up);
          }
        }
      }
      if (found) break;
    }
    if (!found) return null;
    // reconstruct
    const path = [];
    let c = found;
    while (c && key(c) !== startK) { path.push(c); c = prev.get(key(c)); }
    path.reverse();
    return path;
  }
  async function walkPath(path) {
    for (const w of path) {
      const p = bot.entity.position;
      const d = { x: w.x - p.x, y: w.y - p.y, z: w.z - p.z };
      const yaw = Math.atan2(-d.x, -d.z);
      const pitch = -Math.atan2(d.y, Math.hypot(d.x, d.z));
      bot.look(yaw, pitch, true);
      bot.setControlState('forward', true);
      if (d.y > 0.3) bot.setControlState('jump', true);
      const t0 = Date.now();
      while (Date.now() - t0 < 900) {
        const pp = bot.entity.position;
        if (Math.hypot(pp.x - w.x, pp.z - w.z) < 0.6 && Math.abs(pp.y - w.y) < 1.2) break;
        if (pp.x !== w.x || pp.z !== w.z) { bot.look(yaw, pitch, true); }
        await h.sleep(80);
      }
      bot.setControlState('forward', false); bot.setControlState('jump', false);
    }
    return true;
  }
  const api = {
    find,
    // goto by walking stairs; returns {ok,path,pos}
    async goto(x, y, z, range = 40) {
      bot.pathfinder.stop(); bot.clearControlStates();
      const start = bot.entity.position.floored();
      const path = await find(start, { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }, range);
      if (!path || !path.length) return { ok: false, pos: bot.entity.position.floored() };
      await walkPath(path);
      return { ok: true, path: path.length, pos: bot.entity.position.floored() };
    },
  };
  return api;
}
