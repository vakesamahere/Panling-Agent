#!/bin/bash
# cumulative v4 experiment table (directed eval); writes out/exp4/<set>_<step>.json and out/v4_experiments.json
# S0 = v3 behaviour run through run_v4.js; each later step switches one v4 feature on (cumulative); S5 = v4 defaults.
cd "$(dirname "$0")"; mkdir -p out/exp4
HC="0 -200 300 220 huangcheng --seeds=179,47,183;33,47,163;256,48,34;179,68,-166"
RZ="1570 60 1770 210 renzu_village --seeds=1686,143,107;1598,132,123;1600,140,112;1739,160,95;1654,153,174;1625,136,100;1689,140,138;1663,181,184;1677,134,141 --oneway=true"
SPAN="--span=false"; ALLEY="--alleyW=2 --alleyLen=0 --alleyMaxR=12"; ADJ="--adjMax=8"; BLD="--splitDiamBuilding=48"; DIR="--portMergeDy=2 --repair=false --keepRegionLoops=false"
declare -a NAMES=(S0_v3 S1_directed_fix S2_bld_unsplit S3_adj3 S4_alley S5_spanner)
declare -a FL=(
"$DIR $BLD $ADJ $ALLEY $SPAN"
"$BLD $ADJ $ALLEY $SPAN"
"$ADJ $ALLEY $SPAN"
"$ALLEY $SPAN"
"$SPAN"
"")
run() { local set=$1 a=${!1}; for i in "${!NAMES[@]}"; do n=${NAMES[$i]}
  node --max-old-space-size=2000 run_v4.js $a ${FL[$i]} --suffix=_exp4 --evalOut=out/exp4/${set}_$n.json > /dev/null 2>&1 || echo FAIL $set $n; done; }
run HC & run RZ & wait
rm -f out/*_exp4.png out/*_exp4_graph.json out/*_exp4_stats.json
node -e "
const fs=require('fs');const rows=[];
for(const set of ['HC','RZ'])for(const n of '${NAMES[*]}'.split(' ')){const e=JSON.parse(fs.readFileSync('out/exp4/'+set+'_'+n+'.json'));const r=e.random||{};
rows.push({set,step:n,median:e.route.ratio_median,p90:e.route.ratio_p90,max:e.route.ratio_max,reach:e.route.reachable+'/'+e.route.pairs,
 r_median:r.ratio_median,r_p90:r.ratio_p90,r_max:r.ratio_max,r_reach:r.reachable+'/'+r.pairs,coverage:e.coverage.coverage,w6:e.main_street&&e.main_street.w6.kept,
 nodes:e.size.nodes,junctions:e.size.junctions,edges:e.size.edges,regions:e.size.regions,comps:e.connectivity.count,build_ms:e.build.timing_ms.total_ms,rss:e.build.rss_mb});}
fs.writeFileSync('out/v4_experiments.json',JSON.stringify(rows,null,1));
console.log(Object.keys(rows[0]).join(' | '));for(const r of rows)console.log(Object.values(r).join(' | '));"
