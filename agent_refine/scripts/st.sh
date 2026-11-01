#!/bin/bash
# 一行状态：位置/血/饱食/面包/金粒/箭/战斗
cd "$(dirname "$0")/.."
scripts/q.sh 'const c=(n)=>bot.inventory.items().filter(i=>i.name===n).reduce((a,i)=>a+i.count,0);const k=h.combat.state();return JSON.stringify({pos:h.pos(),hp:Math.round(bot.health),food:bot.food,bread:c("bread"),gold:c("gold_nugget"),arrow:c("arrow"),combat:k.on,kills:k.kills})' | head -c 400
echo
