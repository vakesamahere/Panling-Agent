#!/bin/bash
# 用法: ./go.sh 地点名   或   ./go.sh x y z
# 后台启动 h.travel 并轮询到结束，只打印一行结果。最长 10 分钟。
cd "$(dirname "$0")/.."
if [ $# -ge 3 ]; then A="$1,$2,$3"; else A="'$1'"; fi
printf 'h.travelBg(%s);return 1' "$A" > /tmp/go_start.js
scripts/q.sh -f /tmp/go_start.js >/dev/null
for i in $(seq 1 40); do
  sleep 15
  scripts/q.sh 'return h.job.state' | grep -q '"run' || break
done
scripts/q.sh 'const j=h.job,r=j.r||{};return JSON.stringify({state:j.state,ok:r.ok,reason:r.reason,sec:j.sec,pos:h.pos(),hp:Math.round(bot.health),food:bot.food,last:(r.log||[]).slice(-2)})' | head -c 500
echo
