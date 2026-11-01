// 打印箱子里物品的完整 NBT（JSON），用于本地复制
const fs=require('fs'),zlib=require('zlib'),nbt=require('prismarine-nbt');
const dir='C:/Users/Administrator/Desktop/vake/.server/盘灵古域/world/region/';
const pts=JSON.parse(process.argv[2]);
(async()=>{const out=[];for(const [x,y,z] of pts){const f=dir+`r.${x>>9}.${z>>9}.mca`;const buf=fs.readFileSync(f);const i=((x>>4)&31)+(((z>>4)&31)*32);const off=buf.readUIntBE(i*4,3)*4096;const len=buf.readUInt32BE(off);
const raw=(await nbt.parse(zlib.inflateSync(buf.slice(off+5,off+4+len)))).parsed;
for(const te of raw.value.Level.value.TileEntities.value.value){if(te.x.value===x&&te.y.value===y&&te.z.value===z)for(const it of te.Items.value.value)out.push({id:it.id.value,Damage:it.Damage?it.Damage.value:0,tag:it.tag});}}
console.log(JSON.stringify(out));})();
