// 末影箱快照：每次打开/关闭末影箱时把内容写进 memory/ledger.json（ender=最新内容，enderBase=第一次看到的内容）
// 看门狗用它把末影箱里的东西算进资产。只读，不动任何物品。
const fs = require('fs'), path = require('path');
const LF = require('../paths').mem('ledger.json');
const key = (i) => (i.customName ? i.customName.replace(/§./g, '') : i.name + (i.name === 'skull' ? ':' + i.metadata : ''));
module.exports = (bot, h) => {
  if (bot._enderWatch) return 'already';
  bot._enderWatch = true;
  const load = () => { try { return JSON.parse(fs.readFileSync(LF, 'utf8')); } catch { return {}; } };
  const snap = (win, when) => {
    try {
      const m = {};
      for (const i of win.containerItems()) m[key(i)] = (m[key(i)] || 0) + i.count;
      const L = load();
      if (!L.enderBase) { L.enderBase = m; L.enderBaseT = new Date().toString().slice(0, 24); }
      L.ender = m; L.enderT = new Date().toString().slice(0, 24); L.enderWhen = when;
      fs.writeFileSync(LF, JSON.stringify(L, null, 1));
    } catch (e) { console.log('enderwatch err', e.message); }
  };
  bot.on('windowOpen', (win) => {
    const t = String(win.title || '') + ' ' + String(win.type || '');
    if (!/ender|末影/i.test(t)) return;
    setTimeout(() => snap(win, 'open'), 50);
    bot.once('windowClose', (w) => snap(w || win, 'close'));
  });
  return 'ok';
};
