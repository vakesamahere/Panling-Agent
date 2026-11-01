if(!h._dt){const T=h._dt={seen:{},got:0,gone:0,other:0,t0:Date.now()};
 const isDrop=e=>e&&e.type==='object'&&/^item$/i.test(e.name||'');
 const near=e=>Math.hypot(e.position.x+164,e.position.z-673)<25;
 bot.on('entitySpawn',e=>{if(isDrop(e)&&near(e))T.seen[e.id]={t:Date.now(),p:e.position.floored().toString()}});
 bot.on('playerCollect',(c,e)=>{if(T.seen[e.id]){if(c===bot.entity)T.got++;else T.other++;T.seen[e.id].done=1}});
 bot.on('entityGone',e=>{const s=T.seen[e.id];if(s&&!s.done){s.done=2;T.gone++;s.age=Math.round((Date.now()-s.t)/1000)}});}
const T=h._dt,open=Object.values(T.seen).filter(s=>!s.done),gone=Object.values(T.seen).filter(s=>s.done===2);
const ground=Object.values(bot.entities).filter(e=>e.type==='object'&&/^item$/i.test(e.name||'')&&Math.hypot(e.position.x+164,e.position.z-673)<25).map(e=>e.position.floored().toString()+(h.loot.houseOf(e.position)?'屋':''));
return JSON.stringify({min:Math.round((Date.now()-T.t0)/60000),seen:Object.keys(T.seen).length,got:T.got,other:T.other,goneNotPicked:T.gone,goneAges:gone.slice(-8).map(s=>s.age+'s@'+s.p),onGround:ground.length,ground:ground.slice(0,15),loot:h.loot.stats.outOk+'/'+h.loot.stats.outTrips+' B'+h.loot.stats.inOk+'/'+h.loot.stats.inTrips});
