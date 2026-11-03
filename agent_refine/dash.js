// 看板：http://127.0.0.1:3010  状态只读；/api/ctl 控制（要口令）。读 memory/dash_now.json + logs/dash_history.jsonl（由 watchdog.js 每 30 秒写）
// node bin/dash.js   （DASH_HOST=0.0.0.0 可让局域网/手机访问）
const http = require('http'), fs = require('fs'), path = require('path'), net = require('net');
const ROOT = path.join(__dirname, '..');
const DN = path.join(ROOT, 'memory', 'dash_now.json'), DH = path.join(ROOT, 'logs', 'dash_history.jsonl');
const PAGE = path.join(ROOT, 'web', 'dash.html');
const PORT = +(process.env.DASH_PORT || 3010), HOST = process.env.DASH_HOST || '127.0.0.1';
const BOT_PORT = +(process.env.DASH_BOT_PORT || 3002); // botEval 目标（线上号 3002；本地测试 DASH_BOT_PORT=3001）
// 观战（prismarine-viewer）端口：线上号 3008、本地号 3007，和 bot.js 里的 VIEW_PORT 对应
const VIEW_PORT = +(process.env.DASH_VIEW_PORT || (BOT_PORT === 3002 ? 3008 : 3007));
const VIEW_PREFIX = '/view'; // 观战页挂到看板自己的路径下，这样只转发看板一个端口就够了
function viewProxyPath(p) { return (p.slice(VIEW_PREFIX.length) || '/'); }
function proxyView(req, res) {
  const r2 = http.request({ host: '127.0.0.1', port: VIEW_PORT, path: viewProxyPath(req.url), method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + VIEW_PORT }) }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
  });
  r2.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('观战进程没起（端口 ' + VIEW_PORT + '）'); });
  r2.setTimeout(60000, () => { try { r2.destroy(); } catch {} });
  req.pipe(r2);
}
function proxyViewUpgrade(req, socket, head) { // socket.io 的 ws 原样透传
  const up = net.connect(VIEW_PORT, '127.0.0.1', () => {
    let raw = 'GET ' + viewProxyPath(req.url) + ' HTTP/1.1\r\n';
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
    up.write(raw + '\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}

function history(hours, raw) {
  const since = Date.now() - hours * 3600e3;
  let txt = ''; try { txt = fs.readFileSync(DH, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of txt.split('\n')) { if (!l) continue; try { const p = JSON.parse(l); if (p.t >= since) out.push(p); } catch {} }
  if (raw) return out;
  const step = Math.max(1, Math.floor(out.length / 600)); // 最多 600 点
  return out.filter((_, i) => i % step === 0 || i === out.length - 1);
}
// ---- 控制（要口令 memory/dash_key.txt）----
const F = (n) => path.join(ROOT, 'memory', n);
const wlog = (t) => { try { fs.appendFileSync(path.join(ROOT, 'logs', 'online_watch.log'), new Date().toTimeString().slice(0, 8) + ' dash ' + t + '\n'); } catch {} };
function botEval(body) {
  return new Promise((ok) => {
    const r2 = http.request({ host: '127.0.0.1', port: BOT_PORT, path: '/eval', method: 'POST', headers: { 'Content-Type': 'text/plain' }, timeout: 15000 }, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { ok(JSON.parse(b)); } catch { ok({ ok: false, err: b.slice(0, 200) }); } });
    });
    r2.on('error', (e) => ok({ ok: false, err: '号不在线（' + e.code + '）' })); r2.on('timeout', () => { r2.destroy(); ok({ ok: false, err: '超时' }); });
    r2.end(body);
  });
}
// 轻量实时探测：看板 /api/now 直接问号（1.5 秒内复用上次结果），不再等 watchdog 的 30 秒快照
const LPROBE = "const c=h.combat.state(),f=h.farm.state(),p=bot.entity.position;let ar=0;for(const i of bot.inventory.items())if(i.name==='arrow')ar+=i.count;"
  + "return {t:Date.now(),online:true,hp:bot.health,food:bot.food,x:+p.x.toFixed(1),y:+p.y.toFixed(1),z:+p.z.toFixed(1),arrow:ar,free:bot.inventory.emptySlotCount(),"
  + "target:c.target&&c.target.n,kills:c.kills,shots:c.shots||0,hits:c.hits||0,dodges:c.dodges||0,flees:c.flees||0,setbacks:h.setbacks||0,"
  + "farm:f.on,combatOn:!!c.on,home:h.home&&h.home.st.state,step:h.home&&h.home.st.step,ctl:h.ctlJob?{s:h.ctlJob.s,what:h.ctlJob.what}:null};";
let LP = { t: 0, r: null };
function liveProbe() {
  if (Date.now() - LP.t < 1500) return Promise.resolve(LP.r);
  return botEval(LPROBE).then((r) => { const v = r.ok ? r.r : null; LP = { t: Date.now(), r: v }; return v; });
}
const HALT = "try{if(h.ctlJob)h.ctlJob.cancel=true}catch{};try{h.farm.stop()}catch{};try{h.combat.stop()}catch{};try{if(h.home&&h.home.st.state==='run')h.home.st.abort=true}catch{};try{bot.pathfinder.stop()}catch{};bot.clearControlStates();";
// 后台任务：h.ctlJob {what,s:run/done/err,r,cancel}；abort 让录制路线/离线图寻路中途停下
const JOB = (what, code) => `if(h.ctlJob&&h.ctlJob.s==='run')return 'busy: '+h.ctlJob.what;${HALT}const J=h.ctlJob={what:${JSON.stringify(what)},s:'run',t:Date.now(),cancel:false};const abort=()=>J.cancel;
(async()=>{try{${code};J.s=J.cancel?'cancelled':'done'}catch(e){J.s=J.cancel?'cancelled':'err';J.r=String(e&&e.message||e)}})();return 'started';`;
const RSF = path.join(ROOT, 'memory', 'stats_reset.json');
const resetT = () => { try { return JSON.parse(fs.readFileSync(RSF, 'utf8')).t || 0; } catch { return 0; } };
const ACTIONS = {
  // 重置经济统计：之后的平均速度/曲线/几轮/击杀死亡都从这一刻重新算（历史数据不删）
  reset_stats: { flag: () => { const t = Date.now(); fs.writeFileSync(RSF, JSON.stringify({ t, at: new Date(t).toString() })); } },
  // 暂停 = 停手但不下线；继续 = 重新开刷
  // 下线 = 退出且不自动重连；上线 = 让守护脚本重新连（连上后若没暂停就自动开刷）
  offline: { flag: () => fs.writeFileSync(F('offline.flag'), new Date().toString()), body: () => HALT + "setTimeout(()=>bot.quit('dash offline'),500);return 'bye'", okIfDown: true },
  online: { flag: () => { try { fs.unlinkSync(F('offline.flag')); } catch {} fs.writeFileSync(F('resume.flag'), '1'); }, body: null },
  stop: { okIfDown: '号不在线，已记下：上线后不自动刷', flag: () => { try { fs.unlinkSync(F('autofarm.flag')); } catch {} }, body: () => HALT + "return 'stopped'" },
  combat_on: { body: () => "h.combat.start({approach:false});return 'combat on'" },
  combat_off: { body: () => "h.combat.stop();bot.clearControlStates();return 'combat off'" },
  // 切刷怪路线档案（路线与战利品处理方式绑定）：停 → 换 → 重启，loot/home/combat 一起换
  profile: { okIfDown: '号不在线，已记下：上线开刷时用这个档案', flag: (q) => { try { require(path.join(ROOT, 'src', 'heuristics', 'profiles')).setActive(q.get('v')); } catch {} }, body: (q) => { const n = q.get('v') || ''; return `const n=${JSON.stringify(n)};let r='';try{r=h.farm.switchTo(n)}catch(e){return 'err '+String(e&&e.message||e)}const PF=require('./heuristics/profiles');const P=PF.get(n)||{};if(h.loot&&h.loot.cfg){h.loot.cfg.houses=P.houses||[];if(P.lootLeash)h.loot.cfg.lootLeash=P.lootLeash;}return r+' '+(h.farm.st.on?'开刷中':'已切换')`; } },
  farm_on: { okIfDown: '号不在线，已记下：上线后自动刷', flag: () => fs.writeFileSync(F('autofarm.flag'), new Date().toString()), body: () => fs.readFileSync(path.join(ROOT, 'scripts', 'eval', 'farm_start.js'), 'utf8') },
  farm_off: { okIfDown: '号不在线，已记下：上线后不自动刷', flag: () => { try { fs.unlinkSync(F('autofarm.flag')); } catch {} }, body: () => "try{h.farm.stop()}catch{};try{h.combat.stop()}catch{};bot.clearControlStates();return 'farm off'" },
  // 回城补给：走完整的补给流程（卖元素/存货/卖煤/换钱/买箭买牛排），最后回到刷怪点站桩（不开刷）
  home: { body: () => JOB('回城补给', "J.r=await h.home.run({force:true})") },
  route: { body: (q) => { const k = q.get('v') || ''; return JOB('路线 ' + k, `const r=await h.routes.follow(${JSON.stringify(k)},{abort});J.r=r.ok?'ok '+Math.round((r.sec||0))+'s':'fail '+r.err;if(!r.ok)throw new Error(J.r)`); } },
  goto: { body: (q) => { const v = (q.get('v') || '').trim(); const m = v.match(/^(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)$/);
    const goal = m ? `[${+m[1]},${+m[2]},${+m[3]}]` : JSON.stringify(v);
    return JOB('寻路 ' + v, `const r=await h.gmap.go(${goal},{tries:2,abort});J.r=r.ok?'ok '+(r.total||0)+'s':'fail '+r.err;if(!r.ok)throw new Error(J.r)`); } },
  // 自杀：停掉一切，喝鶴頂丹，等死亡（复活后在奈何桥，回城流程会踩板走录好的路）
  suicide: { body: () => HALT + "const it=bot.inventory.items().find(i=>i.name==='potion'&&i.metadata===8234);if(!it)return 'no potion 背包里没有鶴頂丹';const dead=new Promise(r=>{bot.once('death',()=>r('dead'));setTimeout(()=>r('timeout'),12000)});let err='';try{await bot.equip(it,'hand')}catch(e){err+=' equip:'+e.message}try{await bot.consume()}catch(e){err+=' consume:'+e.message}const r=await dead;return r==='dead'?'已自杀，在奈何桥复活':'没死成 '+r+err" },
  cancel: { body: () => HALT + "return h.ctlJob?'cancel '+h.ctlJob.what:'nothing'" },
};
async function ctl(req, u, json) {
  if (req.method !== 'POST') return json({ ok: false, err: 'POST only' });
  let key = ''; try { key = fs.readFileSync(F('dash_key.txt'), 'utf8').trim(); } catch {}
  if (!key || u.searchParams.get('k') !== key) return json({ ok: false, err: '口令不对', badKey: true });
  const a = u.searchParams.get('a'), A = ACTIONS[a];
  if (!A) return json({ ok: false, err: '未知操作 ' + a });
  wlog(a + (u.searchParams.get('v') ? ' ' + u.searchParams.get('v') : ''));
  if (A.flag) A.flag();
  if (!A.body) return json({ ok: true, r: 'ok' });
  const r = await botEval(A.body(u.searchParams));
  // 自杀成功后：如果「刷怪循环」是开着的（autofarm.flag），复活后自动重新开刷（回城流程会从奈何桥走录好的路）
  if (a === 'suicide' && r.ok && /已自杀/.test(String(r.r)) && fs.existsSync(F('autofarm.flag'))) {
    await new Promise((ok) => setTimeout(ok, 3000));
    const r2 = await botEval(fs.readFileSync(path.join(ROOT, 'scripts', 'eval', 'farm_start.js'), 'utf8'));
    wlog('suicide → farm_on ' + (r2.ok ? 'ok' : 'fail'));
    r.r += r2.ok ? '，已自动重新开刷' : '，自动开刷失败，请点「刷怪循环 开」';
  }
  if (!r.ok && A.okIfDown && /不在线/.test(r.err || '')) return json({ ok: true, r: typeof A.okIfDown === 'string' ? A.okIfDown : '号本来就不在线' });
  return json(r.ok ? { ok: true, r: r.r } : { ok: false, err: r.err || (r.e ? String(r.e).split(String.fromCharCode(10))[0] : '失败') });
}

http.createServer((req, res) => {
  try { return handle(req, res); } catch (e) { // 单个请求炸了不能把整个看板带走
    try { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('dash error: ' + String(e && e.message || e)); } catch {}
  }
}).listen(PORT, HOST, () => console.log(`dash http://${HOST}:${PORT}  （观战 /view/ -> 127.0.0.1:${VIEW_PORT}）`)).on('upgrade', (req, socket, head) => { // 只转发观战那条 ws
  if (req.url && (req.url === VIEW_PREFIX || req.url.startsWith(VIEW_PREFIX + '/'))) return proxyViewUpgrade(req, socket, head);
  socket.destroy();
});

function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === VIEW_PREFIX || u.pathname.startsWith(VIEW_PREFIX + '/')) return proxyView(req, res);
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/api/now') { let o = {}; try { o = JSON.parse(fs.readFileSync(DN, 'utf8')); } catch {}
    o.resetT = resetT(); o.paused = fs.existsSync(F('pause.flag')); o.offline = fs.existsSync(F('offline.flag')); o.autofarm = fs.existsSync(F('autofarm.flag'));
    // 号在线时用实时探测覆盖状态类字段（资产/历史/日志仍用 watchdog 的 30 秒快照）
    return liveProbe().then((v) => { if (v) Object.assign(o, v); else if (!o.t) o.online = false; o.serverT = Date.now(); return json(o); }); }
  if (u.pathname === '/api/profiles') { // 刷怪路线档案列表（看板下拉）
    try { const PF = require(path.join(ROOT, 'src', 'heuristics', 'profiles')); return json({ ok: true, list: PF.list() }); } catch (e) { return json({ ok: false, err: String(e.message || e).slice(0, 80), list: [] }); }
  }
  if (u.pathname === '/api/routes') { // 录好的路线名 + 地点名（给看板下拉框）
    let R = {}, P = {}; try { R = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'routes_recorded.json'), 'utf8')); } catch {}
    try { P = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'places.json'), 'utf8')); } catch {}
    return json({ routes: Object.keys(R), places: Object.keys(P) });
  }
  if (u.pathname === '/api/ctl') return ctl(req, u, json);
  // 实时详情：直接问号（不等 watchdog 的 30 秒），背包逐格 + 装备 + 手持 + 坐标；末影箱取 ledger 里最近一次打开时的快照
  if (u.pathname === '/api/live') {
    const body = "const nm=i=>i?{n:(i.customName||'').replace(/§./g,'')||i.displayName||i.name,id:i.name+(i.metadata?':'+i.metadata:''),c:i.count,s:i.slot}:null;" +
      "const p=bot.entity.position,inv=bot.inventory;const arm=[5,6,7,8].map(k=>nm(inv.slots[k]));" +
      "const items=[];for(let k=9;k<=44;k++){const i=inv.slots[k];if(i)items.push(nm(i))}" +
      "return {t:Date.now(),pos:{x:+p.x.toFixed(1),y:+p.y.toFixed(1),z:+p.z.toFixed(1)},yaw:+(bot.entity.yaw*180/Math.PI).toFixed(0),dim:bot.game.dimension,hp:+bot.health.toFixed(1),food:bot.food,sat:+(bot.foodSaturation||0).toFixed(1),xp:bot.experience&&bot.experience.level," +
      "held:nm(bot.heldItem),quick:bot.quickBarSlot,armor:arm,items,free:inv.emptySlotCount(),farm:h.farm&&h.farm.state().on,combat:h.combat&&h.combat.state().on,home:h.home&&(h.home.st.state+'/'+(h.home.st.step||'')),job:h.ctlJob?{w:h.ctlJob.what,s:h.ctlJob.state}:null,bows:h.combat&&h.combat.bows?h.combat.bows():[],bowName:(h.combat&&h.combat.cfg.bowName)||''}";
    let L = {}; try { L = JSON.parse(fs.readFileSync(F('ledger.json'), 'utf8')); } catch {}
    return botEval(body).then((r) => json({ ok: !!r.ok, err: r.ok ? null : (r.err || r.e), bot: r.ok ? r.r : null, ender: L.ender || null, enderT: L.enderT || null }));
  }
  // 回城补给阈值：每个刷怪档案各一套（memory/farm_profiles.json 里 profile.cfg）；GET 读当前档案的；POST 写当前档案的
  if (u.pathname === '/api/cfg') {
    const PF = require(path.join(ROOT, 'src', 'heuristics', 'profiles'));
    const PFF = path.join(ROOT, 'memory', 'farm_profiles.json');
    const KEYS = ['minArrow', 'buyArrowTo', 'maxArrow', 'minFood', 'buyFoodTo', 'minFree', 'wangMin'];
    const ELEMS = ['rotten_flesh', 'bone', 'string', 'blaze_rod', 'magma_cream'];
    const DEF = { minArrow: 128, buyArrowTo: 448, maxArrow: 0, minFood: 24, buyFoodTo: 60, minFree: 3, wangMin: 120, wang: false, bowName: '', elemMode: {} };
    const loadAll = () => { try { return JSON.parse(fs.readFileSync(PFF, 'utf8')); } catch { return {}; } };
    const profName = () => PF.active();
    const cfgOf = (A, n) => Object.assign({}, DEF, ELEMS.reduce((a, e) => ((a.elemMode = Object.assign({}, a.elemMode, { [e]: 'sell' })), a), {}), (A[n] && A[n].cfg) || {});
    if (req.method !== 'POST') {
      const A = loadAll(), n = profName();
      const c = cfgOf(A, n);
      const P0 = (A[n] || {}); const sale = P0.sale || {};
      return json(Object.assign({ profile: n, profiles: PF.list(), saleNpc: sale.npc || null, saleGoods: sale.goods || null, showWang: /王員外/.test(String(sale.npc || '')) }, c));
    }
    let key = ''; try { key = fs.readFileSync(F('dash_key.txt'), 'utf8').trim(); } catch {}
    if (!key || u.searchParams.get('k') !== key) return json({ ok: false, err: '口令不对', badKey: true });
    let v; try { v = JSON.parse(u.searchParams.get('v') || '{}'); } catch { return json({ ok: false, err: 'bad json' }); }
    const A = loadAll(), n = v.profile || profName();
    if (!A[n]) return json({ ok: false, err: '没有这个档案 ' + n });
    const cur = cfgOf(A, n);
    if (v.bowName != null) { if (typeof v.bowName !== 'string' || v.bowName.length > 64) return json({ ok: false, err: 'bowName 要短字符串' }); cur.bowName = v.bowName; }
    for (const k of KEYS) if (v[k] != null) { const x = Math.round(+v[k]); if (!(x >= 0 && x <= 2304)) return json({ ok: false, err: k + ' 要在 0-2304 之间' }); cur[k] = x; }
    if (v.wang != null) cur.wang = !!v.wang;
    if (v.elemMode != null) {
      if (typeof v.elemMode !== 'object' || Array.isArray(v.elemMode)) return json({ ok: false, err: 'elemMode 要是对象' });
      for (const [e, m] of Object.entries(v.elemMode)) {
        if (!ELEMS.includes(e)) return json({ ok: false, err: '未知元素 ' + e });
        if (m !== 'sell' && m !== 'refine') return json({ ok: false, err: e + ' 只能是 sell 或 refine' });
        cur.elemMode[e] = m;
      }
    }
    if (cur.buyArrowTo < cur.minArrow) cur.buyArrowTo = cur.minArrow; if (cur.maxArrow > 0 && cur.maxArrow < cur.buyArrowTo) cur.maxArrow = cur.buyArrowTo;
    if (cur.buyFoodTo < cur.minFood) cur.buyFoodTo = cur.minFood;
    A[n].cfg = cur; fs.writeFileSync(PFF, JSON.stringify(A, null, 1)); wlog('cfg ' + n + ' ' + JSON.stringify(cur));
    // 号在线且用的就是这个档案：立刻生效
    return botEval(`const PF=require('./heuristics/profiles');const n=${JSON.stringify(n)};if(PF.active()!==n)return 'saved (当前是 '+PF.active()+')';if(h.farm&&h.farm.cfg&&h.farm.cfg.profile!==n)return 'saved';const c=${JSON.stringify(cur)};if(h.home&&h.home.cfg){Object.assign(h.home.cfg,c);h.home.cfg.wang=!!c.wang;h.home.cfg.bowName=c.bowName||''}if(h.combat&&h.combat.cfg)h.combat.cfg.bowName=c.bowName||'';return 'live'`).then((r) => json({ ok: true, profile: n, cfg: cur, live: !!(r.ok && r.r === 'live') }));
  }
  if (u.pathname === '/api/avg') {
    // 全部记录：净增资产 / 在线时长（相邻两点间隔 >2 分钟算离线，不计入时长也不计入收益）
    const R0 = resetT(); const L = history(24 * 365, true).filter((p) => p.t >= R0); let on = 0, gain = 0, kills = 0;
    for (let i = 1; i < L.length; i++) { const d = L[i].t - L[i - 1].t; if (d < 120e3) { on += d; gain += L[i].w - L[i - 1].w; kills += Math.max(0, L[i].k - L[i - 1].k); } }
    const hrs = on / 3600e3;
    return json({ since: L.length ? L[0].t : null, hrs, gain, kills, perHour: hrs > 0.05 ? gain / hrs : null, killsPerHour: hrs > 0.05 ? kills / hrs : null });
  }
  if (u.pathname === '/api/view') return json({ ok: true, port: VIEW_PORT, same: true }); // 前端优先用同源 /view/
  if (u.pathname === '/api/history') return json(history(Math.min(72, +(u.searchParams.get('h') || 12))));
  if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(PAGE).pipe(res); }
  res.writeHead(404); res.end();
}
