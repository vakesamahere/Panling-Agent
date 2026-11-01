const fs=require('fs'),zlib=require('zlib'),nbt=require('prismarine-nbt');
const dir='C:/Users/Administrator/Desktop/vake/.server/盘灵古域/world/region/';
(async()=>{for(const [x,z] of (process.argv[2]?JSON.parse(process.argv[2]):[[83,149]])){const f=dir+`r.${Math.floor(x/512)}.${Math.floor(z/512)}.mca`;const buf=fs.readFileSync(f);
 const i=((x>>4)&31)+(((z>>4)&31)*32);const off=buf.readUIntBE(i*4,3)*4096;const len=buf.readUInt32BE(off);const s=nbt.simplify((await nbt.parse(zlib.inflateSync(buf.slice(off+5,off+4+len)))).parsed);
 for(const te of s.Level.TileEntities)if(te.x===x&&te.z===z){const t=te.Command||JSON.stringify(te.Items);fs.writeFileSync(require('path').join(__dirname,'..','logs')+'/te_'+x+'_'+te.y+'_'+z+'.txt',t);console.log(x,z,te.y,t.length);}}})();
