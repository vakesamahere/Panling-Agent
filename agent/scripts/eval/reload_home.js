const st=h.home.st;delete require.cache[require.resolve('./heuristics/home')];h.home=require('./heuristics/home')(bot,h);h.home.st.log=st.log;
return 'reloaded '+bot.entity.position.floored()+' farm'+h.farm.state().on;
