const b=JSON.parse(require('fs').readFileSync(require('./paths').mem('stat_baseline.json'),'utf8'));
const m={};for(const i of bot.inventory.items()){const k=i.customName?i.customName.replace(/§./g,""):i.name+(i.name==='skull'?':'+i.metadata:'');m[k]=(m[k]||0)+i.count}
const d={};for(const k of new Set([...Object.keys(m),...Object.keys(b.inv)])){const x=(m[k]||0)-(b.inv[k]||0);if(x)d[k]=x}
const c=h.combat.state();
return JSON.stringify({now:new Date().toString().slice(16,24),min:Math.round((Date.now()-new Date(b.t))/60000),pos:bot.entity.position.floored().toString(),hp:Math.round(bot.health),farm:h.farm.state().on,kills:c.kills-b.kills,deaths:c.deaths,d,home:h.home.st.log.slice(-4)});
