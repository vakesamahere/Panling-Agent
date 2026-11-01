// 把银票(iron_ingot)放进公共箱子 (49,47,162)，给 Jie_he 拿。后台跑，状态在 h.djob
// 流程：停刷 → 鶴頂丹回奈何桥 → 奈何桥板 → 人族出生点->皇城南门 → 南门->熟食小販 → 熟食小販->南北 → 南北->錢莊 → goto 箱子 → 放银票 → 返回 南北→熟食→南门→双房 → 开刷
const J = h.djob = { state: 'run', log: [], t0: Date.now() };
const L = (s) => { J.log.push(new Date().toTimeString().slice(0, 8) + ' ' + s); J.step = s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    h.farm.stop(); h.combat.stop(); h.farm.cfg.paused = true; bot.pathfinder.stop(); bot.clearControlStates();
    h.home.st.state = 'run'; // 让看门狗当作回城流程，不报"离开刷怪点"
    const fol = async (k) => { h.home.st.step = k; L(k); const r = await h.routes.follow(k); if (!r.ok) throw new Error(k + ' ' + r.err); };
    // 1 回奈何桥
    if (bot.entity.position.z > -1700) {
      h.home.st.step = 'suicide'; L('suicide');
      const pot = bot.inventory.items().find((i) => i.name === 'potion' && i.metadata === 8234);
      if (!pot) throw new Error('no 鶴頂丹');
      const dead = new Promise((r) => bot.once('death', r));
      for (let i = 0; i < 3; i++) { try { await bot.equip(pot, 'hand'); bot.activateItem(); await Promise.race([dead, sleep(4000)]); break; } catch {} }
      await Promise.race([dead, sleep(8000)]);
      await new Promise((r) => bot.once('spawn', r)); await sleep(2500);
    }
    // 2 奈何桥板
    h.home.st.step = 'naihe'; L('naihe');
    const gm = async (x, z, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const p = bot.entity.position; if (Math.hypot(p.x - x, p.z - z) < 0.4 || p.z > -1700 + 0 && p.x > 1000) return; await bot.lookAt(new Vec3(x, p.y + 1.6, z), true); bot.setControlState('forward', true); if ((Date.now() - t) % 1500 < 120) { bot.setControlState('jump', true); } else bot.setControlState('jump', false); await sleep(100); } };
    await gm(205.5, -1771.5, 6000); await gm(205.5, -1787.5, 12000); bot.clearControlStates();
    for (let i = 0; i < 60 && bot.entity.position.z < -1700; i++) await sleep(200);
    if (bot.entity.position.z < -1700) throw new Error('naihe plate fail');
    await sleep(1500);
    // 3 进皇城到錢莊
    await fol('人族出生点->皇城南门'); await fol('皇城南门->熟食小販'); await fol('熟食小販->南北雜貨批發'); await fol('南北雜貨批發->錢莊');
    // 4 去箱子
    h.home.st.step = 'chest'; L('to chest');
    const cp = new Vec3(49, 47, 162);
    const dC = () => bot.entity.position.distanceTo(cp.offset(0.5, 0.5, 0.5));
    for (let i = 0; i < 3 && dC() > 3.5; i++) { try { await h.goto(48, 47, 163, 1.5, 15000); } catch (e) { L('goto ' + e.message.slice(0, 40)); await sleep(500); } }
    if (dC() > 3.5) { // 直线走过去（錢莊门口到箱子是平路）
      const t = Date.now(); let last = bot.entity.position.clone(), lt = t;
      while (Date.now() - t < 10000 && dC() > 2.5) { const p = bot.entity.position; await bot.lookAt(new Vec3(48.5, p.y + 1.6, 163.5), true); bot.setControlState('forward', true); if (Date.now() - lt > 700) { bot.setControlState('jump', p.distanceTo(last) < 0.3); last = p.clone(); lt = Date.now(); } await sleep(50); }
      bot.clearControlStates();
    }
    L('at ' + bot.entity.position.floored() + ' d' + dC().toFixed(1));
    if (dC() > 4) throw new Error('cannot reach chest');
    const blk = bot.blockAt(cp);
    if (!blk || !/chest/.test(blk.name)) throw new Error('no chest at 49,47,162: ' + (blk && blk.name));
    await bot.lookAt(cp.offset(0.5, 0.5, 0.5), true);
    const w = await bot.openContainer(blk);
    await sleep(500);
    const before = bot.inventory.items().filter((i) => i.name === 'iron_ingot').reduce((a, i) => a + i.count, 0);
    for (let i = w.inventoryStart; i < w.inventoryEnd; i++) { const s = w.slots[i]; if (s && s.name === 'iron_ingot') { await bot.clickWindow(i, 0, 1); await sleep(250); } }
    await sleep(600);
    const left = w.slots.slice(w.inventoryStart, w.inventoryEnd).filter((s) => s && s.name === 'iron_ingot').reduce((a, s) => a + s.count, 0);
    const inChest = w.containerItems().filter((s) => s.name === 'iron_ingot').reduce((a, s) => a + s.count, 0);
    w.close(); J.put = before - left; J.inChest = inChest; L(`put ${before - left} 银票, chest now ${inChest}, bag left ${left}`);
    // 5 回刷怪点
    try { await h.goto(33.5, 47, 165.4, 1.5, 15000); } catch {}
    await fol('錢莊->南北雜貨批發'); await fol('南北雜貨批發->熟食小販'); await fol('熟食小販->皇城南门');
    await fol('皇城南门->双房');
    try { await h.goto(-164, 45, 673, 1, 20000); } catch {}
    h.home.st.state = 'done'; h.home.st.step = 'anchor';
    const AF = Object.getPrototypeOf(async function () {}).constructor;
    await new AF('bot', 'h', 'require', 'Vec3', require('fs').readFileSync('C:/Users/Administrator/Desktop/vake/mc/agent/scripts/eval/farm_start.js', 'utf8'))(bot, h, require, Vec3); L('back, farming'); J.state = 'done';
  } catch (e) {
    L('ERR ' + e.message); J.state = 'err'; h.home.st.state = 'idle'; bot.clearControlStates();
  }
})();
return 'started';
