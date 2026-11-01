// Wraps the local 盘灵古域 1.8 server: stdout -> server.log, commands via cmd.txt (one per line, appended).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVER_DIR = 'C:/Users/Administrator/Desktop/vake/.server/盘灵古域';
const LOG = path.join(__dirname, '..', 'logs', 'server.log');
const CMD = path.join(__dirname, '..', 'logs', 'cmd.txt');

fs.writeFileSync(CMD, '');
const log = fs.createWriteStream(LOG, { flags: 'w' });
const p = spawn('C:/Java/jdk-8/bin/java.exe', ['-Xmx4G', '-Xms2G', '-jar', 'server.jar', 'nogui'], { cwd: SERVER_DIR });
p.stdout.pipe(log);
p.stderr.pipe(log);
p.on('exit', (c) => { log.write(`\n[wrapper] server exited ${c}\n`); process.exit(0); });

let offset = 0;
setInterval(() => {
  const buf = fs.readFileSync(CMD);
  if (buf.length > offset) {
    const text = buf.slice(offset).toString('utf8');
    offset = buf.length;
    for (const line of text.split(/\r?\n/)) if (line.trim()) p.stdin.write(line.trim() + '\n');
  }
}, 300);
