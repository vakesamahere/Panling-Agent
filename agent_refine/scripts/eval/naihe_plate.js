h.farm.stop();bot.pathfinder.stop();bot.clearControlStates();const sleep=ms=>new Promise(r=>setTimeout(r,ms));const tr=[];
const go=async(x,z,n)=>{for(let i=0;i<n;i++){const p=bot.entity.position;if(Math.hypot(p.x-x,p.z-z)<0.4||p.z>-1700)break;await bot.lookAt(new Vec3(x,p.y+1.6,z),true);bot.setControlState('forward',true);bot.setControlState('jump',i%4==3);await sleep(250);if(i%4==0)tr.push(p.x.toFixed(1)+','+p.y.toFixed(1)+','+p.z.toFixed(1))}bot.clearControlStates()};
await go(205.5,-1771.5,20);await go(205.5,-1787.5,60);await sleep(2000);
return bot.entity.position.floored()+' | '+tr.join(' ');
