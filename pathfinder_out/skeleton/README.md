# skeleton: L1 road network from the PFG3 cell graph (offline prototype)

Pure Node.js (tested on v24.22.1), no npm dependencies. Reads `../node/graph.js` data (`../node/data/`), writes only into this directory.

```
node --max-old-space-size=2000 run.js <x0> <z0> <x1> <z1> [name] [--key=value ...]
# 皇城
node run.js 0 -200 300 220 huangcheng "--seeds=179,47,183;33,47,163;256,48,34;179,68,-166"
# 人族村
node run.js 1570 60 1770 210 renzu_village "--seeds=1686,143,107;1598,132,123;1600,140,112;1739,160,95;1654,153,174;1625,136,100;1689,140,138;1663,181,184;1677,134,141"
```

Any key of `DEFAULTS` in `skeleton.js` can be overridden with `--key=value`; `--scale=N` sets pixels per block (default 3).

## Files

| file | content |
|---|---|
| `skeleton.js` | algorithm; exports `run, loadBox, reachFilter, buildPlanar, clearance, thin, prune, breakCycles, forcedNodes, plazas, buildGraph, render, encodePNG, DEFAULTS` |
| `run.js` | CLI; writes the three files below |
| `out/<name>_graph.json` | `{name, box, opts, stats, nodes, edges}` |
| `out/<name>_stats.json` | stats and timings only |
| `out/<name>.png` | top view, 3 px per block |
| `out/huangcheng.*`, `out/renzu_village.*` | default parameters |
| `out/renzu_village_oneway.*` | village with `--oneway=true` (see problems) |

Node: `{id, kind: junction|end|forced|plaza|isolated, tags: [teleport|door|gate|ladder], pos: [x,y,z], radius: d, cells, deg}`.
Edge: `{a, b, kind: road|teleport|ladder, length, width_min (=min 2d), cells, polyline: [[x,y,z],...] every 4 cells plus both ends}`.

PNG legend: green ramp = clearance (dark at the wall, light in the middle), blue ramp = water cells, black = no reachable cell. Red = skeleton on the top cell of the column, purple = skeleton only on a lower level of that column. Yellow dot = junction, blue dot = end, cyan = forced node (door/teleport/ladder), orange ring = plaza node.

## Algorithm

Everything runs on graph edges; xz coordinates are only used to know the direction of an edge (dx, dz ∈ {-1,0,1}).

0. **Load** the regions covering the box plus `pad`=24 blocks (so the box edge is not a fake wall). Trap cells are dropped.
   **Reach filter** (my addition, `reach`): keep only cells in the strongly connected component(s) of the seed points, using all edge types (forward BFS ∩ backward BFS). Without seeds the largest SCC is kept. This removes roof tops, wall tops and closed yards that are cells in the graph but not part of the walkable town; in 皇城 it removes 158469 of 307437 cells.
1. **Planar adjacency**: edge types `walk, jump, drop, swim, door_open, gate_open` with |dx|,|dz| ≤ 1. An edge counts only if the reverse edge v→u of a planar type also exists. In the data a bidirectional step is either walk/walk, swim/swim, or jump one way + drop back. One-way edges (mostly drop off ledges) are left out. Teleport / ladder / door / gate edges are collected separately.
2. **Boundary**: a cell is boundary if one of the 4 cardinal directions has no planar edge (`borderDiag=false`). Diagonals are ignored by default because diagonal moves are forbidden by the builder near doors, gates and wall corners, which would turn whole corridors into boundary.
3. **Clearance**: multi-source Dijkstra from the boundary cells (boundary d=0.5), cost 1 straight, √2 diagonal.
4. **Thinning**: one global min-heap on d. A cell is a candidate only while it is a *border* cell of the current skeleton (it has a cardinal direction without an alive neighbour), so peeling goes layer by layer from the outside. A cell is deleted if
   - (a) endpoint rule (`endpoint=anchor`): cells with ≤1 skeleton neighbour are peeled too, unless their d is a local maximum among their neighbours (those are real ridge ends). `endpoint=deg` never deletes a cell with ≤1 neighbour (the literal rule from the task);
   - (b) simple-point test: its alive neighbours stay connected using only the edges among them, checked with a tiny union-find (≤8 neighbours). With `corners=true` two neighbours also count as connected through an alive cell in c's 3×3 window that is not an edge-neighbour of c but has edges to both. Without this, 4-connected patches on stairs and slopes (no diagonal edges there) cannot be thinned at all.
   A one-cell ring can never be cut because removing a ring cell would disconnect its two neighbours.
5. **Clean-up**: drop skeleton components < `minComp`=10 cells. **Prune** spurs: an end-to-junction branch shorter than `max(pMin=4, pK=2 · r_junction)` is removed; repeat until stable (≤20 rounds).
6. **Break short cycles** (my addition, `cycles`): around poles, trees, lamps and 1-block pillars the skeleton forms small rings. A cycle shorter than `max(cycleMin=16, cycleK=4 · r)` gets its narrowest edge removed; ≤10 rounds, then prune again.
7. **Graph**: skeleton cells with degree ≠ 2 are clustered (adjacent ones merged) into nodes; chains of degree-2 cells become edges with polyline. Nodes that end up with exactly 2 roads and no tag are merged away (re-merging after pruning).
8. **Plazas**: connected sets of cells with d ≥ `plazaD`=6 and ≥ `plazaMin`=40 cells collapse all skeleton nodes inside into one plaza node.
9. **Forced nodes**: endpoints of teleport, door_open, gate_open edges and ladder components become nodes, linked to the nearest skeleton cell by a multi-source BFS over planar edges (the link cells are added to the skeleton). Teleport and ladder edges are output as special edges.

## Results (real runs, default parameters)

| | 皇城 `0 -200 300 220` | 人族村 `1570 60 1770 210` | 人族村 `--oneway=true` |
|---|---|---|---|
| regions | r.-1.-1, r.-1.0, r.0.-1, r.0.0 | r.3.0 | r.3.0 |
| cells loaded (box+pad) | 307437 | 87978 | 87978 |
| kept by reach filter | 148968 | 56097 | 56097 |
| planar edges (undirected) | 431253 | 110367 | 125306 |
| one-way planar edges skipped | 11024 (drop 10960) | 14939 (drop 14816) | 0 (29878 directed added) |
| boundary cells | 50410 | 30601 | 14296 |
| max d | 36.5 | 13.5 | 33.5 |
| skeleton after thinning | 45014 | 29348 | 13754 |
| skeleton after prune/cycles | 33809 | 22644 | 11409 |
| spurs pruned / cycle edges cut | 1078+145 / 1862 | 598+36 / 1062 | 346+7 / 135 |
| nodes (junction / end / forced / plaza) | 1878 (1460 / 368 / 21 / 28) | 1528 (854 / 610 / 56 / 6) | 869 (618 / 187 / 58 / 6) |
| edges (road / teleport / ladder) | 2445 (2416 / 13 / 16) | 1733 (1722 / 9 / 2) | 1049 (1037 / 9 / 3) |
| road length total (blocks) | 24670.8 | 17337.6 | 11537.1 |
| door/gate/teleport endpoints linked | 385 (2 unlinked) | 355 (1 unlinked) | 357 (0) |
| RSS | 367 MB | 138 MB | 129 MB |

Timings (ms):

| step | 皇城 | 人族村 | 人族村 oneway |
|---|---|---|---|
| load | 228 | 20 | 22 |
| reach | 78 | 36 | 31 |
| planar | 52 | 23 | 42 |
| clearance | 55 | 16 | 17 |
| thin | 148 | 45 | 47 |
| prune + cycles | 267 | 153 | 59 |
| forced | 8 | 5 | 5 |
| graph | 10 | 7 | 4 |
| plaza + output | 22 | 18 | 15 |
| png | 170 | 82 | 58 |
| total | 1056 | 415 | 306 |

### Parameter experiments on 皇城 (same seeds)

| variant | cells | boundary | thin skel | final skel | nodes | junction | end | roads | road len | ms |
|---|---|---|---|---|---|---|---|---|---|---|
| default | 148968 | 50410 | 45014 | 33809 | 1878 | 1460 | 368 | 2416 | 24670.8 | 1094 |
| `--borderDiag=true` | 148968 | 94697 | 50579 | 41393 | 2602 | 1868 | 701 | 3278 | 31349.6 | 1171 |
| `--endpoint=deg` | 148968 | 50410 | 48372 | 34727 | 1899 | 1440 | 408 | 2398 | 24284.7 | 1111 |
| `--corners=false` | 148968 | 50410 | 79247 | 70118 | 765 | 420 | 232 | 911 | 11142.3 | 1190 |
| `--cycles=false` | 148968 | 50410 | 45014 | 41295 | 2886 | 2537 | 299 | 4475 | 29872.3 | 945 |
| `--cycleK=6` | 148968 | 50410 | 45014 | 31389 | 1465 | 1020 | 396 | 1748 | 22218.1 | 1052 |
| `--pK=3` | 148968 | 50410 | 45014 | 32543 | 1707 | 1389 | 267 | 2252 | 24015.7 | 1050 |
| `--reach=false` | 307437 | 115958 | 94949 | 64323 | 3776 | 2321 | 1293 | 4311 | 51296.7 | 1383 |
| `--oneway=true` | 148968 | 38345 | 37342 | 30789 | 1880 | 1607 | 220 | 2620 | 25216.7 | 1029 |

- `borderDiag=true` nearly doubles the boundary (diagonals are missing next to every door, fence and corner) and adds 37% more nodes. Kept off.
- `endpoint=deg` (never peel ends) keeps 3358 more cells after thinning, mostly short hairs; pruning removes most of them, so the final graph is similar. `anchor` is the default because it does less work for pruning.
- `corners=false` leaves 70118 skeleton cells as thick blocks (few nodes only because blocks are not counted as chains). `corners=true` is required.
- `cycles=false` gives 2537 junctions; most are small rings around pillars and trees.
- `reach=false` doubles everything because roofs and wall tops get their own skeleton.

## Problems found and multi-level handling

- **Multi-level columns.** Cells are graph nodes, so a bridge over a street or a floor above a shop is handled naturally: its cells have their own edges and get their own clearance and skeleton. 皇城 box: 103555 xz columns with cells, 10328 with ≥2 levels (max 6); 6718 skeleton cells sit in multi-level columns and 1183 columns have skeleton on 2+ levels. 人族村: 26527 columns, 10896 multi-level, 2021 with skeleton on 2+ levels. The PNG only shows the top cell; skeleton below the top cell is drawn purple, so interiors under roofs look like purple tangles.
- **Roofs and wall tops** produced a lot of skeleton noise in the first runs. The SCC reach filter from seed points fixed this. It needs good seeds; without seeds it keeps the largest SCC.
- **Stairs and slopes** only have cardinal edges, so the plain simple-point test cannot thin them. Fixed by the corner rule.
- **Terraced terrain (人族村).** The village is on a hillside. Many downhill steps are only `drop` edges with no `jump` back (height difference > 1 block), so they are one-way and, by the spec, not planar. Every terrace edge becomes a boundary, roads on slopes become 1–3 cells wide strips, and the default skeleton is thick red blobs (the PNG `out/renzu_village.png` shows this). With `--oneway=true` (one-way planar edges added as undirected adjacency for skeleton purposes only) boundary falls from 30601 to 14296 cells and the skeleton from 22644 to 11409 cells; `out/renzu_village_oneway.png` follows the streets much better. Navigation still must respect direction; a road edge built on one-way steps would need a direction flag (not implemented).
- **Small obstacles** (lamps, trees, 1-block pillars) make rings; handled by cycle breaking, but a ring around a real block (a building) shorter than `max(16, 4r)` is also cut. On 皇城 this looks correct; in narrow lanes around small houses it can cut a real alternative route.
- 2 (皇城) / 1 (村) door/teleport endpoints could not be linked: they have no planar path to any skeleton cell inside the loaded area.

## Parameters (DEFAULTS in `skeleton.js`)

`pad 24, planarTypes [walk,jump,drop,swim,door_open,gate_open], borderDiag false, endpoint 'anchor', pruneRule 'junction', pMin 4, pK 2, minComp 10, selfLoopMin 8, plazaD 6, plazaMin 40, plaza true, corners true, polyStep 4, reach true, seeds null, cycles true, cycleMin 16, cycleK 4, oneway false`.

## Known defects

- Dense building interiors (shops, the palace) still give many short edges and junctions; one room often has 3–6 nodes. Interiors would be better handled as plaza/room nodes connected by their doors.
- Junction count is high relative to real intersections (皇城 1460). Many are T-joints where a 1–2 block side opening (doorway, alcove) meets a street.
- Width at a wall made of one-way drop edges is underestimated (default mode), so `width_min` on hillside roads is too small.
- Plaza merging uses only d ≥ 6; a long wide avenue becomes one huge "plaza" if it is wide enough.
- Road edges are undirected; one-way information is lost.
- Only edges touching the box are written; the pad area is computed but not output, so roads are cut at the box border.
- PNG shows only the top cell per column.

---

# v2: building / grove / plaza regions

Files: `mca.js` (1.8 Anvil reader: region header → zlib → NBT → `Level.Sections[].Y/Blocks/Add/Data`), `regions.js` (v2 pipeline + PNG), `run_v2.js` (CLI, same arguments as `run.js`, writes `out/<name>_v2.{png,_graph.json,_stats.json}`).
`skeleton.js` changes are additive (v1 output unchanged): `fb` field is loaded, `ctx.DE` marks door/gate planar edges, `forcedNodes(ctx,S,extra,block)` accepts extra forced cells and a no-enter mask. v1 code is kept in `v1_backup/`, v1 outputs in `out/huangcheng.*`, `out/renzu_village*.*`.

```
node --max-old-space-size=2000 run_v2.js 0 -200 300 220 huangcheng "--seeds=179,47,183;33,47,163;256,48,34;179,68,-166"
node --max-old-space-size=2000 run_v2.js 1570 60 1770 210 renzu_village "--seeds=1686,143,107;1598,132,123;1600,140,112;1739,160,95;1654,153,174;1625,136,100;1689,140,138;1663,181,184;1677,134,141" --oneway=true
```
World read: `.server/盘灵古域/world_backup_20261028_1454/region` (read-only; never `world/`).

## Algorithm
1. Load + reach filter + planar graph as v1, on the full kept set.
2. **Roof scan** per kept cell: blocks `floor(f)+2 … floor(f)+12` from the world backup, first non-ignored block decides: roof / canopy / nothing (rules below).
3. **Buildings**
   - Door cut: drop `door_open`/`gate_open` edges; components ≤ 400 cells (not the main one) that touch a door edge and are ≥ 25 % roofed are rooms (all their cells become candidates, roofed or not).
   - Candidates = roofed cells ∪ rooms. Unroofed pockets ≤ 8 cells touching candidates are absorbed (light wells, one missing roof block).
   - Components of candidates (planar edges incl. inner doors, so rooms joined by doors are one building). Keep if ≥ 12 cells and openness ≤ 0.60 (openness = share of perimeter cells with a non-door planar edge to a non-candidate walkable cell; rejects roofed walkways / pergolas open on all sides).
4. **Groves** (added because the 皇城 left column is tree canopy, not buildings, see below): canopy cells (first block overhead is leaves or huge-mushroom block), morphological closing radius 3 on the walk graph (BFS dilate then erode), components ≥ 150 cells with ≥ 50 % directly under canopy → `kind:"grove"` region. Same exit handling as buildings.
5. Building + grove cells are removed; on the outdoor rest: v1 clearance → thinning → prune → cycle break → prune.
6. **Plazas**: core cells with clearance ≥ 6 on the outdoor graph, components ≥ 40; reject elongated cores (area / π(dmax−6+0.5)² > 3 = wide road). Core is grown back with budget `d(core) − dist ≥ 1.5`. Skeleton inside plazas is removed.
7. **Exits**: building/grove: outdoor cells adjacent (full planar graph, doors included) to the region, clustered; representative = a door cell if any (door edge or door-type cell T&16 on either side), else max clearance. Plaza: outdoor skeleton cells touching the plaza. Exits are forced cells linked to the skeleton by BFS that may not enter any region; an exit opening directly into another region becomes a region↔region `region_link`.
8. Graph: v1 `buildGraph`; exit nodes whose only tags are exit/door tags are **folded into the region node**; teleport/ladder edges starting inside regions are re-attached to the region node; then iterative spur pruning (untagged end node, road < max(8, 2r), other end deg ≥ 3) + degree-2 merge until stable (3 rounds).

Node output: region nodes `{kind:"building"|"grove"|"plaza", pos, cells, bbox[x0,y0,z0,x1,y1,z1], deg, exits:[{pos,door,width,node}], cell_list:[[x,y,z]...]}`; buildings also `roofed_cells, openness`. Skeleton nodes as v1. Edge kinds `road`, `region_link`, `teleport`, `ladder`.

## Indoor rule (blocks, 1.8 ids)
- Coordinate check: 3000 random non-water/ladder cells, block under the feet (`f−1` for integer floors, `floor(f)` for slabs/stairs) is solid in 3000/3000 for 皇城 (counting mushroom/leaf blocks as solid floors) and 2999/3000 for 人族村 (the one miss stands on a trapdoor, id 96); PFG3 `fb` equals the world id in 3000/3000. So x, z, f line up with the world.
- **Roof** = any block not in the ignore set: air, water/lava (8–11), saplings/plants/crops/vines/web (6,30–32,37–40,59,83,104–106,111,115,127,141,142,175), torches/signs/rails/buttons/plates/ladders/levers (50,51,55,63,65,66,68–70,72,75–77,131,132,143,144,147,148,176,177,27,28,157), fences/walls/bars/glass panes (85,113,188–192,139,101,102,160), doors/gates/trapdoors (64,71,96,107,167,183–187,193–197), snow layer 78. So slabs, stairs, planks, stone, wool, clay, **glass (20,95) counts as roof** (glass roofs of halls are real roofs; there are only 37 glass-topped cells in 皇城).
- **Canopy, never roof**: leaves 18/161 and huge mushroom blocks 99/100. On this map all 17 220 overhead mushroom blocks are meta 14 (all-cap texture) and form the orange "autumn trees" covering the west and north-west of 皇城 (checked with a top-down block render: round crowns 1–8 blocks thick, grass below, nothing above). Counting them as roof made the whole west a building.
- Scan window 2…12 above the floor block: 0 and 1 are the body; in the palace (x 143–215, z −184…−132) the roof heights found were mostly 7 (2693 cells) and 11 (1557 cells); 318 cells hit at 12, so a few taller halls may be cut by the window.

## Results (real runs, same seeds/box as v1)

| | 皇城 v1 | 皇城 v2 | 人族村 v1 oneway | 人族村 v2 oneway |
|---|---|---|---|---|
| nodes total | 1878 | 864 | 869 | 476 |
| junction | 1460 | **546** | 618 | **344** |
| end | 368 | 150 | 187 | 49 |
| forced / pass / isolated | 21 / – / 1 | 3 / 16 / – | 58 / – / – | 0 / 7 / – |
| building nodes (in box) | – | 115 | – | 72 |
| grove nodes | – | 12 | – | 0 |
| plaza nodes | 28 | 22 | 6 | 4 |
| edges | 2445 | 1381 | 1049 | 750 |
| road / region_link / teleport / ladder | 2416 / – / 13 / 16 | 1310 / 54 / 3 / 14 | 1037 / – / 9 / 3 | 727 / 16 / 7 / 0 |
| road length | 24670.8 | 11959.3 | 11537.1 | 8187.2 |
| total ms | 1056 | 1334 | 306 | 448 |
| RSS MB | 367 | 350 | 129 | 164 |

Detection counts (incl. the 24-block pad): 皇城 roofed cells 35 998 / 148 968, canopy 17 744; 136 buildings (31 168 cells), 711 small and 68 too-open candidates rejected, 79 door-cut rooms (823 cells); 13 groves (20 158 cells); 22 plazas (26 067 cells). 人族村: roofed 16 756 / 56 097, canopy 0; 80 buildings (15 308 cells), 79 door-cut rooms (5116 cells); 4 plazas.
Exit nodes folded into regions: 839 (皇城). Region reading cost 皇城: 657 chunks, 4 region files, 22 MB read, roof scan 159 ms.

Junctions by area (皇城, x<60 = L, x>240 = R; z<−60 = N, z>80 = S):

| | LN | LC | LS | MN | MC | MS | RN | RC | RS |
|---|---|---|---|---|---|---|---|---|---|
| v1 | 205 | 137 | 163 | 213 | 273 | 242 | 96 | 92 | 39 |
| v2 | 64 | 42 | 52 | 71 | 126 | 105 | 18 | 52 | 16 |

Main street check: v1 road polyline points outside v2 regions that lie within 3 blocks of a v2 road: 皇城 95.3 % (all), 97.6 % (v1 width ≥ 4), 98.4 % (width ≥ 6 and ≥ 8); 人族村 99.8 % / 100 % / 100 %. Lost wide-road points: 14 in 皇城 (width ≥ 6); I did not classify them individually.

## Misjudgment examples
- West / north-west of 皇城 (x 0–60): the dense v1 junctions there are not buildings. World data: 14 501 of 24 149 cells have nothing overhead, 6128 are under mushroom-block crowns, only 3520 have a real roof. v2 makes them groves (two large ones, 7597 and 7192 cells), not buildings. If you expected buildings there, the map disagrees.
- Covered colonnades along the central avenue (two 1255-cell regions, x 113–136 and 222–245, z −137…−13) are roofed and enclosed enough (openness 0.02) to be buildings. They are long walkways, so the parallel road is now a region with 5 exits instead of a road edge.
- Open roofed market / pavilion blocks are kept as buildings when openness is ≤ 0.60 (e.g. 991 cells at x 276–319, z 91–143, openness 0.58). Measured on 皇城: openness 0.30 gives 39 buildings / 682 junctions, 0.45 gives 70 / 617, 0.60 gives 115 / 546. 0.60 was chosen for the node count; it also accepts some open roofed structures.
- Grove closing joins crowns across short gaps, so a few road cells between trees become grove cells. Road check above includes this loss.
- The southern 11 004-cell "plaza" (x 121–324, z 152–244) covers a large open area of the south and is one node; L0 must plan across up to ~200 blocks inside it.

## Known defects
- 546 junctions remain in 皇城. 102 of them are within 2 blocks of grove cells: paths between small tree groups (under 150 cells after closing) still skeletonize into a mesh.
- Door flags are rare (6 of 412 building exits in 皇城, 2 of 239 in 人族村). 228 of the 234 door edges lie between rooms of one building; outer openings are mostly open doorways without door blocks.
- Multi-storey buildings are one node. Floors and ladders inside are hidden (ladder edges with both ends in one region are dropped); L0 must handle them.
- 4 buildings in 皇城 and 2 in 人族村 have deg 0: their exits never reach the outdoor skeleton (enclosed courtyards).
- Folded exits: road geometry ends at the exit cell, not at the region node `pos`.
- `cell_list` makes the graph JSON large; bbox is enough for most consumers.
- Thresholds (openness 0.60, grove 150 cells / 50 % canopy, closing 3, spurLen 8) were tuned on these two areas only.

---

# v3: simplification, region split, connectivity, objective metrics

Files: `v3.js` (post-processing + PNG), `run_v3.js` (CLI), `eval.js` (metrics), `exp_v3.sh` (cumulative experiment table),
`v2_backup/` (copy of `skeleton.js`, `regions.js` and `run_v2.js` before v3). `regions.js` gained three optional hooks
(`hookPreGroves`, `hookRegions`, `hookPlazas`) and some hidden (non-enumerable) cell fields. With the hooks unset, v2 output is
unchanged: rerunning `run_v2.js` on 皇城 still gives 864 nodes / 546 junctions / 1381 edges, with 0 edge diffs and 0 node
diffs (ignoring the new `region` field).

```
node --max-old-space-size=2000 run_v3.js 0 -200 300 220 huangcheng "--seeds=179,47,183;33,47,163;256,48,34;179,68,-166" --evalOut=out/eval_v3.json --draw=2,8
node --max-old-space-size=2000 run_v3.js 1570 60 1770 210 renzu_village "--seeds=1686,143,107;1598,132,123;1600,140,112;1739,160,95;1654,153,174;1625,136,100;1689,140,138;1663,181,184;1677,134,141" --oneway=true --evalOut=out/eval_v3_renzu.json --draw=1,9
node --max-old-space-size=2000 eval.js out/huangcheng_v2_graph.json --out=out/eval_v2.json        # any v2/v3 graph
./exp_v3.sh                                                                                        # experiment table -> out/v3_experiments.json
```
`run_v3.js` takes every v2 flag plus the v3 flags below. It runs v2 → v3 post-processing → eval, then writes
`out/<name>_v3.png`, `_graph.json`, `_stats.json` and the eval JSON. `--eval=false` skips the eval.

## eval.js: what is measured
- **Route quality.** Pairs: 皇城 uses the 12 pairs in `testset_v3/huangcheng_world.json`. 人族村 uses 10 pairs from
  `testset_v3/<A>__<B>.json`, all with both ends inside the box: 人族出生点–村長/鐵匠舖/村莊大門, 丹藥舖–村長/鐵匠舖,
  村莊大門–丹藥舖, 村長–雜貨舖掌櫃, 補給品簡方–鐵匠舖, 雜貨舖掌櫃–人族出生点, 鐵匠舖–村莊大門. Ground truth is
  `G.plan(...).info.length` from `node/graph.js`, cached in `out/gt_<set>.json`.
  - L1 model: the vertices are the non-region nodes plus one vertex per (region, port cell). Edges are roads (`length`),
    `region_link` and `region_adj` (`length`), ladders (at least the straight-line distance between their end cells) and
    teleports (0).
  - Region crossing: Dijkstra over the region's cells between every pair of ports. A port up to 12 steps outside its
    region is linked in (`PORT_R=12`).
  - Start and end attachment: geodesic Dijkstra up to 24 steps to any L1 vertex or road-polyline cell (with the offset
    along the road), plus all ports of the region that contains the cell.
  - ratio = L1 Dijkstra length / G.plan length.
- **Cell graph used by eval.** Planar edges plus every non-teleport PFG3 edge with |dx|,|dz| ≤ 4, made undirected. Some
  test points (e.g. 人族出生点) sit in pockets that are reachable only by a drop. Because of the undirected graph, a ratio
  can come out slightly below 1 (0.99) on one-way drops.
- **Coverage.** The fraction of reachable cells in the box that lie inside a region, or within **8 steps of geodesic
  (cell-graph) distance** of an L1 node, port or road polyline.
- **Size.** Nodes, junctions, edges, regions; region diameter (geodesic double sweep over the region's cells) and bbox
  extent; ports; port pairs closer than 4 (xz) inside one region; regions with deg 0; junctions within 2 of a grove.
- **Main street.** Polyline points of v1 roads with width ≥ 6 (also 4 and 8) that are inside a region or within 3 (xz,
  |dy| ≤ 3) of an L1 road.
- **Connectivity.** Union-find over all edges, counting connected components.
- **Time and memory.** Taken from the build stats plus eval's own timing.

## v3 methods (in pipeline order)
1. **Canopy-top groves** (`hookCanopy`, as `hookRegions`). Walkable cells whose floor is a canopy block (18/161/99/100,
   i.e. leaves or huge-mushroom caps) were the main source of the dense net in 皇城's groves: 79 v2 junctions stood on
   mushroom caps. Each 4-connected component of such cells either joins the grove it touches most, or becomes a new grove
   if it has ≥ `canopyMin`=30 cells. 皇城: 14872 canopy-top cells; 21 components joined existing groves and 33 became new
   groves. 人族村 has almost none.
2. **Region split** (`splitDiam`=48, `splitR`=20). A region is split when its geodesic diameter is > 48 or its cells are
   disconnected. Seeds are placed farthest-point first until every cell is within 20 (geodesic) of a seed. Two rounds of
   Lloyd refinement follow (seed moves to the cell nearest the piece centroid), then a geodesic Voronoi partition. Each
   piece becomes its own region node (`parent_region`, `piece`).
   - Adjacent pieces are joined by `region_adj` edges at the boundary cell pairs with the highest clearance: up to
     `adjMax`=8 per pair, at least `adjSep`=8 apart. The first try used 1 edge per pair, which pushed the max ratio to
     1.133. Several edges per pair brought it to 1.097.
   - Roads, links and specials that pointed at the old region are re-attached to the piece that contains their end cell
     (or the nearest piece by BFS).
3. **Short-edge contraction / junction clustering** (`contractMin`=3, `contractK`=1, `clusterMaxR`=8).
   - Roads between two skeleton nodes shorter than `max(3, r1+r2+1)` are contracted with union-find, shortest first.
   - A merge is refused if the cluster would then span more than 8 (euclidean).
   - The cluster's position is its member with the highest clearance (`repMode=clear`; the medoid gave a worse max).
   - Road ends are extended to the new position, so lengths only grow.
4. **Port (exit) clustering** (`portMerge`=4). Inside each region, end cells of roads, region_link and region_adj edges
   that are < 4 apart (xz, |dy| ≤ 2) are merged into the one with the highest clearance. Edges are extended by the
   distance moved.
5. **Refit** (`refit`). Every road whose end moved in steps 3–4 is replaced by the shortest cell path between its new
   ends, restricted to outdoor cells plus the two end regions and bounded by the old length. This removes the detour
   that contraction adds: 365 edges, 896 blocks saved in 皇城, and the median ratio drops from 1.111 to 1.093.
6. **Cleanup.**
   - Drop self-loops < 16.
   - Drop parallel roads whose lengths differ by < 25% + 1 and whose Hausdorff distance is ≤ `dedupeSep`=4. Before the
     Hausdorff check was added, dedupe also deleted real alternative streets: max ratio 1.18.
   - Merge untagged deg-2 nodes.
7. **Connectors** (`connect`, `connectMax`=96). Every component other than the largest is joined to another component
   by the shortest path over the eval cell graph (planar + jump/drop edges). The search starts from all cells of the
   component (region cells, node reps, road cells). If it lands on a road, that road is split there with a new
   `connector` node. Planar-only search failed for most components: they are separated by drops.
8. **Output** (`outputV3`). Roads outside the box are kept (`clipBox`=false). v2 dropped them, which split off components.
   Node kinds are recomputed from degree.
9. **Region crossing costs.** These are written into each region node as `ports` and `cross`, using exactly the costs
   eval uses (`attachCross`).

## Experiment table (cumulative, real runs, `./exp_v3.sh` → `out/v3_experiments.json`)
S0 = run_v3 with every v3 step off (equivalent to v2; 14 fewer nodes than the v2 file, because out-of-box roads are kept
and the deg recount differs slightly). Each later row turns one more step on. S3 includes refit + dedupe.

| set | step | median | max | coverage | nodes | junctions | edges | regions | max diam | diam>48 | ports | close ports | deg0 reg | junct≤2 grove | main w6 | comps | build ms | RSS MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 皇城 | v2 file (`eval_v2.json`) | 1.0621 | 1.0926 | 0.9809 | 864 | 546 | 1381 | 149 | 327.2 | 47 | 726 | 220 | 4 | 102 | 0.9783 | 34 | 1334 | 350 |
| 皇城 | S0 v2-equiv | 1.0621 | 1.0926 | 0.9785 | 850 | 546 | 1338 | 150 | 327.2 | 47 | 699 | 210 | 4 | 102 | 0.9749 | 34 | 1249 | 370 |
| 皇城 | S1 +canopy groves | 1.0621 | 1.0926 | 0.9778 | 710 | 443 | 1159 | 171 | 330.5 | 49 | 736 | 268 | 16 | 10 | 0.9749 | 35 | 1149 | 327 |
| 皇城 | S2 +split ≤48 | 1.0659 | 1.0974 | 0.9883 | 1421 | 443 | 2285 | 882 | 45.6 | 0 | 2910 | 609 | 15 | 10 | 0.9783 | 35 | 2235 | 369 |
| 皇城 | S3 +contract/refit/dedupe | 1.0893 | 1.1110 | 0.9838 | 1230 | 252 | 2033 | 882 | 45.6 | 0 | 2877 | 576 | 15 | 3 | 0.9666 | 35 | 2304 | 403 |
| 皇城 | S4 +connectors | 1.0893 | 1.1110 | 0.9841 | 1246 | 268 | 2082 | 882 | 45.6 | 0 | 2922 | 582 | 1 | 5 | 0.9666 | 2 | 2464 | 420 |
| 皇城 | **S5 +port merge = v3** | **1.0927** | **1.1115** | 0.9835 | 1247 | **269** | 2074 | 882 | 45.6 | 0 | 2458 | **14** | 1 | 5 | 0.9624 | **2** | 2534 | 424 |
| 人族村 | v2 file (`eval_v2_renzu.json`) | 1.0193 | 1.1254 | 0.9378 | 476 | 344 | 750 | 76 | 309.9 | 8 | 283 | 100 | 2 | 0 | 1.0 | 15 | – | – |
| 人族村 | S0 v2-equiv | 1.0193 | 1.1254 | 0.9369 | 469 | 344 | 735 | 76 | 309.9 | 8 | 269 | 90 | 2 | 0 | 0.9908 | 15 | 412 | 151 |
| 人族村 | S1 +canopy | 1.0193 | 1.1254 | 0.9369 | 469 | 344 | 735 | 76 | 309.9 | 8 | 269 | 90 | 2 | 0 | 0.9908 | 15 | 412 | 176 |
| 人族村 | S2 +split | 1.0193 | 1.1254 | 0.9383 | 605 | 344 | 894 | 212 | 47.6 | 0 | 584 | 131 | 2 | 0 | 0.9908 | 15 | 518 | 167 |
| 人族村 | S3 +contract | 1.0341 | 1.1312 | 0.9308 | 466 | 205 | 723 | 212 | 47.6 | 0 | 573 | 119 | 2 | 0 | 0.9847 | 15 | 555 | 183 |
| 人族村 | S4 +connectors | 1.0325 | 1.1312 | 0.9309 | 476 | 216 | 746 | 212 | 47.6 | 0 | 580 | 120 | 0 | 0 | 0.9847 | 2 | 604 | 183 |
| 人族村 | **S5 = v3** | **1.0566** | **1.1184** | 0.9307 | 478 | **217** | 746 | 212 | 47.6 | 0 | 476 | **2** | 0 | 0 | 0.9847 | **2** | 630 | 176 |

`build ms` / `RSS MB` = the run_v3 build (v2 + v3 post) without eval or PNG. The v2 file row uses the time from the
original v2 run.

Tuning sweeps on 皇城 (median / max / junctions), run before refit and connectors existed:
- clusterMaxR: 6 → 1.108 / 1.153 / 272; 8 → 1.108 / 1.157 / 241; 12 → 1.116 / 1.208 / 193 (rejected as too lossy).
- contractK=0.5 → 1.106 / 1.184 / 267.
- repMode: medoid has the same median as clear but max 1.184.
- Dedupe: without the Hausdorff check, max 1.157 because real alternative streets were deleted. dedupeSep=4 gives
  254 junctions and 1.1115; dedupeSep=8 gives 247 junctions but median 1.106.
- region_adj: 1 edge per piece pair gave max 1.133; adjMax=8 / adjSep=8 gives 1.097.
- Refit (S3 without → with): median 1.1156 → 1.106 at clusterMaxR=8.
- splitR=23 gives 760 regions (vs 882) with the same ratio.
- Connectors: planar-only search left 23 components. Searching over planar + jump/drop edges, and keeping roads
  outside the box, brings it to 2.

## Final parameters (`V3` in `v3.js`, on top of the v2 defaults)
`canopyTop=true canopyMin=30 canopyJoin=true | splitDiam=48 splitR=20 adjMax=8 adjSep=8 | contract=true contractMin=3
contractK=1 clusterMaxR=8 repMode=clear | refit=true | dedupe=true dedupeTol=0.25 dedupeSep=4 | portMerge=4 |
connect=true connectMax=96 | spurMin=0 | clipBox=false`. Eval: `ATTACH=24 COVER=8 PORT_R=12 MAIN_W=6 MAIN_R=3`.

## Final run
- 皇城: build 2.6 s (v2 part 1.0 s). Total including eval and PNG is 4.5 s; peak RSS 558 MB. All 12/12 pairs reach,
  with per-pair ratios 1.074–1.112.
- 人族村: build 0.63 s, RSS 295 MB; 10/10 pairs reach.
- PNG:
  - Each region piece gets its own hue (mixed with its kind colour), a dark border and a square marker.
  - Lines: white = road end or region_link to the region node; light blue = region_adj; magenta = connector roads.
  - Test routes are drawn thick in cyan and magenta: 皇城 南门→人皇 (1.0973) and 元素回收員→人皇 (1.1115); 人族村
    人族出生点→鐵匠舖 (1.0641) and 鐵匠舖→村莊大門 (1.104).

## L1 graph.json schema (v3)
`{ name, box, opts, stats, nodes[], edges[] }`; node `id` = array index. `stats.v3` holds the counters of each step.
- **Skeleton node:** `{id, kind: junction|end|pass|isolated|forced, tags[], pos[x,y,z], radius, cells, deg, merged?}`.
  `merged` is the number of v2 nodes contracted into it. Tag `connector` = node created by splitting a road for a
  connector.
- **Region node:** `{id, kind: building|grove|plaza, pos, cells, bbox[x0,y0,z0,x1,y1,z1], deg, region, parent_region?, piece?,
  cell_list[[x,y,z]], ports[[x,y,z]], cross[[i,j,cost]]}`.
  - `region` is the index of the v2 region it came from. For a split region, `parent_region` is that same index and
    `piece` is the piece number.
  - `ports` lists the cells where L1 edges touch this region.
  - **Region crossing cost** is in `cross`: the in-region shortest cell-path length between `ports[i]` and `ports[j]`
    (symmetric, i<j). A pair is missing when no in-region path exists. These are the same values eval.js uses. Ports
    that lie outside the region are linked to region cells within 12 steps.
- **Edges:**
  - `road {a, b, kind:'road', length, width_min, cells, polyline[[x,y,z]] (every 4th cell, oriented a→b), connector?}`.
    Road ends at a region node lie on or just outside that region's cells.
  - `region_link {a, b, kind, at, length:0}`: an exit attached to a region, or region↔region contact at cell `at`.
  - `region_adj {a, b, kind, a_pos, b_pos, length}`: a boundary step between two pieces of the same split region (up
    to 8 per pair).
  - `ladder {a, b, at, to, length, ladder_cells}`.
  - `teleport {a, b:null, at, dst_gid}`.
- Routing on L1: a vertex is a skeleton node or a (region, port) pair. Edge weights are as above, and `cross` gives the
  cost of moving between ports inside a region.

## Known defects (v3)
- **Route ratio is worse than v2.**
  - 皇城: v2 1.062 / 1.093, v3 1.093 / 1.112. 人族村: v2 1.019 / 1.125, v3 1.057 / 1.118.
  - Both are inside the target (≤1.10 / ≤1.30), but the 皇城 median is close to the limit.
  - The loss comes from contraction and port merging: reps move off the straight line, and some parallel streets are
    removed.
- **Node and edge counts went up.**
  - Splitting to ≤48 creates 882 region pieces in 皇城; the 11004-cell plaza alone becomes about 30 pieces.
  - Nodes 864 → 1247; edges 1381 → 2074, of which 1119 are region_adj.
  - "Junctions < 300" is met (269), but the total node count is not smaller.
- **Grove areas are now region pieces with many white port lines.** The image is still busy there, but there is no
  skeleton net any more: junctions within 2 of a grove went from 102 to 5.
- **Residual junctions are in narrow alleys.** Most of the 269 sit in the south-central building blocks. Contraction
  runs on the finished v2 graph, without re-thinning.
- **Two components remain in each map.**
  - 皇城: an underground building at [56,7,24] (y=7) has no non-teleport path within 96 blocks.
  - 人族村: a cluster of 16 nodes (15 buildings) at y≈43–51, z 203–231, outside the south edge of the box (z1=210). It is
    reached from cells outside the loaded/seeded area, so no in-graph path exists.
  - v2 had 34 and 15 components.
- **Main street (w≥6, within 3) dropped**: 皇城 0.978 → 0.962, 人族村 1.0 → 0.985. Refit paths and cluster reps can sit
  more than 3 blocks from the v1 centreline on wide streets.
- **人族村 coverage is 0.931** (v2 0.938). Cliffs and terraces leave cells further than 8 from any edge.
- **Eval and `cross` are undirected.** On `--oneway` maps the ratios are optimistic.
- **Each split region keeps its v2 exits.** Exits are reassigned to pieces, but no new exits are detected per piece.

## Next steps
- Directed eval and directed `cross` for one-way maps.
- Width-aware contraction: contract hard only where the alley is ≤ 2 wide, and protect wide streets. This should
  recover the median ratio and the main-street score.
- Hierarchical regions: keep the v2 region as a parent with its pieces as children, so a planner can pick the coarse or
  the fine level.
- Prune region_adj edges down to the 2–3 per pair that routes actually use.

# v4: directed evaluation, region hierarchy, alley contraction, directed spanner

Files: `v4.js` (post-processing + render), `run_v4.js` (CLI), `eval.js` (now directed), `exp_v4.sh` (experiment table).
v3 code is backed up in `v3_backup/`; v3 outputs are untouched. `regions.js` is unchanged since v3 (hooks only).

```
node --max-old-space-size=2000 run_v4.js 0 -200 300 220 huangcheng "--seeds=179,47,183;33,47,163;256,48,34;179,68,-166" --evalOut=out/eval_v4.json --draw=2,8 --drawShortcuts=false
node --max-old-space-size=2000 run_v4.js 1570 60 1770 210 renzu_village "--seeds=1686,143,107;1598,132,123;1600,140,112;1739,160,95;1654,153,174;1625,136,100;1689,140,138;1663,181,184;1677,134,141" --oneway=true --evalOut=out/eval_v4_renzu.json --draw=1,9 --drawShortcuts=false
node --max-old-space-size=2000 eval.js out/huangcheng_v3_graph.json --out=out/eval_v3_directed.json   # re-evaluate any old graph
./exp_v4.sh                                                                                              # cumulative table -> out/v4_experiments.json
```
Flags: `--star=true` draws the old white region→exit star lines and region squares; `--drawShortcuts=false` hides spanner roads (used for the delivered PNGs; `out/*_v4_full.png` shows them in brown).

## eval.js changes (directed)
- Eval adjacency is now directed: forward CSR = planar edges + all non-teleport PFG3 edges between kept cells with |dx|,|dz| ≤ 4, taken in their real direction (drops are one-way). A reverse CSR is used for goal-side attachment. Coverage and region diameter still use the undirected version (they are not route measures).
- Every L1 edge gets a cost per direction: road = forward cell Dijkstra inside a corridor (2, then 5 steps) around its polyline, both ways; a direction with no path is left out (`roads_blocked` counts roads usable in neither direction, `roads_one_way` counts roads usable in one direction only). Same for region_link / region_adj / ladder.
- Region crossing is directed: cost[i][j] = forward Dijkstra from port i to port j inside the region mask (+3-cell rim, `EVAL_CROSS_MARGIN`). Ordered pairs are stored separately.
- Start attaches with forward search, goal with reverse search (radius 24; widened to 48/96/192 if nothing found, needed for cells deep inside big buildings).
- `ratio_p90` added.
- **Random pairs**: 30 pairs per map (LCG seed 12345, cells inside the box with forward edges, xz distance ≥ 80). Ground truth = directed cell Dijkstra on the eval adjacency, cached in `out/gt_<set>_rand.json`. Median GT length: 皇城 304.8, 人族村 187.4. Reported in `random` (median / p90 / max / reachable).
- Directed re-baselines: `out/eval_v2_directed.json`, `out/eval_v3_directed.json`, `out/eval_v2_renzu_directed.json`, `out/eval_v3_renzu_directed.json` (same eval code as v4).

The directed re-run showed that v3 on 人族村 was much worse than the undirected numbers said: fixed pairs 1.238 / p90 2.67 / max 3.04 (undirected 1.057 / 1.118). Causes: (a) v3 port merge allowed |Δy| ≤ 2, so it merged ports on different terrace levels; (b) many skeleton roads can only be walked downhill.

## v4 methods (in pipeline order)
1. **Directed fixes** (`portMergeDy=0`, `repair`, `keepRegionLoops`). Port merge only merges ports on the same floor level. `repairDirected`: for every road, check the directed cost each way inside a corridor; if a direction is blocked or costs > 1.5·len+4, add a one-way `repair` road along the shortest directed cell path (bounded by 1.5·2·len+48). Region self-loop roads are kept (v3 deleted loops < 16 cells, which also removed a few wide street pieces next to buildings in 人族村).
2. **Region hierarchy, buildings unsplit** (`splitDiamBuilding=100000`). Groves and plazas are still split into pieces with diameter ≤ 48 (`splitR 20`, geodesic Voronoi). Buildings stay whole: L0 can plan inside a building. Tested 48 / 64 / 96 / never (table below). "Never" removes ~280 nodes on 皇城 with near-equal route ratio. Each split region gets a **parent** record (see schema).
3. **region_adj ≤ 3 per piece pair** (`adjMax 3`, spaced ≥ 8). Histogram of region_adj per pair on 皇城: 1:530, 2:93, 3:20. No ratio change versus 8.
4. **Narrow-alley contraction** (`alleyW 3, alleyLen 16, alleyMaxR 16`). Roads with width_min ≤ 3 whose end junction radii are ≤ 4 are contracted when shorter than 16 (instead of max(3, r1+r2+1)), with cluster radius up to 16. Wide roads keep the v3 rule. `wideMax=3` (contract wide roads even less) was tested and rejected: junctions went up (229→308) with no ratio gain.
5. **Local directed spanner** (`span`, `spanR 96, spanT 1.15, spanAdd 6, spanMin 6`). After the graph is built, for every L1 vertex run a forward cell Dijkstra up to 96; for every other L1 vertex reached at cell distance d ≥ 6 where the current L1 distance > 1.15·d + 6, add a one-way `shortcut` road along the cell path (greedy by d, re-checked after each insertion). This is what brought ratios down; contraction alone did not (see S4 vs S5).
6. **Render**: no star lines by default; parent borders thick black, child (piece) borders thin light; ports are small white dots; roads red, repair pink, connector magenta, shortcut brown; test routes cyan and lime with a black outline.

## Experiment table (cumulative, real runs, `./exp_v4.sh` → `out/v4_experiments.json`, all directed)
Fixed = 12 (皇城) / 10 (人族村) named pairs; rand = 30 random pairs. Ratios median / p90 / max.

| map | step | fixed | rand | rand reach | coverage | w6 | nodes | junctions | edges | regions | comps | total ms | RSS MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 皇城 | S0 v3 | 1.1019 / 1.1093 / 1.1097 | 1.1226 / 1.3594 / 2.8068 | 27/30 | 0.9835 | 0.9624 | 1247 | 269 | 2074 | 882 | 2 | 5432 | 424 |
| 皇城 | S1 directed fixes | 1.0979 / 1.1068 / 1.1097 | 1.1233 / 1.3594 / 2.8195 | 30/30 | 0.9847 | 0.9624 | 1246 | 269 | 2139 | 882 | 2 | 5330 | 420 |
| 皇城 | S2 buildings unsplit | 1.0961 / 1.1068 / 1.1097 | 1.1244 / 1.3513 / 2.8195 | 30/30 | 0.9828 | 0.9624 | 965 | 269 | 1794 | 601 | 2 | 4790 | 436 |
| 皇城 | S3 adj ≤ 3 | same as S2 | same | 30/30 | 0.9828 | 0.9624 | 965 | 269 | 1794 | 601 | 2 | 4810 | 432 |
| 皇城 | S4 alley contraction | 1.0961 / 1.1068 / 1.1097 | 1.1269 / 1.349 / 2.836 | 30/30 | 0.9827 | 0.9616 | 902 | 229 | 1843 | 601 | 2 | 4813 | 438 |
| 皇城 | S5 spanner (= v4) | **1.0389 / 1.0542 / 1.0595** | **1.0467 / 1.0698 / 1.0806** | 30/30 | 0.9907 | 0.9833 | 902 | 229 | 3534 | 601 | 2 | 32446 | 429 |
| 人族村 | S0 v3 | 1.238 / 2.6747 / 3.0449 | 1.283 / 1.6881 / 1.9878 | 24/30 | 0.9307 | 0.9847 | 478 | 217 | 746 | 212 | 2 | 1072 | 174 |
| 人族村 | S1 directed fixes | 1.0554 / 1.2046 / 1.2355 | 1.1721 / 1.5217 / 2.3948 | 28/30 | 0.9628 | 1.0 | 478 | 221 | 954 | 212 | 2 | 1515 | 273 |
| 人族村 | S2 buildings unsplit | 1.0554 / 1.2046 / 1.2355 | 1.1926 / 1.5217 / 2.3948 | 28/30 | 0.9623 | 1.0 | 350 | 221 | 815 | 84 | 2 | 1336 | 273 |
| 人族村 | S3 adj ≤ 3 | same as S2 | same | 28/30 | 0.9623 | 1.0 | 350 | 221 | 815 | 84 | 2 | 1348 | 265 |
| 人族村 | S4 alley contraction | 1.0783 / 1.9448 / 2.4597 | 1.3265 / 1.7665 / 2.3494 | 28/30 | 0.9577 | 1.0 | 275 | 158 | 806 | 84 | 2 | 1377 | 264 |
| 人族村 | S5 spanner (= v4) | **1.017 / 1.0329 / 1.0359** | **1.0625 / 1.134 / 1.1789** | 30/30 | 0.9864 | 1.0 | 275 | 158 | 1370 | 84 | 2 | 2954 | 283 |

(Total ms in this table includes eval; the S5 皇城 time is dominated by the spanner, ~25–30 s.)

Directed v2 for reference: 皇城 1.0959 / 1.1146 / 1.1216, rand 1.1007 / 1.2225 / 1.6782 (26/30), 864 nodes, 546 junctions; 人族村 1.0358 / 1.2087 / 1.2765, rand 1.1819 / 1.5651 / 1.8898 (25/30), 476 nodes, 344 junctions.

## Parameter sweeps (single runs, on top of the step named)
| change | 皇城 fixed | 皇城 rand | 皇城 nodes / junc / edges | 人族村 fixed | 人族村 rand | 人族村 nodes / junc |
|---|---|---|---|---|---|---|
| span T1.1 R48 add3 | 1.0352 / 1.047 / 1.0489 | 1.0441 / 1.0618 / 1.072 | – / – / 5049 | 1.0175 / 1.0352 / 1.0601 | 1.0453 / 1.1679 / 1.2644 | – |
| span T1.2 R80 add6 | 1.0452 / 1.0886 / 1.0886 | 1.0585 / 1.0754 / 1.1225 | 902 / 229 / 3169 | 1.0137 / 1.0338 / 1.0359 | 1.0757 / 1.1644 / 1.2235 | 273 / 157 |
| span T1.15 R128 | 1.0351 / 1.0518 / 1.0548 | 1.045 / 1.0687 / 1.0806 | 902 / 229 / 3539 (spanner 46 s) | 1.017 / 1.0329 / 1.0359 | 1.0564 / 1.1175 / 1.1789 | 273 / 157 |
| **span T1.15 R96 (chosen)** | 1.0389 / 1.0542 / 1.0595 | 1.0467 / 1.0698 / 1.0806 | 902 / 229 / 3534 (spanner 25–30 s) | 1.017 / 1.0329 / 1.0359 | 1.0625 / 1.134 / 1.1789 | 275 / 158 |
| alleyW 2, alleyLen 12 | – | – | 937 / 253 | – | – | – / 201 |
| alleyW 4, alleyLen 20 | 1.0402 / 1.087 / 1.087 | 1.0575 / 1.0748 / 1.1225 | 874 / 210 (w6 0.9791) | – | – | – |
| wideMax 3 | 1.0494 / 1.0932 / 1.0932 | 1.0598 / 1.0926 / 1.1225 | 983 / 308 | 1.0172 / 1.0342 / 1.0362 | 1.0678 / 1.1456 / 1.265 | 325 / 209 |
| splitDiamBuilding 48 | 1.0272 / 1.0592 / 1.0615 | 1.0509 / 1.0715 / 1.0848 | 1183 / 229 / 4338 | – | – | – |
| splitDiamBuilding 64 | 1.0415 / 1.0592 / 1.0615 | 1.053 / 1.0715 / 1.0848 | 1131 / 229 / 4110 | 1.017 / 1.0329 / 1.0359 | 1.0448 / 1.1086 / 1.1738 | 401 / 158 |
| splitDiamBuilding 96 (spanT 1.2) | 1.0442 / 1.0881 / 1.0904 | 1.0627 / 1.099 / 1.1225 | 1079 / 229 | 1.0198 / 1.0359 / 1.0747 | 1.0693 / 1.116 / 1.2701 | 378 / 157 |
| portMergeDy 1 | 1.0365 / 1.0542 / 1.0595 | 1.0449 / 1.0733 / **1.7326** | 904 / 230 | 1.006 / 1.0329 / 1.0359 | 1.0552 / 1.1493 / 1.1789 | 276 / 158 |
| contraction off | – | – | – | 1.0139 / 1.0488 / 1.0535 | 1.0732 / 1.1404 / 1.1986 | 473 / 346 |
| dedupe off | – | – | – | 1.0042 / 1.0509 / 1.0584 | 1.0585 / 1.1175 / 1.1912 | 286 / 170 |

Decisions:
- Buildings are never split. This gives the fewest nodes. Splitting at 48 improves the 皇城 fixed median by about 0.012, but costs about 280 nodes.
- Spanner T1.15 R96. R128 is only slightly better and takes about twice as long.
- portMergeDy 0. A value of 1 gives a 1.73 outlier on 皇城.

## Final parameters (`V3` object in `v4.js`)
v3 values are unchanged except for these:
- `adjMax 3`
- `alleyW 3, alleyLen 16, alleyMaxR 16`
- `keepRegionLoops true`
- `span true, spanR 96, spanT 1.15, spanAdd 6, spanMin 6`
- `splitDiamBuilding 100000`
- `portMergeDy 0`
- `repair true, repairK 1.5, repairMax 48`

Kept from v3: canopyTop, canopyMin 30, splitR 20, splitDiam 48, adjSep 8, contractMin 3, contractK 1, clusterMaxR 8, repMode clear, connect (connectMax 96), portMerge 4, dedupe (tol 0.25, sep 4), refit.

## Final run (`out/eval_v4.json`, `out/eval_v4_renzu.json`)
| metric | 皇城 v3 (directed) | 皇城 v4 | 人族村 v3 (directed) | 人族村 v4 |
|---|---|---|---|---|
| fixed pairs median / p90 / max | 1.1019 / 1.1093 / 1.1097 | 1.0389 / 1.0542 / 1.0595 | 1.238 / 2.6747 / 3.0449 | 1.017 / 1.0329 / 1.0359 |
| random 30 median / p90 / max | 1.1226 / 1.3594 / 2.8068 (27/30) | 1.0467 / 1.0698 / 1.0806 (30/30) | 1.283 / 1.6881 / 1.9878 (24/30) | 1.0625 / 1.134 / 1.1789 (30/30) |
| coverage | 0.9835 | 0.9907 | 0.9307 | 0.9864 |
| main street w6 | 0.9624 | 0.9833 | 0.9847 | 1.0 |
| nodes / junctions | 1247 / 269 | 902 / 229 | 478 / 217 | 275 / 158 |
| edges | 2074 | 3534 (1691 shortcut, 103 repair, 34 connector) | 746 | 1370 (564 shortcut, 210 repair) |
| regions (+ parents) | 882 | 601 (+14 parents, 445 children) | 212 | 84 (+1 parent, 9 children) |
| components | 2 | 2 | 2 | 2 |
| time, RSS | 2.6 s build, 558 MB | 2.7 s build + 30 s spanner, 36.6 s total incl. eval, 598 MB | 0.63 s build | 1.1 s build + 1.7 s spanner, 3.5 s total, 310 MB |

## L1 graph.json schema (v4 additions to the v3 schema above)
- **Top level**: `{name, box, opts, stats, nodes, edges, parents}`.
- **Region node** (`kind` is building, grove or plaza): `id, pos, cells, bbox, deg, region, cell_list, ports [[x,y,z]], cross [[i, j, cost]]`.
  - `cross` is **directed**: it is the cost from `ports[i]` to `ports[j]` inside the region, from a forward cell Dijkstra. A missing (i,j) pair means there is no directed path inside the region.
  - Pieces of a split grove or plaza also carry `parent_region` (index of the original v2 region), `piece`, and `parent` (the id of the parent record, e.g. `"P136"`).
- **`parents[]`**: `{id: "P<region>", region, kind, cells, bbox, children: [piece node ids], ports: [[x,y,z]], port_child: [child id per port], cross: [[i, j, cost]]}`.
  - Parent ports are the child ports that have an L1 edge to or from outside the parent.
  - Parent `cross` is the directed shortest distance between parent ports, using only the children's crossings and the child–child region_adj edges.
  - A planner can treat the parent as one node (coarse) or use the children (fine).
- **Road edge**: `a, b, kind:'road', length, width_min, cells, polyline`, plus these optional flags:
  - `oneway:true`: walk a→b only.
  - `repair:true`: a directed repair path.
  - `shortcut:true`: a spanner road. It is also oneway and has `a_pos`/`b_pos`.
  - `connector:true`: a link to a stray component.
- **`region_adj`** (piece to piece): `a, b, a_pos, b_pos, length`, at most 3 per piece pair.
- **Other edges**:
  - `region_link`: `a, b, at, length 0`.
  - `ladder`: `a, b, at, to, length, ladder_cells`.
  - `teleport`: `a, b:null, at, dst_gid`.
- **How eval reads edges**: an edge without `oneway` is used in a given direction only if the directed corridor check finds a path that way. Old v3 drop-only roads are therefore handled. A consumer that cannot check cells should treat `oneway` literally and treat everything else as two-way.

## Known defects (v4)
- **Edge count went up**, from 2074 to 3534 on 皇城. About half of the edges are spanner shortcuts. They fix route quality, but they are one-way polylines that partly overlap real roads. The delivered PNG hides them; `out/*_v4_full.png` shows them in brown.
- **Build time**: the spanner takes about 25–30 s on 皇城, while v3 took 4.5 s in total. RSS stays under 600 MB.
- **Big buildings are unsplit.** Region max diameter is 277 on 皇城 (the 6985-cell palace compound) and 310 on 人族村. On 皇城, 36 regions have diameter > 48, and all of them are buildings. This is the intended trade-off, because L0 plans inside buildings. Inside the largest compounds, an L0 window of 48–64 still needs the region's `cross` table plus port positions as waypoints.
- **Close port pairs** (< 4 apart in the same region) rose from 14 to 150 on 皇城. Ports on different floor levels are no longer merged, because merging them caused the directed failures. Most of these pairs are vertically separated.
- **Alley contraction alone did not improve ratios.** In step S4 the ratios stayed the same or got slightly worse, and p90 on 人族村 got much worse before the spanner. The ratio targets were reached by the spanner, not by contraction.
- On 人族村, 272 of 1302 ordered region-crossing pairs have no directed path inside the region (terraced buildings that can only be walked one way). Routes go around them.
- **Two components remain on each map**, the same as in v3: on 皇城, the underground room at [56,7,24]; on 人族村, the building cluster south of the box at z 203–231.
- **The random-pair test is not fully independent.** The spanner is built on the same directed cell adjacency that produces the random-pair ground truth. The spanner sources are L1 vertices, not the random cells, but a planner using different movement rules than eval.js could see worse ratios.
- **The 12 named 皇城 pairs and the 10 人族村 pairs still use G.plan** as ground truth. G.plan ends within a 2/1-block radius of the goal, while L1 attaches to the exact cell, so ratios slightly below 1 occur (e.g. 0.9742).

## Next steps
- Make the spanner cheaper: run it only from vertices whose local stretch is high, or reuse the Dijkstra trees. Merge shortcuts that run parallel to an existing road.
- Split only the largest buildings (> 128 diameter) into floors or wings, and keep the parent record.
- Add a hierarchical planner test that uses `parents[].cross` instead of children.
