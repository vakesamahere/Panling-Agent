// 刷怪循环开：按当前「路线档案」（memory/farm_profiles.json，看板可切）整套装载
// 一条路线 = 站桩/巡逻点 + 刷怪籠 + 捡东西规则 + 战利品卖给谁，所以这里不再写死馬賊营地
h.farm.stop();h.speedOn=false;/* 用户要求：禁止走路手持加速道具（浮雲連天会被服务器拉回） */h.reloadFarm();delete require.cache[require.resolve('./heuristics/home')];h.home=require('./heuristics/home')(bot,h);try{Object.assign(h.home.cfg,JSON.parse(require('fs').readFileSync(require('./paths').mem('home_cfg.json'),'utf8')))}catch(e){};await h.sleep(300);
h.combat.resetStats();h.dmg.n=0;h.dmg.total=0;h.dmg.log=[];
const PF=require('./heuristics/profiles');
const name=PF.active();
const r=h.farm.start({profile:name});
if(h.farmCombatPreset)Object.assign(h.combat.cfg,h.farmCombatPreset); // 撤离路/撤退点（bot.js）
h.combat.start({approach:false});
Object.assign(h.farm.cfg,{junk:/^$/});
if(h.loot&&h.loot.dispose)h.loot.dispose();
delete require.cache[require.resolve('./heuristics/loot')];
h.loot=require('./heuristics/loot')(bot,h,h.farm);
{const p=PF.get(name)||{};h.loot.cfg.houses=p.houses||[];if(p.lootLeash)h.loot.cfg.lootLeash=p.lootLeash;if(p.pSpawnMax!=null)h.loot.cfg.pSpawnMax=p.pSpawnMax;}
return r+' '+name;
