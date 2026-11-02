// 固定的回刷怪点流程（不寻路乱走）：
// 不自杀。去皇城南门：在刷怪点 → 录好的路 双房->皇城南门；在奈何桥（死了）→ 踩回村板 → 人族出生点->皇城南门；别处 → 离线图 h.gmap
// → shop()：元素回收員卖元素→錢莊存王員外货+换钱→礦物收購商卖煤(1煤=4铜钱，装不下先回錢莊压缩，可跑几趟)→南北买箭→蒙古烤肉买牛排→南门 → 皇城南门->双房 → 站桩点
const { Vec3 } = require('vec3');
module.exports = (bot, h) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pos = () => bot.entity.position;
  const hd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const FOOD = /bread|cooked_|baked_potato|apple|carrot|melon$|pumpkin_pie|mushroom_stew/;
  const st = { state: 'idle', step: '', log: [] };
  const log = (m) => { st.log.push(new Date().toTimeString().slice(0, 8) + ' ' + m); if (st.log.length > 30) st.log.shift(); };
  const atNaihe = () => pos().z < -1700;
  const food = () => bot.inventory.items().filter((i) => FOOD.test(i.name) && !i.customName).reduce((a, i) => a + i.count, 0);
  const cfg = { anchor: { x: -164, y: 45, z: 673 }, farmR: 60, minArrow: 128, buyArrowTo: 448, minFood: 24, buyFoodTo: 60, minFree: 3, south: [179.6, 47, 175.9], goods: /王員外/, useGraph: false,
    // 王員外（沙漠马贼营地，命令方块 -283,49,394 召唤，村民在 -283,54,395）：40 货 → 9 金锭（第 3 页 idx2）
    wang: process.env.ONLINE !== '1', wangMin: 120, wangAt: [-283, 54, 397], wangNpc: '王員外', wangClearR: 14, wangWaitMs: 90000,
    elemMode: { rotten_flesh: 'sell', bone: 'sell', string: 'sell', blaze_rod: 'sell', magma_cream: 'sell' } };
  // 元素模式启动时就从 home_cfg.json 读（其余阈值照旧由 farm_start.js / 看板 Object.assign 进来）
  try { const c = JSON.parse(require('fs').readFileSync(require('../paths').mem('home_cfg.json'), 'utf8')); if (c.elemMode) Object.assign(cfg.elemMode, c.elemMode); if (c.maxArrow != null) cfg.maxArrow = c.maxArrow; } catch {}

  async function follow(k) {
    st.step = k; const t0 = Date.now();
    // 优先离线图（目标=录像终点）；图失败再走录像。cfg.useGraph=false 时只走录像
    if (cfg.useGraph && h.gmap) {
      const R = h.routes.load()[k]; const e = R && R.pts && R.pts[R.pts.length - 1];
      if (e) {
        const g = await h.gmap.go([e.x, e.y, e.z], { tries: 2 });
        log(k + ' graph ' + (g.ok ? 'ok' : 'FAIL ' + g.err) + ' ' + Math.round((Date.now() - t0) / 1000) + 's');
        if (g.ok) { if (Math.hypot(pos().x - e.x, pos().z - e.z) > 0.8) { try { await h.goto(e.x, e.y, e.z, 0.5, 6000); } catch {} } return; }
        chk();
      }
    }
    const r = await h.routes.follow(k);
    log(k + ' ' + (r.ok ? 'ok' : 'FAIL ' + r.err) + ' ' + Math.round((Date.now() - t0) / 1000) + 's');
    if (!r.ok) throw new Error(k + ' ' + r.err);
  }
  // 合并同名同 meta 同 nbt 的未满堆（moveSlotItem: 点A→点B，剩余放回A），只在背包内挪动
  async function compact() {
    let n = 0;
    const key = (i) => i.type + ':' + i.metadata + ':' + JSON.stringify(i.nbt || null) + ':' + (i.customName || '');
    for (let pass = 0; pass < 2; pass++) {
      const groups = {};
      for (const i of bot.inventory.items()) if (i.count < i.stackSize) (groups[key(i)] = groups[key(i)] || []).push(i);
      for (const g of Object.values(groups)) {
        if (g.length < 2) continue;
        g.sort((a, b) => b.count - a.count);
        for (let j = g.length - 1; j > 0; j--) {
          const src = bot.inventory.slots[g[j].slot], dst = bot.inventory.slots[g[0].slot];
          if (!src || !dst || dst.count >= dst.stackSize) break;
          await bot.moveSlotItem(g[j].slot, g[0].slot); n++; await sleep(150);
        }
      }
    }
    return n + ' free=' + bot.inventory.emptySlotCount();
  }
  // 皇城固定流程（只走录好的路，h.goto 只用于 NPC/箱子前最后几格）：
  // 南门→元素回收員 卖元素 →南门→熟食小販→南北→錢莊 存煤/王員外货、换钱 →南北 买箭 →熟食小販 买吃的 →南门
  const ELEM = ['rotten_flesh', 'bone', 'string', 'blaze_rod', 'magma_cream']; // 元素回收員 5 个换 3 铜钱；元素精煉師 5 个换 1 精練X元素（idx 都按输入物品匹配，不写死）
  const plain = (n) => bot.inventory.items().filter((i) => i.name === n && !i.customName).reduce((a, i) => a + i.count, 0);
  // 每种元素：'sell' 卖回收員（默认，原行为）/ 'refine' 精煉師做成精練元素存末影箱。cfg.elemMode 来自 memory/home_cfg.json，看板可改
  const elemMode = (n) => ((cfg.elemMode || {})[n] === 'refine' ? 'refine' : 'sell');
  const isRefined = (i) => ELEM.includes(i.name) && /^精練.元素$/.test(String(i.customName || '').replace(/§./g, ''));
  const refinedN = () => bot.inventory.items().filter(isRefined).reduce((a, i) => a + i.count, 0);
  // trade 选择器：输入=普通(无名) n×5；输出 sell=铜钱 / refine=带 精練 名字的同种物品
  const pickElem = (n, want) => (T) => T.findIndex((t) => t && t.inputItem1 && t.inputItem1.name === n && !t.inputItem1.customName && !t.inputItem2 && t.outputItem &&
    (want === 'sell' ? t.outputItem.name === 'gold_nugget' : t.outputItem.name === n && /精練/.test(String(t.outputItem.customName || ''))));
  const isGoods = (i) => cfg.goods.test(String(i.customName || '').replace(/§./g, ''));
  const isStash = (i) => (isGoods(i) && !cfg.wang) || isRefined(i); // 煤不再存，拿去礦物收購商卖；cfg.wang 时货留着拿去王員外换金锭；精練元素存
  const nug = () => h.count('gold_nugget'), ing = () => h.count('gold_ingot'), note = () => h.count('iron_ingot');
  const wealth = () => nug() + 10 * ing() + 100 * note();
  const buyNeed = () => { // 买到目标还需要多少铜钱
    const nA = Math.max(0, Math.ceil((cfg.buyArrowTo - h.count('arrow')) / 64)), nF = Math.max(0, Math.ceil((cfg.buyFoodTo - food()) / 6)); // 蒙古烤肉 5 铜钱 → 6 牛排
    return { nA, nF, cost: nA * 4 + nF * 5 };
  };
  const coal = () => plain('coal');
  // 背包还能放多少铜钱：空格 ×64 + 现有铜钱堆的余量（留 1 个空格给箭/牛排）
  const nugRoom = () => Math.max(0, bot.inventory.emptySlotCount() - 1) * 64 + bot.inventory.items().filter((i) => i.name === 'gold_nugget' && !i.customName).reduce((a, i) => a + (64 - i.count), 0);
  const errs = (e) => String(e && e.message || e).slice(0, 40);
  async function stashAll() { // 錢莊旁末影箱 (31,47,161)，从录好路线的终点就能打开
    const cnt = () => bot.inventory.items().filter(isStash).reduce((a, i) => a + i.count, 0);
    const c0 = cnt(); if (!c0) return 'none';
    const ec = bot.findBlock({ matching: (b) => b && b.name === 'ender_chest', maxDistance: 7 });
    if (!ec) return 'no ender chest';
    await bot.lookAt(ec.position.offset(0.5, 0.5, 0.5), true);
    const w = await bot.openContainer(ec);
    try { // 第一次开箱：存之前的 背包+箱子 作为新的统计起点（之前没看过箱子，旧起点算不准）
      await sleep(400); const fs = require('fs'), LF = require('../paths').mem('ledger.json');
      let L = {}; try { L = JSON.parse(fs.readFileSync(LF, 'utf8')); } catch {}
      if (!L.bagBase) {
        const mk = (arr) => { const m = {}; for (const it of arr) { if (!it) continue; const k = it.customName ? it.customName.replace(/§./g, '') : it.name + (it.name === 'skull' ? ':' + it.metadata : ''); m[k] = (m[k] || 0) + it.count; } return m; };
        L.bagBase = mk(w.slots.slice(w.inventoryStart, w.inventoryEnd)); L.enderBase = mk(w.containerItems()); L.baseT = new Date().toString().slice(0, 24);
        fs.writeFileSync(LF, JSON.stringify(L, null, 1));
      }
    } catch (e) { log('ledger base err ' + errs(e)); }
    try {
      for (let pass = 0; pass < 2; pass++) {
        for (let i = w.inventoryStart; i < w.inventoryEnd; i++) { const s = w.slots[i]; if (s && isStash(s)) { await bot.clickWindow(i, 0, 1); await sleep(150); } }
        await sleep(400);
        if (!w.slots.slice(w.inventoryStart, w.inventoryEnd).some((s) => s && isStash(s))) break;
      }
    } finally {
      try { // 末影箱内容写账本，看门狗把它算进资产
        await sleep(300); const fs = require('fs'), LF = require('../paths').mem('ledger.json');
        let L = {}; try { L = JSON.parse(fs.readFileSync(LF, 'utf8')); } catch {}
        const m = {}; for (const it of w.containerItems()) { const k = it.customName ? it.customName.replace(/§./g, '') : it.name; m[k] = (m[k] || 0) + it.count; }
        if (!L.enderBase) { L.enderBase = m; L.enderBaseT = new Date().toString().slice(0, 24); }
        L.ender = m; L.enderT = new Date().toString().slice(0, 24); fs.writeFileSync(LF, JSON.stringify(L, null, 1));
      } catch (e) { log('ledger err ' + errs(e)); }
      w.close(); await sleep(500);
    }
    const c1 = cnt();
    return (c0 - c1) + (c1 ? ' left ' + c1 + ' (chest full?)' : '');
  }
  // 自己的交易流程（替代 mineflayer bot.trade：它会抓到带名字的同类物品，出错时料留在交易格里，关窗后服务器会把它们掉在地上）
  // 只用无名字的普通堆放料；关窗前把交易格/鼠标上的东西全部放回背包
  // opts.input(x)：自定义"哪些背包物品可作料"（默认 同 type/meta 且无名字）；list 的 k 可以是函数 (trades)=>idx
  // 扔掉超过 cfg.maxArrow 的普通箭（先扔小组），朝 at 方向扔；返回扔掉的数量
  async function tossArrows(at) {
    let extra = h.count('arrow') - cfg.maxArrow; if (!(cfg.maxArrow > 0) || extra <= 0) return 0;
    st.step = 'tossArrow'; const n0 = extra;
    if (at) { try { await bot.lookAt(at, true); } catch {} }
    const arr = bot.inventory.items().filter((i) => i.name === 'arrow' && !i.customName).sort((a, b) => a.count - b.count);
    for (const i of arr) {
      if (extra <= 0) break;
      const n = Math.min(i.count, extra);
      if (n === i.count) await bot.tossStack(i); else await bot.toss(i.type, null, n);
      extra -= n; await h.sleep(250);
    }
    return n0 - Math.max(0, extra);
  }
  async function tradeNpc(name, list, tag, out, opts = {}) {
    st.step = tag;
    let v; try { v = await h.town.reach(name); } catch (e) { out.push(tag + ' err ' + errs(e)); return 0; }
    const w = await bot.openVillager(v); const inv = () => w.slots.slice(w.inventoryStart, w.inventoryEnd);
    let total = 0; const done = [];
    const giveBack = async () => {
      if (w.selectedItem) { const e = w.firstEmptySlotRange(w.inventoryStart, w.inventoryEnd); if (e !== null) await bot.clickWindow(e, 0, 0); }
      for (const k of [0, 1]) if (w.slots[k]) { await bot.clickWindow(k, 0, 1); await sleep(150); }
    };
    try {
      for (let [k, times] of list) {
        if (typeof k === 'function') { for (let q = 0; q < 10 && !(w.trades && w.trades.length); q++) await sleep(200); k = k(w.trades || []); }
        const T = w.trades[k]; if (!T || !T.inputItem1) continue;
        const price = T.realPrice || T.inputItem1.count; let n = 0;
        // 先选中这一项：1.8 服务器按输入找第一个能匹配的配方（10 金锭会先匹配 1 金锭→10 铜钱）
        if (bot.supportFeature('useMCTrSel')) bot._client.writeChannel('MC|TrSel', k); else bot._client.write('select_trade', { slot: k });
        await sleep(200);
        for (let t = 0; t < times; t++) {
          // 放料到 0 号格，凑够 price
          for (let g = 0; g < 6 && (!w.slots[0] || w.slots[0].count < price); g++) {
            const src = inv().filter((x) => x && x.type === T.inputItem1.type && x.metadata === T.inputItem1.metadata && (opts.input ? opts.input(x) : !x.customName)).sort((a, b) => b.count - a.count)[0];
            if (!src) break;
            await bot.clickWindow(src.slot, 0, 0);
            while (w.selectedItem && (!w.slots[0] || w.slots[0].count < price)) await bot.clickWindow(0, 1, 0);
            if (w.selectedItem) await bot.clickWindow(src.slot, 0, 0);
          }
          if (!w.slots[0] || w.slots[0].count < price) break;
          if (bot.inventory.emptySlotCount() < 1 && !inv().some((x) => x && x.type === T.outputItem.type && (x.customName || null) === (T.outputItem.customName || null) && x.count + T.outputItem.count <= x.stackSize)) { out.push(tag + ' bag full'); break; }
          await sleep(150);
          // 1.8：按 mineflayer 的做法本地预测——产物格填上、0 号格扣掉 price，否则下一次点击和服务器对不上被拒
          w.updateSlot(2, Object.assign(Object.create(Object.getPrototypeOf(T.outputItem)), T.outputItem));
          { const s0 = w.slots[0]; w.updateSlot(0, s0.count - price > 0 ? Object.assign(Object.create(Object.getPrototypeOf(s0)), s0, { count: s0.count - price }) : null); }
          const same = (x) => x && x.type === T.outputItem.type && (x.customName || null) === (T.outputItem.customName || null); // 精練元素与普通元素同 type，必须按名字区分
          const wc = () => inv().filter(same).reduce((a, x) => a + x.count, 0); const before = wc();
          try { await bot.clickWindow(2, 0, 1); } catch (e) { out.push(tag + ' click ' + errs(e)); await sleep(500); }
          await sleep(250);
          for (let q = 0; q < 6 && wc() <= before; q++) await sleep(150);
          if (wc() <= before) break; // 没成交
          n++;
        }
        await giveBack();
        done.push(k + 'x' + n); total += n;
      }
    } catch (e) { out.push(tag + ' err ' + errs(e)); }
    finally { try { await giveBack(); } catch {} await sleep(300); w.close(); await sleep(500); }
    out.push(tag + ' ' + done.join(','));
    return total;
  }
  async function bank(out) { // 留够买东西的铜钱(+10)，其余 铜钱→金锭→銀票；不够就往下换
    const need = Math.max(64, buyNeed().cost + 10); // 用户要求：出錢莊时铜钱维持一组 64
    let list = [];
    if (nug() > need) {
      const t = Math.floor((nug() - need) / 10);
      if (t) list.push([0, t]);
      const gAfter = ing() + t; if (gAfter >= 10) list.push([2, Math.floor(gAfter / 10)]);
    } else if (nug() < need) {
      const t = Math.ceil((need - nug()) / 10);
      if (ing() < t && note()) list.push([3, Math.min(note(), Math.ceil((t - ing()) / 10))]);
      list.push([1, t]); // 金锭不够时 trade 会失败停下，无害
    } else if (ing() >= 10) list.push([2, Math.floor(ing() / 10)]);
    if (list.length) await tradeNpc('錢莊', list, 'bank ' + list.map((x) => x.join('x')).join(','), out);
    try { await compact(); } catch {}
    out.push('money n' + nug() + '/g' + ing() + '/s' + note());
  }
  async function shop() {
    const out = [];
    const t0 = { arrow: h.count('arrow'), food: food(), free: bot.inventory.emptySlotCount(), money: wealth() };
    if (bot.inventory.emptySlotCount() < 3) { try { out.push('merged ' + (await compact())); } catch (e) { out.push('merge err ' + errs(e)); } }
    // 1. 元素回收員：模式为 sell 的元素（普通物品）按 5 的倍数卖掉
    const sell = ELEM.filter((n) => elemMode(n) === 'sell').map((n) => [pickElem(n, 'sell'), Math.floor(plain(n) / 5)]).filter((x) => x[1] > 0);
    const extraArrow = () => (cfg.maxArrow > 0 ? h.count('arrow') - cfg.maxArrow : 0);
    if (sell.length || extraArrow() > 0) {
      await follow('皇城南门->元素回收員'); chk();
      if (sell.length) await tradeNpc('元素回收員', sell, 'elem', out);
      // 箭超上限：在城里扔掉（刷怪点捡不到），朝回收員柜台后面扔
      if (extraArrow() > 0) { try { out.push('toss arrow ' + (await tossArrows(new Vec3(256.5, 48.5, 32.5)))); } catch (e) { out.push('toss arrow err ' + errs(e)); } }
      await follow('元素回收員->皇城南门'); chk();
    }
    // 2-3. 錢莊：煤和王員外货进末影箱，然后换钱
    await follow('皇城南门->熟食小販'); chk();
    await follow('熟食小販->南北雜貨批發'); chk();
    // 1b. 元素精煉師（林記打鐵鋪）：模式为 refine 的元素 5→1 精練元素，后面錢莊一起存末影箱；不足 5 个的留着下次
    const refine = ELEM.filter((n) => elemMode(n) === 'refine').map((n) => [pickElem(n, 'refine'), Math.floor(plain(n) / 5)]).filter((x) => x[1] > 0);
    if (refine.length) {
      const r0 = refinedN();
      await follow('南北雜貨批發->皇城鐵匠舖'); chk();
      await tradeNpc('元素精煉師', refine, 'refine', out);
      out.push('refined +' + (refinedN() - r0));
      await follow('皇城鐵匠舖->南北雜貨批發'); chk();
    }
    await follow('南北雜貨批發->錢莊'); chk();
    st.step = 'stash'; try { out.push('stash ' + (await stashAll())); } catch (e) { out.push('stash err ' + errs(e)); }
    await bank(out);
    // 3. 礦物收購商卖煤：1 煤 → 4 铜钱。按背包能装下的铜钱数卖，装不下就回錢莊压缩再跑一趟
    for (let trip = 0; trip < 4 && coal() > 0; trip++) {
      const n = Math.min(coal(), Math.floor(nugRoom() / 4));
      if (n < 1) { out.push('coal no room'); break; }
      await follow('錢莊->礦物收購商'); chk();
      const sold = await tradeNpc('礦物收購商', [[0, n]], 'coal x' + n, out);
      await follow('礦物收購商->錢莊'); chk();
      await bank(out);
      if (!sold) break;
    }
    // 4. 南北雜貨批發买箭 → 熟食小販买吃的
    await follow('錢莊->南北雜貨批發'); chk();
    let { nA, nF } = buyNeed();
    nA = Math.min(nA, Math.floor(nug() / 4));
    if (nA) await tradeNpc('南北雜貨批發', [[0, nA]], 'arrow x' + nA, out);
    await follow('南北雜貨批發->熟食小販'); chk();
    nF = Math.min(buyNeed().nF, Math.floor(nug() / 5));
    if (nF) await tradeNpc('蒙古烤肉', [[0, nF]], 'beef x' + nF, out); // 牛排，不买面包
    await follow('熟食小販->皇城南门'); chk();
    log('shop ' + out.join(' | '));
    log('shop arrow ' + t0.arrow + '→' + h.count('arrow') + ' food ' + t0.food + '→' + food() + ' free ' + t0.free + '→' + bot.inventory.emptySlotCount() + ' money ' + t0.money + '→' + wealth());
    // 还缺 → 10 分钟内不再为补给自杀（防 自杀→买不到→回farm→再自杀 死循环）
    st.shopFailAt = (h.count('arrow') < cfg.minArrow || food() < cfg.minFood || bot.inventory.emptySlotCount() < cfg.minFree) ? Date.now() : 0;
    if (st.shopFailAt) log('shop short, no resupply for 10min');
  }
  // 箭少 / 吃的少（且买得起）/ 背包快满 → 需要回城；最近 10 分钟失败过就不算
  const needShop = () => {
    const m = wealth() + 3 * ELEM.filter((n) => elemMode(n) === 'sell').reduce((a, n) => a + Math.floor(plain(n) / 5), 0);
    const na = h.count('arrow') < cfg.minArrow && m >= 4, nf = food() < cfg.minFood && m >= 5, nb = bot.inventory.emptySlotCount() < cfg.minFree;
    if (!na && !nf && !nb) return false;
    if (st.shopFailAt && Date.now() - st.shopFailAt < 600000) return false;
    return true;
  };

  // 死亡时立刻中止（否则复活后 pathfinder 继续朝刷怪点走，会从奈何桥掉进岩浆）
  // 死亡时立刻中止：只认"出了奈何桥之后"的死亡（自杀那次、以及复活时服务器重复发的 hp0 不算）
  let lastDeath = 0;
  bot.on('death', () => { lastDeath = Date.now(); if (st.state === 'run' && st.mark && lastDeath > st.mark) { try { bot.pathfinder.stop(); } catch {} bot.clearControlStates(); log('died during ' + st.step); } });
  const chk = () => { if (st.mark && lastDeath > st.mark) throw new Error('died during ' + st.step); };
  async function run(opts = {}) {
    if (st.state === 'run') return 'busy';
    st.state = 'run'; st.t0 = Date.now(); st.mark = 0;
    try {
      if (!opts.fromFarm && h.farm && h.farm.stop) h.farm.stop(); h.combat.stop(); bot.pathfinder.stop(); bot.clearControlStates(); // 从 farm 里调用时不能停 farm，否则回来后不再刷
      const nearFarm = hd(pos(), cfg.anchor) < cfg.farmR;
      if (nearFarm && !needShop() && !opts.force) { log('already at farm'); st.state = 'done'; return 'at-farm'; }
      // 1. 去皇城南门（不自杀）
      if (atNaihe()) { // 死了才会在奈何桥：踩回村板 → 录好的路
        await sleep(2500);
        st.step = 'naihe-plate'; try { bot.pathfinder.setGoal(null); bot.pathfinder.stop(); } catch {} bot.clearControlStates();
        const pl = new Vec3(205.5, 54, -1787.5);
        // 先走到中线 x=205.5（直接斜走会撞 x205 的石柱），再直走上板
        const mid = new Vec3(205.5, 54, -1771.5);
        for (let i = 0; i < 20 && atNaihe() && Math.hypot(pos().x - mid.x, pos().z - mid.z) > 0.4; i++) { await bot.lookAt(mid.offset(0, 1.6, 0), true); bot.setControlState('forward', true); bot.setControlState('jump', i % 4 === 3); await sleep(250); }
        for (let i = 0; i < 60 && atNaihe(); i++) { if (i % 8 === 0) { try { h.combat.stop(); } catch {} } await bot.lookAt(pl.offset(0, 1.6, 0), true); bot.setControlState('forward', true); bot.setControlState('jump', i % 4 === 3); await sleep(250); }
        bot.clearControlStates();
        if (atNaihe()) throw new Error('naihe plate failed');
        await sleep(2000); st.mark = Date.now(); // 从这里开始的死亡才算中途死亡
        await follow('人族出生点->皇城南门'); chk();
      } else {
        st.mark = Date.now();
        if (nearFarm) { await follow('双房->皇城南门'); chk(); }
        else if (hd(pos(), { x: cfg.south[0], z: cfg.south[2] }) > 4) { // 不在刷怪点也不在奈何桥：离线图走到南门
          st.step = 'gmap->皇城南门'; const g = await h.gmap.go(cfg.south, { tries: 2 }); log('gmap 南门 ' + (g.ok ? 'ok' : 'FAIL ' + g.err) + ' ' + (g.total || 0) + 's'); chk();
          if (!g.ok) throw new Error('gmap to 南门 ' + g.err);
        }
      }
      // 4. 补给
      // 每次回城都走完整流程：卖元素→存货→换钱→买箭/吃的，最后回到南门
      await shop();
      // 5. 南门 → 双房 → 站桩点
      chk(); await follow('皇城南门->双房'); chk();
      st.step = 'anchor';
      try { await h.goto(cfg.anchor.x, cfg.anchor.y, cfg.anchor.z, 1, 15000); } catch {}
      st.state = 'done'; st.sec = Math.round((Date.now() - st.t0) / 1000); log('home in ' + st.sec + 's');
      return 'ok ' + st.sec + 's';
    } catch (e) {
      st.state = 'err'; st.err = String(e.message || e); log('ERR ' + st.err); bot.clearControlStates();
      return 'err ' + st.err;
    }
  }
  // ---- 王員外：货 40 个一批 → 9 金锭 ----
  const goodsN = () => bot.inventory.items().filter(isGoods).reduce((a, i) => a + i.count, 0);
  const HOST = /Zombie|Skeleton|Spider|Creeper|Witch|Slime|MagmaCube|Blaze|PigZombie|Enderman|Silverfish|Guardian|Ghast|Giant/;
  const foes = (r) => Object.values(bot.entities).filter((e) => e.type === 'mob' && HOST.test(e.name) && e.isValid !== false && e.position.distanceTo(pos()) < r);
  // 有怪就停下打（combat 层管移动），清场 3s 或超时返回
  async function fightClear(r, ms, tag) {
    const t0 = Date.now(); let clear = 0;
    if (!h.combat.state().on) h.combat.start({ approach: false });
    while (Date.now() - t0 < ms) {
      chkW();
      if (foes(r).length || h.combat.state().target) clear = 0; else if ((clear += 500) >= 3000) break;
      await sleep(500);
    }
    const left = foes(r).length; log(tag + ' fight ' + Math.round((Date.now() - t0) / 1000) + 's left ' + left); return left;
  }
  // 边走边打：combat 开着，有目标进 12 格就中止 gmap，打完再走
  async function walkFight(goal, tag) {
    for (let k = 0; k < 8; k++) {
      chkW(); st.step = tag;
      if (!h.combat.state().on) h.combat.start({ approach: false });
      const near = () => { const t = h.combat.state().target; return !!(t && t.d < 12); };
      const g = await h.gmap.go(goal, { tries: 2, abort: near });
      if (g.ok) return true;
      log(tag + ' ' + g.err);
      if (/aborted/.test(g.err || '')) { await fightClear(16, 30000, tag); continue; }
      const hp = Array.isArray(goal) ? goal : [goal.x, goal.y, goal.z];
      if (Math.hypot(pos().x - hp[0], pos().z - hp[2]) < 4) return true;
      await sleep(1000);
    }
    return false;
  }
  let wDeath = 0; const chkW = () => { if (st.wangMark && wDeath > st.wangMark) throw new Error('died'); };
  bot.on('death', () => { wDeath = Date.now(); });
  const wangDue = () => cfg.wang && goodsN() >= Math.max(40, cfg.wangMin) && !(st.wangFailAt && Date.now() - st.wangFailAt < 600000);
  async function wang(out = [], opts = {}) {
    if (st.wangBusy) return 'busy';
    st.wangBusy = true; st.wangMark = Date.now();
    const g0 = ing(), n0 = goodsN(), t0 = Date.now(); const wasC = h.combat.state().on;
    try {
      if (n0 < 40) return 'goods ' + n0 + ' <40';
      try { bot.pathfinder.stop(); } catch {} bot.clearControlStates();
      if (!(await walkFight(cfg.wangAt, 'wang go'))) throw new Error('walk failed');
      await fightClear(cfg.wangClearR, cfg.wangWaitMs, 'wang arrive');
      if (bot.health < 8) throw new Error('low hp ' + Math.round(bot.health));
      const room = bot.inventory.emptySlotCount() * 64 + bot.inventory.items().filter((i) => i.name === 'gold_ingot' && !i.customName).reduce((a, i) => a + 64 - i.count, 0);
      const times = Math.min(Math.floor(goodsN() / 40), Math.floor(room / 9) + 1); // 交出 40 货本身会腾格子
      h.combat.stop(); bot.clearControlStates(); await sleep(300);
      const pick = (T) => { const k = T.findIndex((t) => t && t.outputItem && t.outputItem.name === 'gold_ingot' && t.inputItem1 && t.inputItem1.name === 'dye'); return k >= 0 ? k : 2; };
      const n = await tradeNpc(cfg.wangNpc, [[pick, times]], 'wang x' + times, out, { input: isGoods });
      log('wang traded ' + n + ' gold ' + g0 + '→' + ing());
      if (!opts.stay && cfg.anchor) {
        if (!(await walkFight([cfg.anchor.x, cfg.anchor.y, cfg.anchor.z], 'wang back'))) throw new Error('walk back failed');
        try { await h.goto(cfg.anchor.x, cfg.anchor.y, cfg.anchor.z, 1, 10000); } catch {}
      }
      st.wangFailAt = n ? 0 : Date.now();
      return 'ok x' + n + ' gold ' + g0 + '→' + ing() + ' goods ' + n0 + '→' + goodsN() + ' ' + Math.round((Date.now() - t0) / 1000) + 's';
    } catch (e) {
      st.wangFailAt = Date.now(); log('wang ERR ' + errs(e)); bot.clearControlStates();
      return 'err ' + errs(e);
    } finally {
      st.wangBusy = false; if (wasC) h.combat.start({ approach: false }); else h.combat.stop();
    }
  }
  function wangBg(opts) { st.wangJob = { state: 'run', t: Date.now(), out: [] }; wang(st.wangJob.out, opts).then((r) => { st.wangJob.state = 'done'; st.wangJob.r = r; }); return 'started'; }
  return { cfg, st, run, shop, tossArrows, needShop, compact, tradeNpc, wang, wangBg, wangDue, goodsN };
};
