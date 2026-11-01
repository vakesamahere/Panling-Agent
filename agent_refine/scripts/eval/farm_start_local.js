// 刷 馬賊刷怪點 的固定预设：./q.sh -f farm_start.js
h.farm.stop();h.reloadFarm();await h.sleep(300);
h.combat.resetStats();h.dmg.n=0;h.dmg.total=0;h.dmg.log=[];
Object.assign(h.combat.cfg,{fleeDist:6,safeDist:10,range:24,maxFleeDist:9,maxSafeDist:15,maxFleeMs:4000,fleeLeash:16,
  fleePts:[{x:-172,z:684},{x:-162,z:688},{x:-152,z:686},{x:-142,z:682},{x:-176,z:676},{x:-140,z:672}]});
const sp=[{k:'射手',x:-156.5,y:45,z:660.5},{k:'凋A',x:-168.5,y:45,z:660.5},{k:'僵',x:-168.5,y:45,z:668.5},{k:'凋B',x:-159.5,y:44,z:668.5}];
if(h.farmCombatPreset)Object.assign(h.combat.cfg,h.farmCombatPreset); // 撤离路/撤退点（bot.js）
h.combat.start({approach:false});
const r=h.farm.start({anchor:{x:-164,y:45,z:673},retreat:{x:-135,y:45,z:680},leash:4,lootR:22,lootLeash:20,lowHp:12,okHp:20,spawners:sp,route:'馬賊刷怪點'});h.farm.cfg.town=true;h.farm.cfg.peek=true;h.farm.cfg.peekOnly=/^Skeleton:0$/;h.farm.cfg.peekDelay=2000;h.farm.cfg.peekPts=[{x:-157,y:45,z:681},{x:-156,y:45,z:681},{x:-157,y:45,z:679},{x:-156,y:45,z:673},{x:-156,y:45,z:671},{x:-158,y:45,z:688}];h.combat.cfg.meleeDist=0;return r;
