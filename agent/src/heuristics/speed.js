// 走路加速物品：自动识别背包里能加速的手持物（AttributeModifiers generic.movementSpeed>0，或名字/Lore 提到 速度/移動/加速/神速），
// 按加成排序，走路时手持最好的那个。h.speed.hold(slow) 由 routes.follow / gfollow 每 tick 调用（内部节流 1.5s）。
// 不抢：吃东西中、战斗有目标、正在拉弓时都不换。slow=true 时换掉加速物（接近急弯/跳/落前减速）。
const nbtLib = require('prismarine-nbt');
module.exports = (bot, h) => {
  const TXT = /速度|移動|移动|加速|神速|疾風|疾风|風伯|风伯|浮雲|浮云/;
  const st = { holdAt: 0, swaps: 0, slows: 0 };
  const strip = (s) => String(s || '').replace(/§./g, '');
  const lore = (i) => { try { return (i.nbt.value.display.value.Lore.value.value || []).join(' '); } catch { return ''; } };
  // 加成（相对基础速度的倍数增量）：op0 绝对值/0.1，op1/op2 直接是倍数
  function score(i) {
    if (!i) return 0;
    let s = 0;
    try {
      const n = i.nbt && nbtLib.simplify(i.nbt);
      for (const m of (n && n.AttributeModifiers) || []) {
        if (!/movementSpeed/i.test(m.AttributeName || '') || !(m.Amount > 0)) continue;
        s += m.Operation === 0 ? m.Amount / 0.1 : m.Amount;
      }
    } catch {}
    if (s > 0) return s;
    const t = strip(i.customName) + ' ' + strip(lore(i));
    if (h.walkHold && h.walkHold.test(strip(i.customName))) return 0.3; // 手动指定的
    if (i.customName && TXT.test(t)) return 0.2; // 只有文字线索：排在有属性的后面
    return 0;
  }
  let cache = { t: 0, it: null };
  function best() {
    if (Date.now() - cache.t < 1000 && cache.it && bot.inventory.slots[cache.it.slot] === cache.it) return cache.it;
    let b = null, bs = 0;
    for (const i of bot.inventory.items()) { const s = score(i); if (s > bs) { bs = s; b = i; } }
    cache = { t: Date.now(), it: b }; return b;
  }
  const isFast = (i) => !!i && score(i) > 0;
  const busy = () => bot._eating || (h.combat && h.combat.state && h.combat.state().target) || bot.usingHeldItem;
  async function hold(slow = false) {
    if (h.speedOn === false || busy()) return;
    if (slow) { // 换到快捷栏里一个非加速物
      if (isFast(bot.heldItem)) {
        const q = bot.quickBarSlot;
        for (let s = 1; s < 9; s++) { const k = (q + s) % 9; if (!isFast(bot.inventory.slots[36 + k])) { bot.setQuickBarSlot(k); st.slows++; break; } }
        st.holdAt = Date.now();
      }
      return;
    }
    if (Date.now() - st.holdAt < 1500) return;
    st.holdAt = Date.now();
    const b = best(); if (!b) return;
    if (bot.heldItem && bot.heldItem.slot === b.slot) return;
    if (bot.heldItem && score(bot.heldItem) >= score(b)) return;
    try { await bot.equip(b, 'hand'); st.swaps++; } catch {}
  }
  const list = () => bot.inventory.items().map((i) => [strip(i.customName) || i.name, +score(i).toFixed(2)]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
  return { st, score, best, hold, list, isFast };
};
