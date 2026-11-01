h.home.st.state='run';h.home.st.step='village->gate';
(async()=>{try{await h.routes.follow('人族出生点->皇城南门');await h.routes.follow('皇城南门->双房');await h.goto(-164,45,673,2,20000).catch(()=>{});}catch(e){h.home.st.log.push('resume err '+e.message)}h.home.st.state='done';h.combat.start();h.farm.start(h.farm.cfg);})();
return 'started arr'+h.count('arrow')+' gold'+h.count('gold_nugget')+' food'+bot.food;
