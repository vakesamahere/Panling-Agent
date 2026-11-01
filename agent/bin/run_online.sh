#!/bin/bash
# 线上号守护：掉线/被踢后重连，连上后自动开刷。连续失败则退避（30s→1→2→4→8→10min），避免被服务器当成刷连接
# 下线：存在 memory/offline.flag 时不连（看板「下线」建它并让号退出；「上线」删掉它并建 memory/resume.flag 打断等待）
# 上下线和刷怪分开：连上后只有存在 memory/autofarm.flag 才自动开刷（看板「刷怪循环 开」建它，「关」/「全停」删它）
cd "$(dirname "$0")/.."
L=logs/online_watch.log
PF=memory/pause.flag; OF=memory/offline.flag; RF=memory/resume.flag
FAIL=${FAIL0:-0}
alive() { timeout 5 scripts/q2.sh 'return bot.entity?1:0' 2>/dev/null | grep -q '"r":1'; }
nap() { # 睡 $1 秒，遇到 resume.flag 提前醒
  for i in $(seq 1 $(( ($1 + 4) / 5 ))); do [ -f $RF ] && { rm -f $RF; FAIL=0; return; }; [ -f $OF ] && return; sleep 5; done; }
while true; do
  if [ -f $OF ]; then echo "$(date +%T) offline (flag)" >> $L; while [ -f $OF ]; do sleep 5; done; rm -f $RF; FAIL=0; echo "$(date +%T) online again" >> $L; fi
  if alive; then
    # 已有在线的号（比如守护脚本重启过），不另开，等它断开
    echo "$(date +%T) attach to running bot" >> $L
    T0=$(date +%s); while alive; do sleep 10; done; T1=$(date +%s); OK=1
  else
    echo "$(date +%T) start (fail=$FAIL)" >> $L
    ONLINE=1 node src/bot.js vakesamahere >> logs/bot_online.out 2>&1 &
    PID=$!
    OK=0
    for i in $(seq 1 30); do sleep 3; alive && { OK=1; break; }; done
    [ $OK = 1 ] && { sleep 5; [ -f memory/autofarm.flag ] && timeout 30 scripts/q2.sh -f scripts/eval/farm_start.js >> $L 2>&1; }
    T0=$(date +%s); wait $PID; T1=$(date +%s)
  fi
  echo "$(date +%T) exited, up $((T1-T0))s" >> $L
  [ -f $OF ] && continue
  if [ $OK = 1 ] && [ $((T1-T0)) -gt 300 ]; then FAIL=0; else FAIL=$((FAIL+1)); fi
  W=30; [ $FAIL -ge 2 ] && W=$((60 * (1 << (FAIL-2)))); [ $W -gt 600 ] && W=600
  echo "$(date +%T) wait ${W}s" >> $L
  nap $W
done
