// 统一路径：所有代码都从这里取目录，别再写 __dirname 拼路径
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
module.exports = {
  ROOT,
  MEM: path.join(ROOT, 'memory'),   // 持久记忆（路线、地点、区块、账本…）
  LOGS: path.join(ROOT, 'logs'),    // 日志 + cmd.txt
  DATA: path.join(ROOT, 'data'),    // 静态数据（翻译、城区图）
  mem: (f) => path.join(ROOT, 'memory', f),
  log: (f) => path.join(ROOT, 'logs', f),
};
