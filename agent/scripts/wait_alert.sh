#!/bin/bash
# 主 agent 用：阻塞直到看门狗有新告警或超时（默认 600s），然后打印一行状态
cd "$(dirname "$0")/.."; T=${1:-600}; F=memory/watchdog_state.json
n0=$(node -e "try{console.log(require('./$F').alerts.length)}catch{console.log(0)}")
for ((i=0;i<T/15;i++)); do
  sleep 15
  n=$(node -e "try{console.log(require('./$F').alerts.length)}catch{console.log(0)}")
  [ "$n" != "$n0" ] && break
done
node -e "try{const w=require('./$F');console.log('LAST',w.last);console.log('REPORT',w.report||'');console.log('ALERTS',w.alerts.slice(-3).join(' || '))}catch(e){console.log('no state',e.message)}"
