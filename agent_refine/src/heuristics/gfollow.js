// 图路径跟随器：按 HPC 离线图导出的逐格路径（cells:[{x,y,z,act,...}]）走。
// 与 routes.js（跟录像折线）分开：这里要贴格子中心走，跳/下/门之前先对齐。
// h.gfollow.run(cells, opts) -> {ok, sec, stalls, setbacks, err, idx}
const { Vec3 } = require('vec3');

module.exports = (bot, h) => {
  const st = { log: [], last: null };
  const log = (s) => { st.log.push(new Date().toTimeString().slice(0, 8) + ' ' + s); if (st.log.length > 60) st.log.shift(); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pos = () => bot.entity.position;
  const ctl = (k, v) => bot.setControlState(k, v);
  const stop = () => { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) ctl(k, false); };
  const cx = (c) => Math.floor(c.x) + 0.5, cz = (c) => Math.floor(c.z) + 0.5;
  const hd = (p, c) => Math.hypot(p.x - cx(c), p.z - cz(c));
  const SPECIAL = /jump|drop|door|gate|ladder|swim|teleport|water/;
  const special = (c) => c && SPECIAL.test(c.act || '');
  const inCol = (p, c) => Math.floor(p.x) === Math.floor(c.x) && Math.floor(p.z) === Math.floor(c.z) && Math.abs(p.y - c.y) < (c.interp ? 6 : 1.3);
  const look = (x, z) => bot.lookAt(new Vec3(x, pos().y + 1.62, z), true).catch(() => {});
  // 走路时手持的物品（神速羽毛=加速）。h.walkHold = /神速羽毛/ ；自动吃东西会换掉，所以定期换回来
  let holdAt = 0;
  // slow=true：接近跳/落/门/传送时换掉羽毛减速，防冲过头
  async function hold(slow = false) {
    if (h.speed) return h.speed.hold(slow); // 自动识别加速物（speed.js）
    if (!h.walkHold || bot._eating) return;
    const ok = (i) => i && h.walkHold.test(String(i.customName || '').replace(/§./g, ''));
    if (slow) {
      if (ok(bot.heldItem)) { const q = bot.quickBarSlot; for (let s = 1; s < 9; s++) { const k = (q + s) % 9; if (!ok(bot.inventory.slots[36 + k])) { bot.setQuickBarSlot(k); break; } } holdAt = Date.now(); }
      return;
    }
    if (Date.now() - holdAt < 1500) return;
    holdAt = Date.now();
    if (ok(bot.heldItem)) return;
    const it = bot.inventory.items().find(ok);
    if (it) { try { await bot.equip(it, 'hand'); } catch {} }
  }

  // 精确走到格子中心（低速，不冲刺）
  // toward: 下一格。已经顺着方向过了中心一点（横向误差小）就算对齐，不往回走
  async function center(c, tol = 0.22, ms = 2500, toward = null) { st.inCenter = (st.inCenter || 0) + 1;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const p = pos(); const d = hd(p, c);
      if (d < tol) { stop(); return true; }
      if (toward && d < 0.7) {
        const ux = cx(toward) - cx(c), uz = cz(toward) - cz(c), L = Math.hypot(ux, uz) || 1;
        const along = ((p.x - cx(c)) * ux + (p.z - cz(c)) * uz) / L, lat = Math.abs((p.x - cx(c)) * uz - (p.z - cz(c)) * ux) / L;
        if (along > -0.1 && along < 0.95 && lat < 0.25) { stop(); return true; }
      }
      await look(cx(c), cz(c)); ctl('sprint', false); ctl('forward', true);
      ctl('jump', bot.entity.isInWater);
      if (d < 0.6) { await sleep(50); ctl('forward', false); await sleep(50); } else await sleep(50);
    }
    stop(); return false;
  }

  async function openDoor(c) {
    if (c.bx === undefined) return;
    const b = bot.blockAt(new Vec3(c.bx, c.by, c.bz)); if (!b) return;
    if (!/door|gate/.test(b.name) || /iron/.test(b.name)) return;
    try { await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true); await bot.activateBlock(b); log('click ' + b.name + ' ' + b.position); } catch (e) { log('click fail ' + e.message); }
    await sleep(350);
  }

  async function run(cells, opts = {}) {
    if (!cells || cells.length < 2) return { ok: false, err: 'no-cells' };
    const t0 = Date.now(); const res = { ok: false, stalls: 0, setbacks: 0, n: cells.length };
    const onForced = () => { res.setbacks++; };
    bot.on('forcedMove', onForced);
    let idx = 0, lastIdx = 0, lastProg = Date.now(), sameStall = 0;
    const deadline = t0 + (opts.timeoutMs || Math.max(60000, cells.length * 900));
    try {
      if (bot.pathfinder) { bot.pathfinder.setGoal(null); bot.pathfinder.stop(); }
      stop();
      // 接入：离起点 >2 先走到起点
      if (hd(pos(), cells[0]) > 2) { try { await h.goto(cx(cells[0]), cells[0].y, cz(cells[0]), 1, 10000); } catch (e) { log('join ' + e.message); } }
      while (idx < cells.length - 1) {
        if (Date.now() > deadline) throw new Error('gf-timeout #' + idx);
        if (opts.abort && opts.abort()) throw new Error('aborted');
        await hold(cells.slice(idx + 1, idx + 4).some(special));
        const p = pos();
        // 推进：窗口内最远的、bot 在其列里或离中心 <0.8 的格子（高速时一次检查会跨过整格，只认格子会漏）
        const near = (c) => inCol(p, c) || (hd(p, c) < 0.8 && Math.abs(p.y - c.y) < (c.interp ? 6 : 1.3));
        for (let k = Math.min(cells.length - 1, idx + 16); k > idx; k--) if (near(cells[k])) { idx = k; break; }
        if (idx >= cells.length - 1) break;
        const nx = cells[idx + 1]; st.idx = idx; st.nact = (cells.slice(idx + 1, idx + 4).map(c => c.act || 'w')).join(',');
        // 偏离太远：重新找最近格
        const off = hd(p, cells[idx]);
        if (off > 4 && !inCol(p, nx)) {
          // 已经被传送（走路时顺脚踩到板）：在前方 12 格里找 teleport 格
          let tpk = -1;
          for (let k = idx + 1; k < Math.min(cells.length, idx + 12); k++) if (cells[k].act === 'teleport' && hd(p, cells[k]) < 4) { tpk = k; break; }
          if (tpk >= 0) { await sleep(1200); idx = tpk; lastIdx = idx; lastProg = Date.now(); log('tp(walk) ok -> ' + pos().floored()); continue; }
          let best = idx, bd = 1e9;
          for (let k = Math.max(0, idx - 10); k < Math.min(cells.length, idx + 40); k++) { const d = hd(p, cells[k]) + (cells[k].interp ? 0 : Math.abs(p.y - cells[k].y) * 2); if (d < bd) { bd = d; best = k; } }
          if (bd < 4) { idx = best; continue; }
          throw new Error('gf-lost #' + idx + ' off ' + off.toFixed(1));
        }
        if (nx.act === 'teleport') {
          // 当前格是触发板：踩到中心，等位置跳变；不行就来回蹭
          const trg = cells[idx], from = pos().clone();
          let jumped = false;
          for (let w = 0; w < 60 && !jumped; w++) {
            if (pos().distanceTo(from) > 8) { jumped = true; break; }
            if (w % 15 === 0) { await center(trg, 0.15, 1500); }
            else { await sleep(100); }
            if (w % 15 === 14) { await look(cx(trg) + 1, cz(trg)); ctl('back', true); await sleep(250); ctl('back', false); }
          }
          stop();
          if (!jumped) throw new Error('gf-tp-fail #' + idx);
          await sleep(1200);
          for (let w = 0; w < 20 && !bot.world.getColumnAt(pos()); w++) await sleep(300);
          idx++;
          // 落点可能偏几格：在传送后 15 格里找最近格
          { let best = idx, bd = 1e9; for (let k = idx; k < Math.min(cells.length, idx + 15); k++) { const d = hd(pos(), cells[k]) + Math.abs(pos().y - cells[k].y); if (d < bd) { bd = d; best = k; } }
            idx = best; if (bd > 2.5) { log('tp landed off ' + bd.toFixed(1) + ' -> replan'); throw new Error('gf-replan tp'); } }
          log('tp ok -> ' + pos().floored());
          lastIdx = idx; lastProg = Date.now(); continue;
        }
        if (special(nx)) {
          // 特殊动作：先对齐当前格中心，再朝下一格做动作
          // 高速时可能已经冲进下一格：直接算完成，不往回走对齐
          if (inCol(pos(), nx) && !/door|gate/.test(nx.act)) { idx++; continue; }
          stop();
          // 下落不需要精确对齐：横向偏差小就直接走出去
          const dropOk = (/drop/.test(nx.act) && hd(pos(), cells[idx]) < 0.8) || (/jump/.test(nx.act) && hd(pos(), cells[idx]) < 0.45);
          if (!dropOk) await center(cells[idx], 0.22, 2500, nx);
          const act = nx.act;
          await look(cx(nx), cz(nx));
          if (/door|gate/.test(act)) await openDoor(nx);
          if (/jump/.test(act)) {
            ctl('forward', true); ctl('jump', true);
            // 起跳后一进目标格就松前进，高速时防止一跳冲出 2-3 格
            for (let w = 0; w < 14; w++) { await sleep(50); if (!bot.entity.onGround) ctl('jump', false); if (inCol(pos(), nx) || hd(pos(), nx) < 0.45) { ctl('forward', false); break; } }
            ctl('jump', false);
          } else if (/drop/.test(act)) {
            // 走出边缘就松开前进，空中按目标格中心微调，防止惯性冒过头
            ctl('forward', true);
            for (let w = 0; w < 40; w++) {
              const q = pos(); const dd = hd(q, nx);
              if (inCol(q, nx) && bot.entity.onGround) break;
              const inside = Math.floor(q.x) === Math.floor(nx.x) && Math.floor(q.z) === Math.floor(nx.z);
              if (inside && dd < 0.3) { ctl('forward', false); ctl('back', false); }
              else if (!bot.entity.onGround) { await look(cx(nx), cz(nx)); ctl('forward', dd > 0.25); }
              await sleep(50);
            }
            ctl('back', false);
          } else {
            ctl('forward', true); ctl('jump', bot.entity.isInWater || /swim|water/.test(act));
            for (let w = 0; w < 20 && !inCol(pos(), nx); w++) await sleep(50);
          }
          ctl('forward', false); ctl('jump', false);
          if (inCol(pos(), nx)) { idx++; await center(nx, 0.3, 1200); }
        } else {
          // 普通走：直线段内看最远同 y 的非特殊格；离线 >0.3 就看近点
          let j = idx + 1;
          const dx0 = Math.sign(Math.floor(nx.x) - Math.floor(cells[idx].x)), dz0 = Math.sign(Math.floor(nx.z) - Math.floor(cells[idx].z));
          while (j + 1 < cells.length && j - idx < 6 && !special(cells[j + 1]) && Math.abs(cells[j + 1].y - cells[j].y) < 0.6 &&
            Math.sign(Math.floor(cells[j + 1].x) - Math.floor(cells[j].x)) === dx0 && Math.sign(Math.floor(cells[j + 1].z) - Math.floor(cells[j].z)) === dz0) j++;
          // 横向误差：到 idx→j 直线距离
          const ax = cx(cells[idx]), az = cz(cells[idx]), bx = cx(cells[j]), bz = cz(cells[j]);
          const L = Math.hypot(bx - ax, bz - az) || 1;
          const lat = Math.abs((bx - ax) * (az - p.z) - (bz - az) * (ax - p.x)) / L;
          // 纯追踪：看路径上离 bot 至少 LA 格的第一个格子（不会看向身后的格子），速度越快看越远
          const sp = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z);
          const LA = Math.min(3.5, Math.max(1.2, sp * 8));
          let tgt = cells[j];
          for (let k = idx + 1; k <= j; k++) if (hd(p, cells[k]) >= LA) { tgt = cells[k]; break; }
          if (lat > 0.6) tgt = nx; // 偏太多才看近格
          await look(cx(tgt), cz(tgt));
          ctl('forward', true);
          ctl('sprint', j - idx >= 4 && lat < 0.25 && !special(cells[j + 1]));
          ctl('jump', bot.entity.isInWater || (bot.entity.isCollidedHorizontally && bot.entity.onGround && nx.y > p.y + 0.4));
          await sleep(50);
        }
        // 卡住检测
        if (idx > lastIdx) { lastIdx = idx; lastProg = Date.now(); sameStall = 0; }
        else if (Date.now() - lastProg > 2500) {
          res.stalls++; sameStall++; stop(); log('stall #' + idx + ' n' + sameStall + ' at ' + pos().floored());
          if (sameStall > 5) throw new Error('gf-stuck #' + idx);
          // 退回上一格中心再试；第 3 次起点门/跳一下
          await center(cells[Math.max(0, idx - (sameStall % 2))], 0.25, 2000);
          if (sameStall >= 3) { ctl('jump', true); await sleep(250); ctl('jump', false); }
          // 第 2 次起交给 pathfinder 走到下一格（头顶铁栏杆/半砖边缘这类局部卡住）
          if (sameStall >= 2 && cells[idx + 1]) { const q = cells[idx + 1]; try { await h.goto(cx(q), q.y, cz(q), 0.4, 4000); } catch {} }
          lastProg = Date.now();
        }
      }
      stop();
      const last = cells[cells.length - 1];
      await center(last, 0.35, 2000);
      res.ok = hd(pos(), last) < 1.5 && Math.abs(pos().y - last.y) < 1.5;
      if (!res.ok) res.err = 'end-off ' + hd(pos(), last).toFixed(1);
    } catch (e) { res.err = String(e.message || e); log('ERR ' + res.err); stop(); }
    finally { bot.removeListener('forcedMove', onForced); }
    res.idx = idx; res.sec = Math.round((Date.now() - t0) / 1000); st.last = res; return res;
  }

  // 从 testset JSON 取逐格路径；没有 cells 就把压缩路点按格插值
  function cellsOf(j) {
    if (Array.isArray(j.cells) && j.cells.length) return j.cells;
    const pts = j.points || []; const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      if (i) {
        const b = pts[i - 1]; const n = Math.max(Math.abs(Math.floor(a.x) - Math.floor(b.x)), Math.abs(Math.floor(a.z) - Math.floor(b.z)));
        for (let k = 1; k < n; k++) { const t = k / n; out.push({ x: b.x + (a.x - b.x) * t, y: b.y + (a.y - b.y) * t, z: b.z + (a.z - b.z) * t, act: 'walk', interp: true }); }
      }
      out.push(a);
    }
    return out;
  }
  return { st, run, cellsOf, center };
};
