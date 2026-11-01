#!/bin/bash
# cumulative v3 experiment table; writes out/exp/<set>_<step>.json (eval) and out/v3_experiments.json
cd "$(dirname "$0")"; mkdir -p out/exp
HC="0 -200 300 220 huangcheng --seeds=179,47,183;33,47,163;256,48,34;179,68,-166"
RZ="1570 60 1770 210 renzu_village --seeds=1686,143,107;1598,132,123;1600,140,112;1739,160,95;1654,153,174;1625,136,100;1689,140,138;1663,181,184;1677,134,141 --oneway=true"
OFF="--canopyTop=false --splitDiam=100000 --contract=false --portMerge=0 --connect=false --dedupe=false --refit=false"
declare -a NAMES=(S0_v2equiv S1_canopy S2_split S3_contract S4_connect S5_ports)
declare -a FL=(
"$OFF"
"--splitDiam=100000 --contract=false --portMerge=0 --connect=false --dedupe=false --refit=false"
"--contract=false --portMerge=0 --connect=false --dedupe=false --refit=false"
"--portMerge=0 --connect=false"
"--portMerge=0"
"")
for set in HC RZ; do for i in "${!NAMES[@]}"; do
  n=${NAMES[$i]}; a=${!set}
  node --max-old-space-size=2000 run_v3.js $a ${FL[$i]} --suffix=_exp --evalOut=out/exp/${set}_$n.json > /dev/null || echo FAIL $set $n
done; done
rm -f out/*_exp.png out/*_exp_graph.json out/*_exp_stats.json
node -e "
const fs=require('fs');const rows=[];
for(const set of ['HC','RZ'])for(const n of '${NAMES[*]}'.split(' ')){const e=JSON.parse(fs.readFileSync('out/exp/'+set+'_'+n+'.json'));
rows.push({set,step:n,median:e.route.ratio_median,max:e.route.ratio_max,reach:e.route.reachable+'/'+e.route.pairs,coverage:e.coverage.coverage,nodes:e.size.nodes,junctions:e.size.junctions,edges:e.size.edges,regions:e.size.regions,max_diam:e.size.region_max_diam,diam_gt48:e.size.regions_diam_gt48,ports:e.size.ports_total,close_ports:e.size.close_port_pairs_lt4,deg0:e.size.regions_deg0,j_grove2:e.size.junctions_within2_of_grove,w6:e.main_street&&e.main_street.w6.kept,comps:e.connectivity.count,build_ms:e.build.timing_ms.build_total_ms,rss:e.build.rss_mb});}
fs.writeFileSync('out/v3_experiments.json',JSON.stringify(rows,null,1));
for(const r of rows)console.log(Object.values(r).join(' | '));"
