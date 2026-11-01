// 全图扫命令方块+告示牌+箱子物品名，按正则过滤。用法: node tools/grepcmd.js 正则 [x0 x1 z0 z1]
const fs=require('fs'),zlib=require('zlib'),nbt=require('prismarine-nbt');
const dir='C:/Users/Administrator/Desktop/vake/.server/盘灵古域/world/region/';
const re=new RegExp(process.argv[2]);const box=process.argv.slice(3).map(Number);
(async()=>{let n=0;
for(const fn of fs.readdirSync(dir)){if(!fn.endsWith('.mca'))continue;const buf=fs.readFileSync(dir+fn);if(buf.length<8192)continue;
 for(let i=0;i<1024;i++){const off=buf.readUIntBE(i*4,3)*4096;if(!off||off+5>buf.length)continue;let s;
  try{const len=buf.readUInt32BE(off);const data=zlib.inflateSync(buf.slice(off+5,off+4+len));s=nbt.simplify((await nbt.parse(data)).parsed);}catch{continue}
  for(const te of (s.Level.TileEntities||[])){
   if(box.length===4&&(te.x<box[0]||te.x>box[1]||te.z<box[2]||te.z>box[3]))continue;
   let txt='';if(te.id==='Control')txt=te.Command;else if(te.id==='Sign')txt=[te.Text1,te.Text2,te.Text3,te.Text4].join('|');else if(te.Items)txt=JSON.stringify(te.Items);else continue;
   if(re.test(txt)){console.log(`${te.x},${te.y},${te.z} ${te.id} ${txt.slice(0,+process.env.MAXLEN||400)}`);if(++n>200)return;}}}}})();
