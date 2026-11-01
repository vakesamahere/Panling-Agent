# 皇城 v2 report (RULES_VERSION 4: doors / trapdoors / fence gates)

## Rule changes
- Wooden doors use the 1.8 BlockDoor box: a 3/16 thin wall on one face, from facing (lower meta&3), open (lower meta&4) and hinge (upper meta&1). A cardinal move is blocked if either column has a wall on the crossed face anywhere in [min floor, max floor+1.8). Walls parallel to the move do not block.
- If the saved state blocks the crossing but one click would clear it: edge `door_open` (type 9, cost +3, e_door -> door_xyz block to right-click). If the door blocks in both states, or two doors would need clicking: no edge. Doors that do not block the crossing: plain walk, no extra cost (v1 charged +2 for any door cell).
- Leaving a door cell through a face that the door would block after a click: no edge (the door state after entering is unknown).
- Trapdoors (1.8 BlockTrapDoor: meta&3 facing, &4 open, &8 top half): closed bottom = floor 3/16; closed top = box 13/16..1 (floor 1.0, blocks the head); open = thin wall on one face, fixed (the bot does not click trapdoors), not a floor.
- Fence gates: closed = 1.5-high wall; a walk into its column = `gate_open` (type 10, cost +3, block in door_xyz); open = no collision.
- Diagonal moves are forbidden if any of the 4 columns involved has a door, trapdoor side wall or closed gate in the body range. This is what fixes the failed bot move at (260,48,48).
- Iron door / iron trapdoor: wall (unchanged).

## Numbers
- cells 326318 (v1 326287); internal edges 1808898 (v1 1810267); boundary 4457
- edges by type (extract, before traps/teleports): walk 1601447 (v1 1602960), jump 51014 (v1 51045), drop 75603 (v1 75751), swim 74774 (v1 74778), water_enter 3196 (v1 3207), water_exit 2064 (v1 2068), ladder_climb 360 (v1 360), ladder_exit 98 (v1 98), teleport 0 (v1 0), door_open 44 (v1 0), gate_open 298 (v1 0)
- after teleport/trap pass: door_open 44, gate_open 298, teleport 52; distinct clickable door/gate blocks 130
- clickable blocks by kind: fence_gate 106, wooden_door 12, acacia_door 4, birch_door 4, dark_oak_fence_gate 2, dark_oak_door 2
- unsure floors 219; teleports 52 in-box + 11 cross-box; trap cells 9
- slurm job 3192453: see the timing line at the end.

## Re-check of v1 door edges
- v1 used a `door` move only at (260,48,48) in 元素回收員→人皇 and 元素回收員→錢莊. The path went (256.5,48,43.5) → (260.5,48,47.5) → (260.5,48,48.5) → (260.5,48,49.5) → (260.5,47,50.5) → drop (259.5,44,50.5).
- Blocks: (260,48,48) trapdoor meta 7 = open, facing E → wall at x 0..3/16 (the -x face); (259,48,47) trapdoor meta 4 = open N → wall z 13/16..1; (259,48,49) trapdoor meta 5 = open S → wall z 0..3/16. In v1 all open trapdoors had no collision, so the bot was routed diagonally past the boards; the server rejected that ("moved wrongly").
- v2: the (260,48,47)→(260,48,48)→(260,48,49) line runs parallel to the board at (260,48,48) and stays legal as plain walk; the diagonals next to the trapdoors are gone, and (259,48,48)-(260,48,48) crossing is blocked.

## Test set v2 (A*, flagged teleports off)

| from | to | reach | len (v1) | kinds | door clicks | expanded | ms |
|---|---|---|---|---|---|---|---|
| 南门 | 錢莊掌櫃 | yes | 163.8 (163.8) | walk 151 | - | 35433 | 536 |
| 南门 | 元素回收員 | yes | 202.5 (203.9) | walk 171, drop 2, jump 2 | - | 10342 | 164 |
| 南门 | 人皇-軒轅氏 | yes | 358.7 (358.7) | walk 347 | - | 89401 | 1359 |
| 錢莊掌櫃 | 南门 | yes | 164.4 (164.4) | walk 149, drop 2 | - | 12933 | 185 |
| 錢莊掌櫃 | 元素回收員 | yes | 316.8 (319.0) | walk 268, drop 6, jump 3 | - | 27979 | 432 |
| 錢莊掌櫃 | 人皇-軒轅氏 | yes | 437.0 (437.0) | walk 388, drop 4, jump 2 | - | 97669 | 1473 |
| 元素回收員 | 南门 | yes | 202.3 (203.7) | walk 173, jump 1, drop 1 | - | 25108 | 369 |
| 元素回收員 | 錢莊掌櫃 | yes | 316.0 (316.0) | walk 271, drop 3, jump 2 | - | 70744 | 1054 |
| 元素回收員 | 人皇-軒轅氏 | yes | 320.3 (320.3) | walk 293, drop 3 | - | 46995 | 693 |
| 人皇-軒轅氏 | 南门 | yes | 358.7 (358.7) | walk 346, drop 1 | - | 82751 | 1253 |
| 人皇-軒轅氏 | 錢莊掌櫃 | yes | 437.1 (437.1) | walk 390, drop 3, jump 2 | - | 111335 | 1634 |
| 人皇-軒轅氏 | 元素回收員 | yes | 321.4 (323.6) | walk 293, drop 2, jump 3 | - | 39212 | 621 |

Waypoint JSONs (out/testset_v2/<from>__<to>.json): `points` = compressed waypoints, `cells` = every path cell. Each entry has x,z (cell centre), y (floor height), act (start/walk/jump/drop/swim/ladder/teleport/door/end), fb (floor block name), kind (walk/jump/... or door_open/gate_open); door entries add bx,by,bz (block to right-click), block, meta (saved state).
- timing, job 3192453 (amd, -c 4): extract 26.1 s wall / 1.36 GB peak (graph 11.7 s, of which numba compile is most); teleports 4.0 s / 0.44 GB; report 10.5 s / 1.26 GB; testset 14.6 s / 0.37 GB. Route validation (report_huangcheng_v2.md): 680/680 points snap, 664/664 pairs reachable, median ratio 1.03, 0 unreachable segments.
