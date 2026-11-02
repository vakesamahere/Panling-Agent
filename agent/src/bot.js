// Mineflayer agent for the local 盘灵古域 server.
// Control API: POST http://127.0.0.1:3001/eval with JS body; evaluated with `bot`, helpers in scope.
// Bound to 127.0.0.1 only, no auth — local testing use.
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const http = require('http');
const fs = require('fs');
const path = require('path');

const NAME = process.argv[2] || 'KiroBot';
// 线上模式：ONLINE=1 node bot.js —— 用 HMCL 缓存的微软 token 进 AOS 服；关掉所有控制台作弊（buff/give/cmd），禁止发言
const ONLINE = process.env.ONLINE === '1';
const LOGF = require('./paths').log(ONLINE ? 'bot_online.log' : 'bot.log');
const API_PORT = ONLINE ? 3002 : 3001, VIEW_PORT = ONLINE ? 3008 : 3007;
const events = []; // rolling event buffer, drained by /events
function ev(type, data) {
  const e = { t: new Date().toISOString().slice(11, 19), type, ...data };
  events.push(e);
  if (events.length > 500) events.shift();
  fs.appendFileSync(LOGF, JSON.stringify(e) + '\n');
}

process.on('unhandledRejection', (e) => ev('error', { e: 'unhandled: ' + String(e).slice(0, 300) }));
process.on('uncaughtException', (e) => ev('error', { e: 'uncaught: ' + String(e && e.stack || e).slice(0, 300) }));
function hmclAuth() {
  // 从 HMCL accounts.json 取已登录的正版号（不打印 token）
  const f = path.join(process.env.APPDATA, '.hmcl', 'accounts.json');
  const a = JSON.parse(fs.readFileSync(f, 'utf8')).find((x) => x.type === 'microsoft' && x.displayName === (process.env.MC_ACCOUNT || 'vakesamahere'));
  if (!a) throw new Error('hmcl account not found');
  if (a.notAfter < Date.now() + 10 * 60000) throw new Error('hmcl token expired, open HMCL to refresh');
  return (client, options) => {
    client.username = a.displayName;
    client.session = { accessToken: a.accessToken, selectedProfile: { id: a.uuid, name: a.displayName }, availableProfile: [] };
    options.accessToken = a.accessToken; options.haveCredentials = true;
    options.connect(client);
  };
}
const bot = ONLINE
  ? mineflayer.createBot({ host: process.env.MC_HOST || 'vat-n64.mutong1.com', port: +(process.env.MC_PORT || 21145), username: 'vakesamahere', auth: hmclAuth(), version: '1.8.8' })
  : mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: NAME, version: '1.8.8' });
if (ONLINE) { // 线上绝不发言（服规 + 用户要求）
  const blocked = () => { ev('blocked-chat', {}); };
  bot.once('inject_allowed', () => { bot.chat = blocked; bot.whisper = blocked; });
  bot.chat = blocked; bot.whisper = blocked;
}
bot.loadPlugin(pathfinder);

bot.on('login', () => ev('login', {}));
bot.on('spawn', () => {
  // Map-aware Movements: void impassable, no digging, no parkour, water costly.
  const NavMovements = require('./heuristics/navmovements');
  const m = new NavMovements(bot);
  bot.pathfinder.setMovements(m);
  ev('spawn', { pos: bot.entity.position.floored() });
  setTimeout(() => h.buff && h.buff(), 1500);
});
bot.on('message', (msg, pos) => ev('chat', { pos, text: msg.toString() }));
bot.on('title', (text, type) => ev('title', { type, text: String(text) }));
bot.on('death', () => ev('death', {}));
bot.on('health', () => ev('health', { hp: bot.health, food: bot.food }));
// auto-eat when food low (bot starved to death while stuck — had bread but never ate)
// 每 5 秒也检查一次：health 事件只在血/饱食变化时触发，某次没吃成（被换手打断）后血饱食都不再变就永远不吃了（10/31 13:48 回血卡在 hp10 food17）
const autoEat = async () => {
  if (bot.food < 18 && !bot._eating) {
    try {
      bot._eating = true;
      const FOODS = ['cooked_beef','cooked_porkchop','bread','baked_potato','cooked_chicken','cooked_mutton','cooked_fish','cooked_rabbit','apple','carrot','potato','melon','cookie','mushroom_stew','pumpkin_pie','golden_carrot','beef','porkchop','chicken','mutton','fish'];
      const bread = FOODS.map((n) => bot.inventory.items().find((i) => i.name === n)).find(Boolean);
      if (!bread && bot.food < 6) ev('hungry-no-food', { food: bot.food, hp: bot.health });
      if (bread) {
        await bot.equip(bread, 'hand');
        await bot.consume();
      }
    } catch {}
    bot._eating = false;
  }
};
bot.on('health', autoEat);
setInterval(() => { if (bot.entity) autoEat(); }, 5000);
bot.on('kicked', (r) => ev('kicked', { r: String(r) }));
bot.on('end', (r) => { ev('end', { r }); setTimeout(() => process.exit(1), 500); });
bot.on('error', (e) => ev('error', { e: String(e) }));
bot.on('windowOpen', (w) => ev('window', { title: String(w.title), slots: w.slots.filter(Boolean).map((s) => ({ slot: s.slot, name: s.name, n: s.count, dn: s.customName || s.displayName })) }));
bot.on('forcedMove', () => ev('teleport', { pos: bot.entity.position.floored() }));

// ---- helpers available inside /eval ----
const h = {
  goals,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  pos: () => bot.entity.position.floored(),
  // nearby entities, sorted by distance
  ents: (r = 16) => Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position.distanceTo(bot.entity.position) <= r)
    .map((e) => ({ id: e.id, type: e.type, name: e.name || e.mobType, user: e.username, cn: e.metadata && e.metadata[2], d: +e.position.distanceTo(bot.entity.position).toFixed(1), p: e.position.floored() }))
    .sort((a, b) => a.d - b.d),
  // text from signs within radius
  signs: (r = 12) => {
    const out = [];
    const bp = bot.entity.position.floored();
    for (const be of Object.values(bot.world.columns || {})) void be;
    const blocks = bot.findBlocks({ matching: (b) => b && (b.name === 'standing_sign' || b.name === 'wall_sign'), maxDistance: r, count: 64 });
    for (const p of blocks) {
      const b = bot.blockAt(p);
      const t = b.signText || (b.getSignText ? b.getSignText().join('|') : '');
      out.push({ p, t: String(t).replace(/\n/g, ' | ') });
    }
    return out.sort((a, b) => a.p.distanceTo(bp) - b.p.distanceTo(bp));
  },
  inv: () => bot.inventory.items().map((i) => ({ slot: i.slot, name: i.name, n: i.count, dn: i.customName, lore: loreOf(i) })),
  // book pages (written_book in hand / given item)
  book: (item) => { const n = item && item.nbt; try { return n.value.pages.value.value.map((p) => p); } catch { return null; } },
  goto: (x, y, z, range = 1, timeoutMs = 8000) => {
    // Smart goto: pathfinder can hang/loop on command-block maps & water pockets.
    // Watchdog: abort if position doesn't change for stallMs, or after timeoutMs.
    const target = new goals.GoalNear(x, y, z, range);
    const g = bot.pathfinder.goto(target);
    let lastPos = bot.entity.position.clone();
    let lastMove = Date.now();
    const stallMs = Math.min(3500, timeoutMs / 2);
    let finished = false, toTimer = null, stallIv = null;
    const timer = setInterval(() => {
      const p = bot.entity.position;
      // horizontal displacement only — bobbing in water / on void shouldn't count as progress
      const hd = Math.hypot(p.x - lastPos.x, p.z - lastPos.z);
      if (hd > 0.4) { lastPos = p.clone(); lastMove = Date.now(); }
    }, 400);
    // cleanup ALL timers; only stop the pathfinder if THIS goto is still the active one
    const cleanup = () => { finished = true; clearInterval(timer); clearInterval(stallIv); clearTimeout(toTimer); };
    const abort = () => { if (finished) return; cleanup(); bot.pathfinder.stop(); bot.clearControlStates(); };
    return Promise.race([
      g.then(() => { cleanup(); }, (e) => { cleanup(); throw e; }),
      new Promise((_, rej) => { toTimer = setTimeout(() => { if (finished) return; abort(); rej(new Error('goto-timeout ' + Math.round(x) + ',' + Math.round(y) + ',' + Math.round(z))); }, timeoutMs); }),
      new Promise((_, rej) => {
        stallIv = setInterval(() => {
          if (finished) return;
          if (Date.now() - lastMove > stallMs) { abort(); rej(new Error('goto-stall ' + Math.round(x) + ',' + Math.round(y) + ',' + Math.round(z))); }
        }, 500);
      }),
    ]);
  },
  look: (x, y, z) => bot.lookAt(new (require('vec3'))(x, y, z)),
  blockAt: (x, y, z) => { const b = bot.blockAt(new (require('vec3'))(x, y, z)); return b && { name: b.name, md: b.metadata }; },
  // what's around: compact block-name histogram + interactables
  scan: (r = 8) => {
    const names = ['stone_button', 'wooden_button', 'lever', 'stone_pressure_plate', 'wooden_pressure_plate', 'chest', 'trapped_chest', 'wooden_door', 'iron_door', 'trapdoor', 'command_block', 'ender_chest', 'enchanting_table', 'anvil', 'brewing_stand', 'beacon'];
    const found = bot.findBlocks({ matching: (b) => b && names.includes(b.name), maxDistance: r, count: 100 });
    return found.map((p) => ({ n: bot.blockAt(p).name, p }));
  },
  scoreboard: () => Object.values(bot.scoreboards || {}).map((s) => ({ name: s.name, title: s.title, items: s.items && s.items.map((i) => [i.name, i.value]) })),
};
// read all trades of a villager NPC (dialogue = trade items)
h.lore = (i) => { try { return i.nbt.value.display.value.Lore.value.value.join('/').replace(/§./g, ''); } catch { return ''; } };
h.nm = (i) => i && String(i.customName || i.name).replace(/§./g, '') + 'x' + i.count;
h.talk = async (idOrName) => {
  const e = typeof idOrName === 'number' ? bot.entities[idOrName] : Object.values(bot.entities).filter((x) => x.type === 'mob' && String(x.metadata?.[2] || '').includes(idOrName)).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
  if (!e) return 'no npc';
  if (e.position.distanceTo(bot.entity.position) > 3) { try { await h.goto(e.position.x, e.position.y, e.position.z, 2); } catch {} }
  const v = await bot.openVillager(e);
  const r = v.trades.map((t, i) => ({ i, in1: h.nm(t.inputItem1), in2: t.inputItem2 && h.nm(t.inputItem2), out: h.nm(t.outputItem), lore: h.lore(t.outputItem).slice(0, 300), dis: t.tradeDisabled }));
  v.close();
  return { npc: String(e.metadata?.[2] || '').replace(/§./g, ''), id: e.id, r };
};
// perform trade #idx once (no shift-click!). Uses MC|TrSel to select page, then manual click.
h.npc = (n) => typeof n === 'number' ? bot.entities[n] : Object.values(bot.entities).filter((x) => x.type === 'mob' && String(x.metadata?.[2] || '').includes(n)).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
h.trade = async (id, idx) => {
  const e = h.npc(id);
  if (e.position.distanceTo(bot.entity.position) > 3) { try { await h.goto(e.position.x, e.position.y, e.position.z, 2); } catch {} }
  const v = await bot.openVillager(e);
  await h.sleep(200);
  const t = v.trades[idx];
  bot._client.write('custom_payload', { channel: 'MC|TrSel', data: Buffer.from([0, 0, 0, idx]) });
  await h.sleep(200);
  const put = async (it, slot) => {
    if (!it) return;
    const src = v.slots.slice(3).find((s) => s && s.type === it.type && s.metadata === it.metadata && (s.customName || '') === (it.customName || ''));
    if (!src) throw new Error('missing ' + h.nm(it));
    await bot.clickWindow(src.slot, 0, 0); await h.sleep(100);
    await bot.clickWindow(slot, 0, 0); await h.sleep(100);
  };
  try {
    await put(t.inputItem1, 0); await put(t.inputItem2, 1);
    await h.sleep(300);
    // 1.8: output slot (2) is often not synced to client -> click it blindly (NEVER shift), then drop cursor in an empty slot
    const before = bot.inventory.items().map(h.nm).join(',');
    try { await bot.clickWindow(2, 0, 0); } catch {}
    await h.sleep(300);
    const fe = v.slots.findIndex((x, i) => i >= 3 && !x);
    try { await bot.clickWindow(fe, 0, 0); } catch {}
    await h.sleep(200);
    for (const s of [0, 1]) if (v.slots[s]) { try { await bot.clickWindow(s, 0, 1); } catch {} await h.sleep(100); }
    v.close();
    await h.sleep(600);
    const out = bot.inventory.items().map(h.nm).filter((x) => !before.includes(x)).join(',');
    return 'got ' + out;
  } catch (err) { v.close(); return 'err ' + err; }
};
h.items = () => bot.inventory.slots.map((i, s) => i ? s + ' ' + h.nm(i) + (h.lore(i) ? ' | ' + h.lore(i).slice(0, 80) : '') : null).filter(Boolean);
// hot-reloadable archer combat layer (combat.js)
h.reloadCombat = () => {
  if (h.combat) { h.combat.stop(); h.combat.dispose && h.combat.dispose(); }
  delete require.cache[require.resolve('./heuristics/combat')];
  h.combat = require('./heuristics/combat')(bot, h);
  return 'combat loaded';
};
h.reloadTown = () => { delete require.cache[require.resolve('./heuristics/town')]; h.town = require('./heuristics/town')(bot, h); return 'town loaded'; };
h.reloadTown();
h.reloadFarm = () => { if (h.farm) h.farm.stop(); delete require.cache[require.resolve('./heuristics/farm')]; h.farm = require('./heuristics/farm')(bot, h); return 'farm loaded'; };
// 用户授权的常驻 buff（力量2 抗性4 饱和）：经服务端控制台 cmd.txt 下发，每次 spawn/重生都补。
// effect 等级是 amplifier = 等级-1；时长 1000000s。奈何桥重生后地图可能清 buff，故延迟再发一次。
h.buffOn = !ONLINE;
// 本地服：用户允许物资无限 + 抵抗 5（amplifier 4 = 免疫伤害）。h.godMode=false 时回到抗性 4，用来练躲伤害。
h.godMode = !ONLINE;
// 分项开关（用户：不要加抗性了）。全 false 时 h.buff 不发任何 effect，伤害与线上一致。
h.buffCfg = { resist: false, strength: false, sat: false };
h.cmd = (...lines) => { if (ONLINE) { ev('blocked-cmd', { lines }); return; } try { require('fs').appendFileSync(require('./paths').log('cmd.txt'), lines.join('\n') + '\n'); } catch (e) { ev('error', { e: 'cmd: ' + e.message }); } };
h.buff = () => {
  if (!h.buffOn) return 'off';
  const send = () => {
    const n = bot.username;
    const c = h.buffCfg || {}, l = [];
    if (c.strength) l.push(`effect ${n} 5 1000000 1 true`);
    if (c.resist) l.push(`effect ${n} 11 1000000 ${h.godMode ? 4 : 3} true`);
    if (c.sat) l.push(`effect ${n} 23 1000000 0 true`);
    if (l.length) h.cmd(...l);
  };
  const c0 = h.buffCfg || {};
  if (!c0.strength && !c0.resist && !c0.sat) return 'none';
  send(); setTimeout(send, 4000);
  return 'buffed';
};
h.hasBuff = () => { const e = bot.entity.effects || {}, c = h.buffCfg || {}; return (!c.strength || !!e[5]) && (!c.sat || !!e[23]) && (!c.resist || !!(e[11] && e[11].amplifier === (h.godMode ? 4 : 3))); };
setInterval(() => { if (h.buffOn && bot.entity && !h.hasBuff()) h.buff(); }, 30000);
// 物资无限：箭 <64 补到 3 组，面包 <16 补 64，没弓给弓（只在本地服用！）
h.supplyOn = !ONLINE;
h.count = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((a, i) => a + i.count, 0);
h.resupply = () => {
  if (!h.supplyOn || !bot.entity) return 'off';
  const n = bot.username, out = [];
  if (h.count("arrow") < 64) { h.cmd(`give ${n} arrow 64`, `give ${n} arrow 64`, `give ${n} arrow 64`); out.push("arrow"); }
  if (h.count('bread') < 16) { h.cmd(`give ${n} bread 64`); out.push('bread'); }
  if (!h.count('bow')) { h.cmd(`give ${n} bow 1`); out.push('bow'); }
  return out.join(',') || 'ok';
};
setInterval(() => { try { h.resupply(); } catch {} }, 10000);
bot.on('combat-no-arrows', () => { try { h.resupply(); } catch {} });
// 伤害记录（重启后也在）：h.dmg {n,total,log[{t,d,hp,arr,m}]}
h.dmg = { n: 0, total: 0, log: [] };
{ let last = 20; bot.on('health', () => { const d = last - bot.health; last = bot.health; if (d <= 0.01 || bot.health <= 0) return;
  const me = bot.entity.position; const mobs = Object.values(bot.entities).filter((e) => e.type === 'mob').map((e) => ({ n: e.name, w: e.metadata && e.metadata[13] === 1, d: +e.position.distanceTo(me).toFixed(1) })).sort((x, y) => x.d - y.d).slice(0, 2);
  const arr = Object.values(bot.entities).filter((e) => e.name === 'Arrow' && e.position.distanceTo(me) < 3).length;
  h.dmg.n++; h.dmg.total += d; h.dmg.log.push({ t: new Date().toTimeString().slice(3, 8), d: +d.toFixed(1), hp: Math.round(bot.health), arr, m: mobs.map((m) => m.n[0] + (m.w ? 'W' : '') + m.d).join(',') }); if (h.dmg.log.length > 40) h.dmg.log.shift(); }); }
bot.once('spawn', () => { h.reloadCombat(); h.reloadFarm(); });
// 网页 3D 旁观（第三人称跟随，tp/死亡不会掉）：http://127.0.0.1:3007 ，只绑本机
bot.once('spawn', () => {
  try {
    // canvas 原生模块在 Node24/Win 装不上；服务端只是间接 require（名字牌在浏览器里画），塞个空壳
    const Module = require('module');
    const ctx = new Proxy({}, { get: () => () => ({ width: 0 }) });
    const stub = { createCanvas: () => ({ getContext: () => ctx, width: 0, height: 0 }) };
    const origLoad = Module._load;
    Module._load = function (req, ...rest) { return req === 'canvas' ? stub : origLoad.call(this, req, ...rest); };
    require('prismarine-viewer').mineflayer(bot, { port: VIEW_PORT, host: '127.0.0.1', firstPerson: process.env.VIEW_FP !== '0', viewDistance: 6 });
  } catch (e) { ev('error', { e: 'viewer: ' + e.message }); }
});
// safety + roomnav layers (command-block RPG maps: no voxel pathfinding in void rooms, swim up in water)
h.water = require('./heuristics/safety').water(bot, h);
h.roomnav = require('./heuristics/safety').roomnav(bot, h);
h.stairnav = require('./heuristics/safety').stairnav(bot, h);
// 统一地形感知导航层（nav.js）：地面高度图+BFS+沿路径实体行走，替代 A* 体素寻路
h.chunks = require('./heuristics/chunks')(bot, h);
h.nav = require('./heuristics/nav')(bot, h);
h.ev = ev;
// 智能出行：nav 规划 + h.goto 分段走 + 自动重规划 + 传送阵记忆（memory/world.json）
h.travel = require('./heuristics/travel')(bot, h);
h.noSuicide = true; // 默认禁止自动喝鶴頂丹（只有手动 h.suicide() 才喝）
// 录制路线回放层：先沿用户录的轨迹走，剩下的交给旧 travel
h.reloadRoutes = () => { h._travelOrig = h._travelOrig || h.travel; delete require.cache[require.resolve('./heuristics/routes')]; h.routes = require('./heuristics/routes')(bot, h); h.travel = Object.assign((...a) => h.routes.travel(...a), h._travelOrig); return 'routes loaded'; };
h.reloadRoutes();
h.reloadGmap = () => { for (const m of ['./heuristics/gfollow', './heuristics/gmap']) delete require.cache[require.resolve(m)]; h.gfollow = require('./heuristics/gfollow')(bot, h); h.gmap = require('./heuristics/gmap')(bot, h); return 'gmap loaded'; };
h.reloadGmap();
h.walkHold = /神速羽毛/; // 走路时手持（加速），gfollow 会定期换回
h.reloadSpeed = () => { delete require.cache[require.resolve('./heuristics/speed')]; h.speed = require('./heuristics/speed')(bot, h); return 'speed loaded'; };
h.reloadSpeed(); // 自动识别加速物，routes.follow / gfollow 走路时手持
// eval 有 60s 上限：长路程用后台任务。h.travelBg('村長') → 轮询 h.job
h.travelBg = (...a) => { const t0 = Date.now(); h.job = { state: 'run', args: a, t0 }; h.travel(...a).then((r) => { h.job = { state: 'done', r, sec: (Date.now() - t0) / 1000 }; }, (e) => { h.job = { state: 'err', e: String(e) }; }); return 'started'; };
// water-safety auto-on: pathfinder can't swim; always keep the anti-drown layer armed.
h.water.start();
function loreOf(i) {
  try { return i.nbt.value.display.value.Lore.value.value.join(' / '); } catch { return undefined; }
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      if (req.url === '/events') {
        const out = events.splice(0);
        return res.end(JSON.stringify(out));
      }
      const fn = new Function('bot', 'h', 'Vec3', 'require', `return (async()=>{ ${body} })()`);
      const r = await Promise.race([fn(bot, h, require('vec3'), require), h.sleep(60000).then(() => '<timeout 60s>')]);
      res.end(JSON.stringify({ ok: true, r }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    } catch (e) {
      res.end(JSON.stringify({ ok: false, e: String(e && e.stack || e).slice(0, 1500) }));
    }
  });
}).listen(API_PORT, '127.0.0.1');
