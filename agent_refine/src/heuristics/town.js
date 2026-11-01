// 回皇城补给/变卖：h.town.run({sell,stash,buy}) / h.town.need()
// 顺序：錢莊末影箱存王員外货 → 礦物收購商卖煤 → 元素回收員卖腐肉/骨头 → 南北雜貨批發买箭 → 熟食小販买面包
module.exports = (bot, h) => {
  const Vec3 = require('vec3').Vec3;
  const nm = (i) => (i && i.customName ? i.customName.replace(/§./g, '') : i ? i.name : '');
  const cfg = { minArrow: 64, buyArrowTo: 256, minBread: 16, buyBreadTo: 48, minFree: 3, keepGold: 10 };
  // 进店前要先走到的点（pathfinder 直接去会卡楼下）
  const approach = { '元素回收員': [[258, 48, 40], [256, 48, 36]], '熟食小販': [[147.5, 46, 185.5]], '錢莊': [[33.5, 47, 166.5]], '蒙古烤肉': [[136.5, 46, 187.5]], '元素精煉師': [[84.5, 46, 149.5], [85.5, 46, 149.5]] }; // 精煉師：录好的路终点 (84.5,149) 离 NPC ~3.2 格，再往东 1 格；别走 (86,145) 楼梯角（会被拉回） // 熟食小販在柜台里，录好的路终点 3.7 格开不了
  const st = { log: [], runs: 0, busy: false };
  const log = (m) => { st.log.push(new Date().toTimeString().slice(0, 8) + ' ' + m); if (st.log.length > 40) st.log.shift(); };

  const FOOD = /^(bread|cooked_beef|cooked_fish|cooked_porkchop|cooked_chicken|cooked_mutton|baked_potato|cooked_rabbit|golden_carrot)$/;
  const food = () => bot.inventory.items().filter((i) => FOOD.test(i.name)).reduce((a, i) => a + i.count, 0);
  function need() {
    const why = [];
    if (h.count('arrow') < cfg.minArrow) why.push('arrow');
    if (food() < cfg.minBread) why.push('food');
    if (bot.inventory.emptySlotCount() < cfg.minFree) why.push('full');
    return why;
  }
  const npc = (n) => Object.values(bot.entities).filter((e) => e.name === 'Villager' && String(e.metadata[2] || '').includes(n))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];

  async function reach(name) {
    let v = npc(name);
    const P = h.mem && h.mem.data.places && h.mem.data.places[name];
    if ((!v || v.position.distanceTo(bot.entity.position) > 12) && P) { try { await h.goto(P.x, P.y, P.z, 2, 45000); } catch (e) { log(name + ' goto ' + String(e.message).slice(0, 30)); } } // 只在城里短距离 goto，不用旧寻路
    for (const w of approach[name] || []) { try { await h.goto(w[0], w[1], w[2], 1, 12000); } catch {} }
    v = npc(name);
    if (!v) throw new Error('no npc ' + name);
    if (v.position.distanceTo(bot.entity.position) > 3.3) {
      const d0 = v.position.distanceTo(bot.entity.position), p0 = bot.entity.position.clone();
      try { await h.goto(v.position.x, v.position.y, v.position.z, 1.5, 12000); } catch {}
      // goto 反而走远（柜台挡住绕路）→ 回到原位
      if (v.position.distanceTo(bot.entity.position) > d0 + 0.3) { try { await h.goto(p0.x, p0.y, p0.z, 0.5, 8000); } catch {} }
    }
    // 还远：朝 NPC 直走一小段（柜台前 pathfinder 常绕远）
    for (let i = 0; i < 3 && v.position.distanceTo(bot.entity.position) > 3.0; i++) { await bot.lookAt(v.position.offset(0, 1.6, 0), true); bot.setControlState('forward', true); await h.sleep(400); bot.clearControlStates(); await h.sleep(150); }
    if (v.position.distanceTo(bot.entity.position) > 3.6) throw new Error('far ' + name + ' ' + v.position.distanceTo(bot.entity.position).toFixed(1));
    try { bot.clearControlStates(); await bot.lookAt(v.position.offset(0, 1.6, 0), true); await h.sleep(300); } catch {}
    return v;
  }
  async function trade(name, list) { // list: [[idx,times]]
    const v = await reach(name); const w = await bot.openVillager(v); let n = 0;
    try { for (const [k, t] of list) for (let i = 0; i < t; i++) { try { await bot.trade(w, k, 1); n++; } catch (e) { log(name + ' ' + k + ' ' + String(e.message).slice(0, 25)); break; } } }
    finally { w.close(); await h.sleep(400); }
    return n;
  }
  async function stash() {
    const goods = bot.inventory.items().filter((i) => /王員外/.test(nm(i)));
    if (!goods.length) return 0;
    await h.travel('錢莊');
    const ec = bot.findBlock({ matching: (b) => b && b.name === 'ender_chest', maxDistance: 8 });
    if (!ec) { log('no ender chest'); return 0; }
    await h.goto(ec.position.x, ec.position.y, ec.position.z, 1.5, 8000).catch(() => {});
    await bot.lookAt(ec.position.offset(0.5, 0.5, 0.5));
    const w = await bot.openContainer(ec); let moved = 0;
    try { for (let i = w.inventoryStart; i < w.inventoryEnd; i++) { const s = w.slots[i]; if (s && /王員外/.test(nm(s))) { await bot.clickWindow(i, 0, 1); moved += s.count; await h.sleep(80); } } }
    finally { w.close(); await h.sleep(400); }
    return moved;
  }

  async function run(o = {}) {
    if (st.busy) return 'busy';
    st.busy = true; st.runs++; const out = [];
    const wasCombat = h.combat && h.combat.state().on; if (h.combat) h.combat.stop();
    try {
      const g0 = h.count('gold_nugget');
      // 丢垃圾：空瓶、胡萝卜、初心者旧装备（已穿四阶套）
      if (false) for (const i of bot.inventory.items()) if (/^(glass_bottle|carrot)$/.test(i.name) || /^初心者/.test(nm(i))) { try { await bot.tossStack(i); await h.sleep(60); } catch {} }
      try { out.push('stash ' + await stash()); } catch (e) { out.push('stash err ' + String(e.message).slice(0, 30)); }
      if (h.count('coal')) { try { out.push('coal ' + await trade('礦物收購商', [[0, h.count('coal')]])); } catch (e) { out.push('coal err ' + String(e.message).slice(0, 30)); } }
      const rf = Math.floor(h.count('rotten_flesh') / 5), bn = Math.floor(h.count('bone') / 5);
      if (rf + bn) { try { out.push('elem ' + await trade('元素回收員', [[0, rf], [1, bn]])); } catch (e) { out.push('elem err ' + String(e.message).slice(0, 30)); } }
      const gold = () => h.count('gold_nugget') - cfg.keepGold;
      const aN = Math.max(0, Math.min(Math.ceil((cfg.buyArrowTo - h.count('arrow')) / 64), Math.floor(gold() / 4)));
      if (aN) { try { out.push('arrow +' + 64 * await trade('南北雜貨批發', [[0, aN]])); } catch (e) { out.push('arrow err ' + String(e.message).slice(0, 30)); } }
      const bN = Math.max(0, Math.min(Math.ceil((cfg.buyBreadTo - food()) / 12), Math.floor(gold() / 5)));
      if (bN) { try { out.push('bread +' + 12 * await trade('熟食小販', [[0, bN]])); } catch (e) { out.push('bread err ' + String(e.message).slice(0, 30)); } }
      // 铜钱满 100 换元宝，省格子
      if (h.count('gold_nugget') >= 100 + cfg.keepGold + 40) { try { out.push('bank ' + await trade('錢莊', [[0, Math.floor((h.count('gold_nugget') - cfg.keepGold - 40) / 10)]])); } catch (e) { out.push('bank err ' + String(e.message).slice(0, 30)); } }
      out.push('gold ' + g0 + '→' + h.count('gold_nugget') + ' arrow ' + h.count('arrow') + ' bread ' + h.count('bread') + ' free ' + bot.inventory.emptySlotCount());
    } finally { st.busy = false; if (wasCombat && !o.noCombat) h.combat.start({ approach: false }); }
    const r = out.join(' | '); log('run ' + r); return r;
  }
  return { cfg, st, need, run, trade, reach, stash, log: () => st.log };
};
