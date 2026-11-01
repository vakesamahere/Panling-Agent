// 馬賊刷怪點 预设 v2：屋外 A / 屋内 B 捡东西（loot.js）
h.farm.stop();h.speedOn=false;/* 用户要求：禁止走路手持加速道具（浮雲連天会被服务器拉回） */h.reloadFarm();delete require.cache[require.resolve('./heuristics/home')];h.home=require('./heuristics/home')(bot,h);try{Object.assign(h.home.cfg,JSON.parse(require('fs').readFileSync(require('./paths').mem('home_cfg.json'),'utf8')))}catch(e){};await h.sleep(300);
h.combat.resetStats();h.dmg.n=0;h.dmg.total=0;h.dmg.log=[];
Object.assign(h.combat.cfg,{fleeDist:6,safeDist:10,range:24,maxFleeDist:9,maxSafeDist:15,maxFleeMs:4000,fleeLeash:16,meleeDist:0,
  fleePts:[{x:-172,z:684},{x:-162,z:688},{x:-152,z:686},{x:-142,z:682},{x:-176,z:676},{x:-140,z:672}]});
const sp=[{k:'射手',x:-156.5,y:45,z:660.5},{k:'凋A',x:-168.5,y:45,z:660.5},{k:'僵',x:-168.5,y:45,z:668.5},{k:'凋B',x:-159.5,y:44,z:668.5}];
if(h.farmCombatPreset)Object.assign(h.combat.cfg,h.farmCombatPreset); // 撤离路/撤退点（bot.js）
h.combat.start({approach:false});
const r=h.farm.start({anchor:{x:-164,y:45,z:673},retreat:{x:-135,y:45,z:680},leash:4,lootR:22,lootLeash:22,lowHp:14,okHp:22,spawners:sp,route:'馬賊刷怪點'});
Object.assign(h.farm.cfg,{town:false,peek:true,peekOnly:/^Skeleton:0$/,peekDelay:2000,junk:/^$/,
  peekPts:[{x:-157,y:45,z:681},{x:-156,y:45,z:681},{x:-157,y:45,z:679},{x:-156,y:45,z:673},{x:-156,y:45,z:671},{x:-158,y:45,z:688}]});
if(h.loot&&h.loot.dispose)h.loot.dispose();
delete require.cache[require.resolve('./heuristics/loot')];
h.loot=require('./heuristics/loot')(bot,h,h.farm);
// 屋子：box=[x0,x1,z0,z1] 内部(含门格)，door=门外一格，sp=进出会碰到的刷出点
h.loot.cfg.houses=[
  {k:'西屋',box:[-170,-168,659,665],door:{x:-168.5,y:45,z:665.5},sp:['凋A','僵']},
  {k:'东屋',box:[-158,-153,659,665],door:{x:-156.5,y:45,z:665.5},sp:['射手','凋B']},
];
return r;

try { require('./heuristics/enderwatch')(bot, h); } catch (e) {}
