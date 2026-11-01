// usage: node tools/tedump.js x y z  -> prints full TE text (Command or JSON)
const fs=require('fs'),zlib=require('zlib'),nbt=require('prismarine-nbt');
const dir='C:/Users/Administrator/Desktop/vake/.server/盘灵古域/world/region/';
const [x,y,z]=process.argv.slice(2).map(Number);
(async()=>{const f=dir+`r.${Math.floor(x/512)}.${Math.floor(z/512)}.mca`;const buf=fs.readFileSync(f);
const i=((x>>4)&31)+(((z>>4)&31)*32);const off=buf.readUIntBE(i*4,3)*4096;const len=buf.readUInt32BE(off);
const s=nbt.simplify((await nbt.parse(zlib.inflateSync(buf.slice(off+5,off+4+len)))).parsed);
for(const te of s.Level.TileEntities)if(te.x===x&&te.z===z&&(isNaN(y)||te.y===y))console.log(te.y,te.id,te.Command||JSON.stringify(te));})();
