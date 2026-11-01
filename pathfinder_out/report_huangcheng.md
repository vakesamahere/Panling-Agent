# 皇城 walkability graph v0 — validation report

Box x 0..300, z -300..300 (all y). RULES_VERSION 2. Level 0 only.

## Counts

- standable cells: **325537** (ground 313992, water_still 10824, water_flow 475, ladder-only 246, with door 404)
- edges inside box: **1807036**; edges leaving box (stored separately): 4449
- edges by type: walk 1600824, jump 50733, drop 74968, swim 74778, water_enter 3207, water_exit 2068, ladder_climb 360, ladder_exit 98
- water-exit edges: flush rule (land ≤ conservative surface + 1/16): 133; step rule (land ≤ surface + 0.5): 2118. **Used: step rule** (exit_step=8/16). Note the conservative surface of a source block is y+14/16 (8/9 rounded down), so ordinary land flush with the water block top is +2/16 above it and the flush rule rejects nearly every exit; in-game you can exit onto a block a full 1.0 above the water block top when holding jump, so ≤0.5 is still conservative.
- weak components: 2516; largest weak: 202223 cells (62.1%)
- strong components: 5397; largest strong (mutually reachable): 144972 cells (44.5%)
- land floors skipped because body would be in water: 12275
- unsure_floor (would be floor but shape untrusted; excluded): 990

### unsure_floor counts by id:meta (candidates for whitelisting)

- `140:2 flower_pot`: 337
- `140:0 flower_pot`: 170
- `118:0 cauldron`: 125
- `140:1 flower_pot`: 97
- `118:3 cauldron`: 57
- `140:6 flower_pot`: 34
- `140:5 flower_pot`: 29
- `140:3 flower_pot`: 21
- `140:11 flower_pot`: 17
- `144:1 skull`: 17
- `154:0 hopper`: 15
- `140:8 flower_pot`: 10
- `140:9 flower_pot`: 9
- `144:2 skull`: 9
- `140:4 flower_pot`: 7
- `154:4 hopper`: 7
- `140:10 flower_pot`: 6
- `144:3 skull`: 6
- `118:2 cauldron`: 3
- `154:3 hopper`: 3
- `118:1 cauldron`: 2
- `140:7 flower_pot`: 2
- `154:2 hopper`: 2
- `154:5 hopper`: 2
- `29:12 sticky_piston`: 1
- `34:12 piston_head`: 1
- `145:2 anvil`: 1

Features: doors 747 blocks, ladders 296, pressure plates 534, portals 0 (see features_huangcheng.json).

## Recorded routes vs graph

- route points inside box: 680; snapped (≤1.0 horiz, ≤1.5 vert): **680 (100.0%)**
- consecutive snapped pairs (different cells): 664; same weak component: 664 (100.0%); graph-reachable in the recorded direction: 664 (100.0%)
- graph shortest path / recorded straight-segment length: median 1.03, p90 1.24, max 26.96
- worst detour segments (graph/recorded): 南北雜貨批發->錢莊 (33,47.00,166)->(33,46.50,164) 29.7/1.1; 礦物收購商->錢莊 (33,47.00,166)->(33,46.50,164) 29.7/1.1; 熟食小販->南北雜貨批發 (103,46.00,181)->(102,46.00,182) 1.4/0.8; 南北雜貨批發->熟食小販 (102,46.00,182)->(103,46.00,181) 1.4/0.8; 皇城南门->元素回收員 (260,47.00,50)->(261,48.00,48) 3.0/1.9

### Whole in-box route runs (first→last snapped point)

| route | pts | recorded len | graph len | ratio |
|---|---|---|---|---|
| 人族出生点->皇城南门 | 61 | 169.8 | 167.4 | 0.99 |
| 皇城南门->双房 | 48 | 133.9 | 137.8 | 1.03 |
| 双房->皇城南门 | 49 | 135.2 | 135.4 | 1.00 |
| 皇城南门->皇城炼丹房 | 74 | 207.2 | 187.4 | 0.90 |
| 皇城南门->熟食小販 | 14 | 33.5 | 33.5 | 1.00 |
| 熟食小販->皇城南门 | 14 | 33.5 | 33.5 | 1.00 |
| 熟食小販->南北雜貨批發 | 20 | 51.1 | 46.4 | 0.91 |
| 南北雜貨批發->熟食小販 | 20 | 51.1 | 46.4 | 0.91 |
| 南北雜貨批發->錢莊 | 34 | 83.1 | 88.0 | 1.06 |
| 錢莊->南北雜貨批發 | 33 | 82.0 | 75.6 | 0.92 |
| 南北雜貨批發->礦物收購商 | 30 | 77.9 | 71.8 | 0.92 |
| 礦物收購商->南北雜貨批發 | 30 | 77.9 | 71.8 | 0.92 |
| 錢莊->礦物收購商 | 48 | 121.0 | 91.2 | 0.75 |
| 礦物收購商->錢莊 | 49 | 122.1 | 85.2 | 0.70 |
| 皇城南门->元素回收員 | 78 | 208.6 | 188.3 | 0.90 |
| 元素回收員->皇城南门 | 78 | 208.6 | 188.9 | 0.91 |

## Unreachable consecutive segments (0)

Columns listed bottom→top from floor-1 to floor+2 as `y:name[:meta]`.


## PNGs
- top_huangcheng.png: 3 px/block, north up (z grows downward), x to the right. green shades = ground (by height, 33..100), blue = still water, light blue = flowing water, gray = blocks but no standable cell, black = void/air column. Red = recorded routes, yellow dots = pressure plates.
- components_huangcheng.png: green = column has a cell in the largest strongly connected component, orange = standable but only in other components.

## Runtime

- slurm job 3192088 (sbatch -p amd, -c 4): extract step wall 12.3 s, report step see log; per-step wall/max RSS from /usr/bin/time -v in logs/pf_box_3192088.out
- extrapolation to whole map (120 regions × 262144 columns = 31.5M columns, 174× this box): per region ≈ 18 s extract, ≈ 1.3 GB RSS, ≈ 0.5M cells / 3M edges if density similar (sparser terrain → less). Serial ≈ 36 min; as a 120-task job array (`sbatch --array=0-119 run_box.slurm region`) ≈ 1 min wall + queue time. Output ≈ 6 MB/region npz.
