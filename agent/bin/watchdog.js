// 线上号看门狗：独立进程，每 30s 查一次 3002，异常就停号 + Telegram 通知用户。不依赖主 agent 在线。
// node watchdog.js   （日志 watchdog.log，状态 memory/watchdog_state.json）
const fs = require('fs'), http = require('http'), https = require('https'), path = require('path');
const TG = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.pi/agent/telegram.json'), 'utf8')).profiles.mc0agent;
const LOG = path.join(__dirname, '..', 'logs', 'watchdog.log');
const log = (m) => fs.appendFileSync(LOG, new Date().toTimeString().slice(0, 8) + ' ' + m + '\n');
const ANCHOR = { x: -164, z: 673 };
const cfg = { everyMs: 30000, noKillMin: 6, deathWin: 10 * 60000, deathMax: 3, awayMin: 8, reportMin: 10, firstReportMs: 0 };

const SF = path.join(__dirname, '..', 'memory/watchdog_state.json');
const W = (() => { try { const o = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'memory/watchdog_state.json'), 'utf8')); o.alerts = o.alerts || []; return o; } catch { return { alerts: [], last: '' }; } })();
const save = () => { try { fs.writeFileSync(SF, JSON.stringify(W)); } catch {} };
function tg(text) { W.alerts.push(new Date().toTimeString().slice(0, 8) + ' ' + text); if (W.alerts.length > 20) W.alerts.shift(); save(); tgSend('⚠️ ' + text); log('ALERT: ' + String(text).split(String.fromCharCode(10)).join(' | ')); }
function tgSend(text) {
  const body = JSON.stringify({ chat_id: TG.allowedUserId, text });
  const r = https.request({ hostname: 'api.telegram.org', path: '/bot' + TG.botToken + '/sendMessage', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => res.resume());
  r.on('error', (e) => log('tg err ' + e.message)); r.end(body); log('TG sent'); return text;
}
function ev(js) {
  return new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: 3002, path: '/eval', method: 'POST', timeout: 15000 }, (s) => { let d = ''; s.on('data', (c) => (d += c)); s.on('end', () => { try { res(JSON.parse(d)); } catch { res({ ok: false, err: 'bad json' }); } }); });
    r.on('error', (e) => res({ ok: false, err: e.message })); r.on('timeout', () => { r.destroy(); res({ ok: false, err: 'timeout' }); });
    r.end(js);
  });
}
const PROBE = `const c=h.combat.state(),f=h.farm.state();const m={};for(const i of bot.inventory.items()){const k=i.customName?i.customName.replace(/§./g,''):i.name+(i.name==='skull'?':'+i.metadata:'');m[k]=(m[k]||0)+i.count}
return {x:bot.entity.position.x,z:bot.entity.position.z,y:bot.entity.position.y,hp:bot.health,maxHp:(bot.entity.attributes&&bot.entity.attributes['generic.maxHealth']||{}).value||20,food:bot.food,shots:c.shots||0,hits:c.hits||0,target:c.target&&c.target.n,flees:c.flees||0,dodges:c.dodges||0,setbacks:h.setbacks||0,free:bot.inventory.emptySlotCount(),homeLog:h.home&&h.home.st.log.slice(-6),farmLog:f.log&&f.log.slice(-6),kills:c.kills,farm:f.on,combatOn:!!c.on,ctl:h.ctlJob?{s:h.ctlJob.s,what:h.ctlJob.what,r:h.ctlJob.r}:null,home:h.home&&h.home.st.state,step:h.home&&h.home.st.step,inv:m};`;

const S = { deaths: [], lastKill: Date.now(), kills: -1, awaySince: 0, down: 0, stopped: false, lastReport: 0, lastAlert: 0 };
let baseline = null; try { baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'memory/stat_baseline.json'), 'utf8')); } catch {}

async function stopBot(why) {
  await ev('h.farm.stop();h.combat.stop();bot.pathfinder.stop();bot.clearControlStates();return 1');
  S.stopped = true;
  tg('⚠️ 线上号已停：' + why + '\n等你/主agent处理。');
}
// 资产折算（单位：金粒/铜钱）。100铜钱=10金锭(元宝)=1银票；煤 4；王員外 2.25（40个=9元宝）；元素 0.6（5个=3）；箭 4/64；面包 5/12
const VAL = { gold_nugget: 1, gold_ingot: 10, iron_ingot: 100, coal: 4, '王員外被搶走的貨物': 2.25, rotten_flesh: 0.6, bone: 0.6, string: 0.6, blaze_rod: 0.6, magma_cream: 0.6, arrow: 4 / 64, bread: 5 / 12 };
function worth(inv) {
  let w = 0; for (const k in VAL) w += (inv[k] || 0) * VAL[k];
  if (inv !== null && inv.__ender !== false) { try { const L = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'memory/ledger.json'), 'utf8')); const E = inv.__base ? (L.enderBase || {}) : (L.ender || {}); for (const k in E) w += (E[k] || 0) * (VAL[k] || 0); } catch {} }
  return Math.round(w);
}
function gain(inv) {
  // 和 0 比：直接报总资产（背包+末影箱）和背包里重要物品的数量
  const w = worth(inv);
  const keys = ['四階裝備原核', 'skull:1', '中級藥引'], nm = { 'skull:1': '凋零头' };
  return `总资产 ${w} 铜钱（约 ${(w / 100).toFixed(2)} 银票）；背包里 ` + keys.map((k) => (nm[k] || k) + ' ' + (inv[k] || 0)).join('，');
}
// ---- 看板数据：memory/dash_now.json（当前）+ logs/dash_history.jsonl（每 30s 一个点）----
const DN = path.join(__dirname, '..', 'memory', 'dash_now.json'), DH = path.join(__dirname, '..', 'logs', 'dash_history.jsonl');
const D = (() => { try { return JSON.parse(fs.readFileSync(DN, 'utf8')).acc || {}; } catch { return {}; } })();
D.kills = D.kills || 0; D.deaths = D.deaths || 0; D.lastK = D.lastK == null ? -1 : D.lastK;
function base0() { try { const L = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'memory/ledger.json'), 'utf8')); if (L.bagBase) return { w: worth(Object.assign({ __base: true }, L.bagBase)), t: L.baseT, inv: L.bagBase }; } catch {} return null; }
function dash(s, online, err) {
  const now = Date.now(), b = base0();
  try { const rt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'memory', 'stats_reset.json'), 'utf8')).t || 0; // 看板「重置经济统计」
    if (rt > (D.resetT || 0)) { D.resetT = rt; D.kills = 0; D.deaths = 0; W.rounds = []; S.round = null; save(); } } catch {}
  const o = { t: now, online, err: err || null, acc: D };
  if (online) {
    if (D.lastK >= 0) D.kills += s.kills >= D.lastK ? s.kills - D.lastK : s.kills; D.lastK = s.kills;
    const w = worth(s.inv);
    const pick = (k) => s.inv[k] || 0;
    Object.assign(o, { x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z), hp: Math.round(s.hp), maxHp: Math.round(Math.max(s.maxHp, s.hp, 38)), food: s.food, farm: s.farm, combatOn: s.combatOn, ctl: s.ctl, home: s.home, step: s.step,
      kills: s.kills, shots: s.shots, hits: s.hits, target: s.target, flees: s.flees, dodges: s.dodges, setbacks: s.setbacks, free: s.free,
      arrow: pick('arrow'), money: { nug: pick('gold_nugget'), ingot: pick('gold_ingot'), note: pick('iron_ingot') },
      items: { '四階裝備原核': pick('四階裝備原核'), '五階裝備原核': pick('五階裝備原核'), '凋零头': pick('skull:1'), '中級藥引': pick('中級藥引'), '王員外貨物': pick('王員外被搶走的貨物'), '煤': pick('coal') },
      itemsBase: b && { '四階裝備原核': b.inv['四階裝備原核'] || 0, '五階裝備原核': b.inv['五階裝備原核'] || 0, '凋零头': b.inv['skull:1'] || 0, '中級藥引': b.inv['中級藥引'] || 0 },
      worth: w, base: b && b.w, baseT: b && b.t, homeLog: s.homeLog, farmLog: s.farmLog,
      zone: Math.hypot(s.x - ANCHOR.x, s.z - ANCHOR.z) < 60 ? '刷怪点' : (s.z < -1700 ? '奈何桥' : (s.x > 1500 ? '人族村' : (Math.hypot(s.x - 120, s.z - 120) < 160 ? '皇城' : '路上'))) });
    try { fs.appendFileSync(DH, JSON.stringify({ t: now, w, k: D.kills, hp: o.hp, z: o.zone }) + String.fromCharCode(10)); } catch {}
  }
  o.rounds = (W.rounds || []).slice(-15); o.alerts = W.alerts.slice(-8);
  try { fs.writeFileSync(DN, JSON.stringify(o)); } catch {}
}
async function tick() {
  const M = (f) => fs.existsSync(path.join(__dirname, '..', 'memory', f));
  if (M('offline.flag')) { // 看板「下线」：不检查、不告警
    S.down = 0; S.deaths = []; S.awaySince = 0; S.homeSince = 0; S.lastKill = Date.now(); S.paused = true; dash(null, false, '已下线'); return;
  }
  if (M('pause.flag')) { // 看板「暂停」：号在线，照常显示状态，但不告警、不停号
    S.deaths = []; S.awaySince = 0; S.homeSince = 0; S.lastKill = Date.now(); S.paused = true;
    const r0 = await ev(PROBE); if (r0.ok) { S.down = 0; try { dash(r0.r, true); } catch {} } else dash(null, false, r0.err); return;
  }
  if (S.paused) { S.paused = false; S.lastKill = Date.now(); S.kills = -1; }
  const r = await ev(PROBE);
  if (!r.ok) {
    S.down++; S.homeSince = 0; S.awaySince = 0; S.lastKill = Date.now(); dash(null, false, r.err);
    if (S.down === 6) tg('⚠️ 线上号 3 分钟连不上（' + r.err + '）。run_online.sh 应该在重连，若一直这样请看看。');
    return;
  }
  if (S.down >= 6) log('reconnected');
  S.down = 0;
  const s = r.r, now = Date.now();
  try { dash(s, true); } catch (e) { log('dash err ' + e.message); }
  const away = Math.hypot(s.x - ANCHOR.x, s.z - ANCHOR.z) > 60;
  // 卡住检测：不在刷怪点、3 分钟内移动不到 3 格 → 弹一次消息（不动号，等人点看板「☠ 自杀」）
  if (away && !(s.z < -1700)) {
    if (!S.stuckAt || Math.hypot(s.x - S.stuckAt.x, s.y - S.stuckAt.y, s.z - S.stuckAt.z) > 3) S.stuckAt = { x: s.x, y: s.y, z: s.z, t: now, sent: false };
    else if (!S.stuckAt.sent && now - S.stuckAt.t > 3 * 60000) {
      S.stuckAt.sent = true; const L = (s.homeLog || []).slice(-1)[0] || '';
      tg(`🕳 号卡住了：在 (${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.z)}) 3 分钟没动，步骤 ${s.home}/${s.step || '?'}。${L ? '最后日志：' + L + '。' : ''}要回去就在看板点「☠ 自杀」。`);
    }
  } else S.stuckAt = null;
  if (s.kills !== S.kills) { if (s.kills > S.kills) S.lastKill = now; S.kills = s.kills; }
  if (S.stopped) { if (s.farm) { S.stopped = false; S.lastKill = now; S.deaths = []; log('farm restarted by someone, resume watching'); } return; }
  if (!s.farm) return; // 没在刷（人为停的），不管
  S.deaths = S.deaths.filter((t) => now - t < cfg.deathWin);
  // 正在回城流程且在推进 → 不算没击杀
  const traveling = s.home === 'run' || s.home === 'err';
  if (traveling) { S.homeSince = S.homeSince || now; } else S.homeSince = 0;
  if (S.homeSince && now - S.homeSince > 12 * 60000) { S.homeSince = 0; return stopBot(`回城流程 12 分钟没走完（卡在 ${s.step || '?'}，位置 ${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.z)}）`); }
  if (traveling) S.lastKill = now;
  if (away && !traveling) { S.awaySince = S.awaySince || now; } else S.awaySince = 0;
  W.last = new Date().toTimeString().slice(0, 8) + ` pos ${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.z)} hp${Math.round(s.hp)} k${s.kills} arr${s.inv.arrow || 0} home:${s.home}`; save();
  if (s.home === 'run' && (S.prevHome === 'done' || S.prevHome === 'idle') && (!S.round || now - S.round.t > 5 * 60000)) {
    const w = worth(s.inv);
    if (S.round) {
      const R = { end: new Date().toTimeString().slice(0, 5), min: Math.round((now - S.round.t) / 60000), kills: s.kills >= S.round.k ? s.kills - S.round.k : s.kills, d: w - S.round.w };
      W.rounds = (W.rounds || []).concat([R]).slice(-30); save();
      tgSend(`🔁 一轮结束 ${R.end}：${R.min} 分钟，击杀 ${R.kills}，资产 ${R.d >= 0 ? '+' : ''}${R.d} 铜钱`);
    }
    S.round = { t: now, k: s.kills, w };
  }
  S.prevHome = s.home;
  log(`pos ${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.z)} hp${Math.round(s.hp)} k${s.kills} home:${s.home}/${s.step || ''} deaths10m:${S.deaths.length}`);
  if (S.deaths.length >= cfg.deathMax) return stopBot(`10 分钟内死了 ${S.deaths.length} 次`);
  if (S.awaySince && now - S.awaySince > cfg.awayMin * 60000) return stopBot(`离刷怪点 >60 格已 ${cfg.awayMin} 分钟且没在回城（位置 ${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.z)}）`);
  if (!away && now - S.lastKill > cfg.noKillMin * 60000) return stopBot(`在刷怪点但 ${cfg.noKillMin} 分钟没有击杀`);
  if (now - S.lastReport > cfg.reportMin * 60000) { S.lastReport = now; W.report = tgSend('📊 ' + new Date().toTimeString().slice(0, 5) + ' 在刷，击杀 ' + s.kills + '，箭 ' + (s.inv.arrow || 0) + '\n' + gain(s.inv)); }
}
// 被踢/死亡 也从日志里抓
let logPos = 0; const OL = path.join(__dirname, '..', 'logs', 'bot_online.log');
try { logPos = fs.statSync(OL).size; } catch {}
setInterval(() => {
  try {
    const st = fs.statSync(OL); if (st.size < logPos) logPos = 0; if (st.size === logPos) return;
    const fd = fs.openSync(OL, 'r'); const buf = Buffer.alloc(st.size - logPos); fs.readSync(fd, buf, 0, buf.length, logPos); fs.closeSync(fd); logPos = st.size;
    for (const line of buf.toString('utf8').split('\n')) {
      if (/"type":"death"/.test(line)) { S.deaths.push(Date.now()); D.deaths++; }
      if (/"type":"(kicked|end|spawn)"/.test(line)) { S.homeSince = 0; S.awaySince = 0; S.lastKill = Date.now(); } // 掉线/重连：回城、离开、无击杀计时都重新开始
      if (/"type":"kicked"/.test(line)) tg('线上号被踢：' + (line.match(/"r":"(.*)"/) || [])[1] + '，run_online.sh 会 30 秒后重连并开刷');
    }
  } catch {}
}, 5000);
log('watchdog start'); ('👀 看门狗已启动：每 30 秒检查线上号；死太多/卡住/不杀怪会自动停号并通知你，每 10 分钟报一次战绩。');
setInterval(() => tick().catch((e) => log('tick err ' + e.message)), cfg.everyMs);
