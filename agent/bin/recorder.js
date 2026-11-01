// 路线录制：独立旁观号 Recorder 跟随玩家，聊天 "start-A-B" 开始、"end" 结束
const mineflayer = require('mineflayer'); const fs = require('fs');
const OUT = __dirname + '/../memory/routes_recorded.json';
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'Recorder', version: '1.8.8' });
const cmd = (s) => fs.appendFileSync(__dirname + '/../logs/cmd.txt', s + '\n');
let rec = null;
const load = () => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return {}; } };
const r1 = (v) => Math.round(v * 10) / 10;
bot.once('spawn', () => { cmd('gamemode 3 Recorder'); console.log('spawned'); });
bot.on('chat', (user, msg) => {
  if (user === 'Recorder') return;
  const m = msg.trim().match(/^start-(.+?)-(.+)$/);
  if (m) { rec = { user, from: m[1].trim(), to: m[2].trim(), t0: Date.now(), pts: [] }; cmd('tp Recorder ' + user); console.log('START', user, m[1], m[2]); return; }
  if (/^end$/i.test(msg.trim()) && rec && rec.user === user) {
    const d = load(); const key = rec.from + '->' + rec.to;
    d[key] = { from: rec.from, to: rec.to, by: user, sec: Math.round((Date.now() - rec.t0) / 1000), at: new Date().toISOString(), pts: rec.pts };
    fs.writeFileSync(OUT, JSON.stringify(d, null, 1));
    console.log('END', key, rec.pts.length, 'pts', d[key].sec + 's'); rec = null;
  }
});
setInterval(() => {
  if (!rec) return;
  const e = bot.players[rec.user] && bot.players[rec.user].entity;
  if (!e) { cmd('tp Recorder ' + rec.user); return; }
  const p = e.position, l = rec.pts[rec.pts.length - 1];
  if (!l || Math.hypot(p.x - l.x, p.z - l.z) >= 1 || Math.abs(p.y - l.y) >= 1) rec.pts.push({ x: r1(p.x), y: r1(p.y), z: r1(p.z), t: Math.round((Date.now() - rec.t0) / 100) / 10, g: e.onGround ? 1 : 0 });
  if (bot.entity.position.distanceTo(p) > 24) cmd('tp Recorder ' + rec.user);
}, 500);
bot.on('kicked', (r) => console.log('kicked', r)); bot.on('error', (e) => console.log('err', e.message));
bot.on('end', () => { console.log('end'); process.exit(1); });
