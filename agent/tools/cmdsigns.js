const fs=require('fs'),zlib=require('zlib'),nbt=require('prismarine-nbt');
const dir='C:/Users/Administrator/Desktop/vake/.server/盘灵古域/world/region/';
const [x0,x1,z0,z1]=process.argv.slice(2).map(Number);
(async()=>{const out=[];
for(let rx=Math.floor(x0/512);rx<=Math.floor(x1/512);rx++)for(let rz=Math.floor(z0/512);rz<=Math.floor(z1/512);rz++){
 const f=dir+`r.${rx}.${rz}.mca`;if(!fs.existsSync(f))continue;const buf=fs.readFileSync(f);
 for(let i=0;i<1024;i++){const off=buf.readUIntBE(i*4,3)*4096;if(!off)continue;const len=buf.readUInt32BE(off);
  const data=zlib.inflateSync(buf.slice(off+5,off+4+len));const {parsed}=await nbt.parse(data);const s=nbt.simplify(parsed);
  for(const te of (s.Level.TileEntities||[])){const isS=te.id==='Sign';if(te.id!=='Control'&&!isS)continue;if(te.x<x0||te.x>x1||te.z<z0||te.z>z1)continue;
   out.push(`${te.x},${te.y},${te.z} `+(isS?"SIGN "+[te.Text1,te.Text2,te.Text3,te.Text4].map(t=>{try{const j=JSON.parse(t);if(typeof j==="string")return j;return (j.text||"")+(j.extra||[]).map(e=>e.text||e).join("")}catch{return t}}).join("|"):te.Command));}}}
console.log(out.length);console.log(out.join('\n'));})();
