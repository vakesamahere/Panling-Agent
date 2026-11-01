// 列出区域内的刷怪笼(MobSpawner)、箱子、命令方块里的 summon（怪物）
// 用法: node tools/spawns.js x0 x1 z0 z1
const fs=require('fs'),zlib=require('zlib'),nbt=require('prismarine-nbt');
const dir='C:/Users/Administrator/Desktop/vake/.server/盘灵古域/world/region/';
const [x0,x1,z0,z1]=process.argv.slice(2).map(Number);
(async()=>{const out=[];
for(let rx=Math.floor(x0/512);rx<=Math.floor(x1/512);rx++)for(let rz=Math.floor(z0/512);rz<=Math.floor(z1/512);rz++){
 const f=dir+`r.${rx}.${rz}.mca`;if(!fs.existsSync(f))continue;const buf=fs.readFileSync(f);
 for(let i=0;i<1024;i++){const off=buf.readUIntBE(i*4,3)*4096;if(!off)continue;const len=buf.readUInt32BE(off);
  const data=zlib.inflateSync(buf.slice(off+5,off+4+len));const {parsed}=await nbt.parse(data);const s=nbt.simplify(parsed);
  for(const te of (s.Level.TileEntities||[])){if(te.x<x0||te.x>x1||te.z<z0||te.z>z1)continue;
   const at=`${te.x},${te.y},${te.z}`;
   if(te.id==='MobSpawner'){const sd=te.SpawnData||{};out.push(`${at} SPAWNER ${te.EntityId} ${(sd.CustomName||'').replace(/§./g,'')} max${te.MaxNearbyEntities} r${te.RequiredPlayerRange}`);}
   else if(te.id==='Chest'||te.id==='Trap')out.push(`${at} ${te.id} items=${(te.Items||[]).length}`);
   else if(te.id==='Control'&&/summon (?!Villager)/.test(te.Command||'')){const m=te.Command.match(/summon (\w+)[^{]*(\{.*)?/);const n=(te.Command.match(/CustomName:"?([^",}]+)/)||[])[1]||'';out.push(`${at} SUMMON ${m&&m[1]} ${n.replace(/§./g,'')}`);}
  }}}
console.log(out.length);console.log(out.join('\n'));})();
