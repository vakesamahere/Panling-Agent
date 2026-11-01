# mc agent（盘灵古域机器人）

```
src/
  bot.js            入口：mineflayer 连接 + HTTP 控制接口 (/eval, /events) + h.* 基础工具
  paths.js          所有目录集中在这里（memory/ logs/ data/）
  heuristics/       手写的启发式行为层（全部都在这一层）
    combat.js       射箭/躲箭/风筝
    farm.js         刷怪点循环（站位、回血、离太远回去）
    loot.js         捡东西（屋外 A / 屋内 B，刷怪间隔统计）
    home.js         死亡/补给流程：奈何桥 → 皇城买卖存 → 回刷怪点
    town.js         NPC 交易/走到 NPC
    routes.js       回放录好的路线（memory/routes_recorded.json）
    travel.js       旧的出行层：传送阵记忆 + nav 规划（已不做回退用）
    nav.js          2.5D 高度图 BFS
    navmovements.js pathfinder 的 Movements 补丁（虚空当墙、避开传送板）
    safety.js       水里上浮、传送房触发器
    chunks.js       区块记忆（可走性/怪密度）
    botrec.js       机器人自己录路线
    enderwatch.js   末影箱快照写账本
bin/                常驻进程
  server.js         本地服务端包装（控制台命令写 logs/cmd.txt）
  run_online.sh     线上号守护（掉线重连+开刷，指数退避）
  watchdog.js       线上号看门狗（死亡/卡住/报表 → Telegram）
  recorder.js       用户录路线：旁观号跟随，聊天 start-A-B / end
scripts/            手动调用
  q.sh / q2.sh      向本地号(3001)/线上号(3002) 发 JS：-f 文件（中文必须用 -f）
  st.sh go.sh wait_alert.sh
  eval/             通过 q.sh -f 发给机器人执行的片段（farm_start、suicide、naihe_plate…）
tools/              读存档的离线工具（命令方块/告示牌/刷怪笼）
memory/             持久记忆（路线、地点、区块、刷怪间隔、账本、看门狗状态）
logs/               所有日志 + cmd.txt
data/               静态数据（翻译表、皇城俯视图、商店）
docs/               NOTES.md 地图知识，PLAYBOOK.md 玩家手册
```

启动（在 agent/ 下）：
```
nohup node bin/server.js > logs/wrapper.out 2>&1 &         # 本地服
nohup node src/bot.js KiroBot > logs/bot.out 2>&1 &        # 本地号，接口 3001
nohup bin/run_online.sh > /dev/null 2>&1 &                 # 线上号，接口 3002
nohup node bin/watchdog.js > /dev/null 2>&1 &
```

## 看板控制（bin/dash.js，http://127.0.0.1:3010 ，要口令 memory/dash_key.txt）
- 上下线和刷怪分开：⏻ 下线 / 🔌 上线 只管连不连；「刷怪循环 开/关」管刷不刷，并记在 memory/autofarm.flag（重连后有它才自动开刷，号不在线时也能点）。
- ⏻ 下线 / 🔌 上线：下线并不再重连（memory/offline.flag）；上线 = 删 flag，run_online.sh 立刻重连（没暂停就自动开刷）。
- 手动控制卡：自动打怪 开/关、刷怪循环 开/关、回城补给（h.home.run）、全停、取消任务、走录好的路线（h.routes.follow）、寻路到地点名或 x y z（h.gmap.go）。
  后台任务在 h.ctlJob {what,s,r,cancel}；routes.follow / gmap.go 收 opts.abort。接口 POST /api/ctl?a=动作&v=参数&k=口令。
