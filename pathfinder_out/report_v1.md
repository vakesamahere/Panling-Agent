# 皇城 v1 report (RULES_VERSION 3)

## Numbers
- cells 326287 (v0 325537; +750 from flower-pot floors; unsure floors 990 -> 251); internal walk/jump/drop/... edges 1810267
- teleport edges: 52 in-box + 11 cross-box (target outside box, in x_* list); 19 flagged with selector conditions (score_*, m=) and skipped by the query by default; from 25 command blocks/memory portals
- tp command blocks not attached to any plate/button (no edge): 27 (selector r=0 = exact-position loops in 錢莊 basement x42 z159-174, plate >4.5 away, quest areas)
- bans: [205, 54, -1753] 抹除存在 (erase existence = delete save) (0 cell in box); [220, 49, 43] 蜀山 teleport plate (1 cell in box)
- trap/forbidden cells: 9
- job 3192169 (amd, -c 4): extract 6.7 s wall / 0.86 GB; teleports 3.7 s / 0.42 GB; report 13.0 s / 1.26 GB; total 24 s. Test-set job 3192170: 15.6 s / 0.36 GB (graph load 3.0 s).
- route validation unchanged: 680/680 points snap, 664/664 pairs reachable, median ratio 1.03.

## Test set (A*, flagged teleports off, goal = cells within 2 blocks horizontally, ±1 block in height)

| from | to | reach | len | kinds | expanded | ms | max y | leaves | over-lower-floor cells | recorded |
|---|---|---|---|---|---|---|---|---|---|---|
| 南门 | 錢莊掌櫃 | yes | 163.8 | walk 151 | 35436 | 654 | 47.0 | 0 | 20 | 167.7 |
| 南门 | 元素回收員 | yes | 203.9 | walk 173, drop 2, jump 1 | 10482 | 200 | 48.0 | 0 | 50 | 208.6 |
| 南门 | 人皇-軒轅氏 | yes | 358.7 | walk 347 | 89501 | 1622 | 67.0 | 0 | 195 | - |
| 錢莊掌櫃 | 南门 | yes | 164.4 | walk 149, drop 2 | 12938 | 195 | 47.5 | 0 | 23 | 166.6 |
| 錢莊掌櫃 | 元素回收員 | yes | 319.0 | walk 270, drop 6, jump 2 | 28212 | 476 | 48.0 | 0 | 28 | - |
| 錢莊掌櫃 | 人皇-軒轅氏 | yes | 437.0 | walk 388, drop 4, jump 2 | 97787 | 1832 | 67.0 | 0 | 186 | - |
| 元素回收員 | 南门 | yes | 203.7 | walk 174, jump 1, drop 1 | 24989 | 440 | 48.0 | 0 | 52 | 208.6 |
| 元素回收員 | 錢莊掌櫃 | yes | 316.0 | walk 270, door 1, drop 3, jump 2 | 70896 | 1264 | 48.0 | 0 | 18 | - |
| 元素回收員 | 人皇-軒轅氏 | yes | 320.3 | walk 292, door 1, drop 3 | 47059 | 845 | 67.0 | 0 | 191 | - |
| 人皇-軒轅氏 | 南门 | yes | 358.7 | walk 346, drop 1 | 82746 | 1519 | 68.0 | 0 | 246 | - |
| 人皇-軒轅氏 | 錢莊掌櫃 | yes | 437.1 | walk 390, drop 3, jump 2 | 111291 | 1968 | 68.0 | 0 | 188 | - |
| 人皇-軒轅氏 | 元素回收員 | yes | 323.6 | walk 295, drop 2, jump 2 | 39380 | 737 | 68.0 | 0 | 192 | - |

"over-lower-floor" counts path cells whose column has another standable floor ≥2 blocks lower: under eaves, bridges, in buildings with a basement, or on the palace terraces. It is not proof of roof walking. No path uses leaves.

## Traps / palace investigation
- The 內帑 trap is the trapped_chest at (181,66,-166) behind the throne. Opening it powers a redstone net into command blocks (181,64,-164), which tellraws "大膽刁民，敢偷朕的內帑！拖下去，斬！". (181,64,-162) broadcasts 皇城公告, and (182,64,-162) runs `effect @p[181,67,-165,r=30] 7 2 100` = instant damage 100 = death. It also runs (181,63,-167) `blockdata 177 67 -168 {SuccessCount:0}` and (177,67,-168) `testforblock` latches.
- Walking does not trigger it. Only opening the chest does. The cell on top of the chest is not standable anyway. Rule for the executor: never right-click the trapped chest (block id 146) at (181,66,-166).
- The light plate (179,68,-166) under 人皇-軒轅氏 is on the same net. It reaches the summon/clear blocks (178,63,-164) `/summon Villager 179 68 -166 人皇-軒轅氏` and (178,63,-165) `tp @e[type=Villager,r=8] ~ -1000 ~`. Flood-fill also reaches the tellraw/effect blocks, but this may be over-connection through the shared block net. I marked it `trap` (forbidden) to be safe, so the test goal for 人皇 is an adjacent cell.
- The dense patch in the central hall is 279 heavy_weighted_pressure_plates at y=46. They are floor decoration over redstone lamps at y=45. The redstone flood from every hall plate reaches no command block (only lamps), so they are harmless and stay walkable.
- NPC respawn pads: 8 plates under palace NPCs (李公公 172,66,-158; 羽羅 185,66,-158; 4 skeleton-archer guard posts 171/187,66,-140/-132; 2 酒保 at 196,54,-149/-142) wire to `/summon` + `tp @e[type=…] ~ -1000 ~`. Stepping on one respawns the NPC or archer. Archers come with bow Power 15, so this is dangerous. I marked these cells forbidden (`trap`).

## Suspicious
- (170,47,159)/(173,47,159-160) near 南门: one plate drives 4 tp blocks. One is unconditional to (175,48,160); others are conditional to y=13 underground (flagged). Check in game which fires.
- 錢莊 basement (x42 z159-174, 54,40,144/152): many buttons tp back and forth (54,40,146)/(53,41,155). These look like a small puzzle or loop. The edges are real but short.
- (170,12,134/135)→(175,48,160) and (56,4..7,31..32)↔(56,48,34) are underground ↔ surface lifts; not used by the test set.
- Ban (205,54,-1753) is outside the box (0 cells). The ban is applied whenever that region is built.
- Teleport source cells use the plate cell. Buttons create an edge from every standable cell within 1 block horizontally of the button, a guess at where the player stands to press it.
