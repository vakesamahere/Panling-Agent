'use strict';
// A* planner running in a worker thread, so planning never blocks the bot's event loop.
//   main thread: new Worker('plan_worker.js', { workerData: { dir, maxRegions } })
//                postMessage({ id, from, to, opts })  ->  { id, ok, cells, info } | { id, ok:false, err }
// A plan is a long synchronous A* loop and cannot be interrupted, so cancelling means terminating
// the worker (see gmap.js cancel()); it is respawned lazily on the next request.
const { parentPort, workerData } = require('worker_threads');
const path = require('path');

const G = require(path.join(__dirname, 'graph.js'));
G.load(workerData.dir, { maxRegions: workerData.maxRegions || 16 });

parentPort.on('message', (m) => {
  if (!m || m.type !== 'plan') return;
  try {
    const c = G.plan(m.from, m.to, m.opts || {});
    parentPort.postMessage({ id: m.id, ok: true, cells: c, info: c.info || {} });
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, err: (e && e.message) || String(e) });
  }
});

// let the main thread know the data is loaded (region files are read lazily per plan)
parentPort.postMessage({ ready: true, mem: Math.round(process.memoryUsage().rss / 1048576) });
