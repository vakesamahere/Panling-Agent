h.combat&&h.combat.stop();h.farm.stop();bot.pathfinder.stop();bot.clearControlStates();
const it=bot.inventory.items().find(i=>i.name==='potion'&&i.metadata===8234);
if(!it)return 'no potion';
const dead=new Promise(r=>{bot.once('death',()=>r('dead'));setTimeout(()=>r('timeout'),12000)});
let err='';
try{await bot.equip(it,'hand');}catch(e){err+='equip:'+e.message}
try{await bot.consume();}catch(e){err+=' consume:'+e.message}
const r=await dead;
return [r,err,bot.heldItem&&bot.heldItem.name,Math.round(bot.health)].join(' ');
