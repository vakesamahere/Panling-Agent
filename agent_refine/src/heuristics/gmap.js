// 离线图规划 + gfollow 执行。图数据：mc/pathfinder_out/node/data（HPC 导出，PFG3）。
// h.gmap.plan(goal) / h.gmap.go(goal, opts) ; goal = 地点名(memory/world.json places) | [x,y,z]
// 规划跑在 worker 线程里（pathfinder_out/node/plan_worker.js），A* 不再占住主线程；
// 老的同步接口 planSync 保留给本地测试脚本用。
// 失败写回 memory/gmap_fail.json（第几格、原因），以后可用来加代价。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..', 'pathfinder_out', 'node');
const FAIL = require('../paths').mem('gmap_fail.json');

module.exports = (bot, h) => {
  const G = require(path.join(ROOT, 'graph.js'));
  let loaded = false;
  const st = { log: [], last: null, job: null, worker: null, pending: new Map(), seq: 0 };
  const log = (s) => { st.log.push(new Date().toTimeString().slice(0, 8) + ' ' + s); if (st.log.length > 40) st.log.shift(); };
  function ensure() { if (!loaded) { G.load(path.join(ROOT, 'data'), { maxRegions: 16 }); loaded = true; } }

  // ---- worker plumbing ----
  function worker() {
    if (st.worker) return st.worker;
    const { Worker } = require('worker_threads');
    const w = new Worker(path.join(ROOT, 'plan_worker.js'), { workerData: { dir: path.join(ROOT, 'data'), maxRegions: 16 } });
    w.unref(); // 不阻止进程退出
    w.on('message', (m) => {
      if (m && m.ready) { st.workerMem = m.mem; return; }
      const p = st.pending.get(m && m.id); if (!p) return;
      st.pending.delete(m.id);
      if (m.ok) p.resolve(m); else p.reject(new Error(m.err || 'worker error'));
    });
    w.on('error', (e) => { log('worker error ' + e.message); killWorker(e); });
    w.on('exit', (c) => { if (st.worker === w) { st.worker = null; killWorker(new Error('worker exited ' + c)); } });
    st.worker = w;
    return w;
  }
  function killWorker(err) {
    const w = st.worker; st.worker = null;
    for (const [, p] of st.pending) p.reject(err || new Error('worker stopped'));
    st.pending.clear();
    if (w) { try { w.terminate(); } catch {} }
  }
  // A* 是不可中断的同步循环，取消只能终止 worker，下次用时再起
  function cancel() { if (st.worker) { log('cancel plan'); killWorker(new Error('cancelled')); } }

  function planAsync(a, b, opts = {}) {
    const w = worker();
    const id = ++st.seq;
    w.ref(); // 有请求在跑时保持进程不退出，算完再 unref
    return new Promise((resolve, reject) => {
      const done = (fn) => (v) => { if (!st.pending.size && st.worker) st.worker.unref(); fn(v); };
      const timer = setTimeout(() => { st.pending.delete(id); done(reject)(new Error('plan timeout')); }, opts.timeoutMs || 60000);
      st.pending.set(id, { resolve: done((m) => { clearTimeout(timer); resolve(m); }), reject: done((e) => { clearTimeout(timer); reject(e); }) });
      w.postMessage({ type: 'plan', id, from: a, to: b, opts: { maxNodes: opts.maxNodes || 1500000 } });
    });
  }

  function resolve(goal) {
    if (Array.isArray(goal)) return goal;
    const P = (h.mem && h.mem.data && h.mem.data.places) || {};
    const p = P[goal]; if (!p) throw new Error('unknown place ' + goal);
    return [p.x, p.y, p.z];
  }

  function attachInfo(cells, m) {
    const a = cells; a.info = m.info || {};
    return a;
  }

  // 起点吸不到格子（在空中/水里）：往下试几格
  async function plan(goal, from, opts = {}) {
    const p = bot.entity.position;
    const a = from || [p.x, p.y, p.z], b = resolve(goal);
    let m = await planAsync(a, b, opts), c = attachInfo(m.cells, m);
    for (let dy = 1; !c.length && /endpoint/.test(c.info.why || '') && dy <= 6; dy++) {
      m = await planAsync([a[0], a[1] - dy, a[2]], b, opts); c = attachInfo(m.cells, m);
    }
    log('plan ' + JSON.stringify(goal) + ' n' + c.length + ' len ' + (c.info.length || 0).toFixed(0) + ' ' + (c.info.ms || 0).toFixed(0) + 'ms ' + (c.info.reachable ? '' : (c.info.why || 'unreach')));
    return c;
  }

  // 同步版：只在主线程直接算，会阻塞（本地脚本/兼容老调用）
  function planSync(goal, from) {
    ensure();
    const p = bot.entity.position;
    const a = from || [p.x, p.y, p.z], b = resolve(goal);
    let c = G.plan(a, b, { maxNodes: 1500000 });
    for (let dy = 1; !c.length && /endpoint/.test(c.info.why || '') && dy <= 6; dy++) c = G.plan([a[0], a[1] - dy, a[2]], b, { maxNodes: 1500000 });
    log('planSync ' + JSON.stringify(goal) + ' n' + c.length + ' ' + (c.info.ms || 0).toFixed(0) + 'ms');
    return c;
  }

  function recordFail(goal, r, cells) {
    let F = []; try { F = JSON.parse(fs.readFileSync(FAIL, 'utf8')); } catch {}
    const c = cells[r.idx] || {}, n = cells[r.idx + 1] || {};
    F.push({ t: new Date().toISOString(), goal, err: r.err, at: [c.x, c.y, c.z], next: [n.x, n.y, n.z, n.act], pos: bot.entity.position.floored().toArray() });
    fs.writeFileSync(FAIL, JSON.stringify(F.slice(-200), null, 1));
  }

  async function go(goal, opts = {}) {
    const t0 = Date.now();
    let res = { ok: false };
    for (let tries = 0; tries < (opts.tries || 3); tries++) {
      // 刚传送/在空中：等落地再规划（空中点吸附不到格子）
      for (let w = 0; w < 40 && !bot.entity.onGround && !bot.entity.isInWater; w++) await new Promise((r) => setTimeout(r, 100));
      let cells;
      try { cells = await plan(goal, null, opts); } catch (e) { res = { ok: false, err: 'plan ' + e.message }; break; }
      if (cells.length && cells.length < 2) { res = { ok: true, stalls: 0, setbacks: 0, note: 'already-there' }; break; }
      if (!cells.length) { res = { ok: false, err: 'unreachable ' + (cells.info.why || '') }; break; }
      res = await h.gfollow.run(cells, opts);
      if (res.ok) break;
      if (/gf-replan/.test(res.err || '') && (opts._replans = (opts._replans || 0) + 1) < 4) { log('replan after tp'); tries--; continue; }
      recordFail(goal, res, cells); log('fail ' + res.err + ' retry ' + (tries + 1));
      if (/aborted/.test(res.err || '')) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    res.total = Math.round((Date.now() - t0) / 1000); st.last = res; return res;
  }
  function goBg(goal, opts) { st.job = { state: 'run', goal, t: Date.now() }; go(goal, opts).then((r) => { st.job.state = r.ok ? 'done' : 'err'; st.job.r = r; }).catch((e) => { st.job.state = 'err'; st.job.r = { err: e.message }; }); return 'started'; }
  return { st, plan, planSync, go, goBg, G, ensure, cancel };
};
