const fs=require('fs'),zlib=require('zlib'),nbt=require('prismarine-nbt');
const dir='C:/Users/Administrator/Desktop/vake/.server/盘灵古域/world/region/';
const [x0,x1,y0,y1,z0,z1]=process.argv.slice(2).map(Number);
(async()=>{const seen=new Set();for(let cx=x0>>4;cx<=x1>>4;cx++)for(let cz=z0>>4;cz<=z1>>4;cz++){const f=dir+`r.${cx>>5}.${cz>>5}.mca`;const buf=fs.readFileSync(f);const i=(cx&31)+((cz&31)*32);const off=buf.readUIntBE(i*4,3)*4096;if(!off)continue;const len=buf.readUInt32BE(off);
const s=nbt.simplify((await nbt.parse(zlib.inflateSync(buf.slice(off+5,off+4+len)))).parsed);
for(const te of s.Level.TileEntities||[]){if(te.x<x0||te.x>x1||te.y<y0||te.y>y1||te.z<z0||te.z>z1)continue;if(!te.Items||!te.Items.length)continue;
console.log(te.x,te.y,te.z,te.id,te.Items.map(it=>it.Slot+':'+it.id+'x'+it.Count+' '+((it.tag&&it.tag.display&&it.tag.display.Name)||'').replace(/§./g,'')).join(' ; '))}}})();
