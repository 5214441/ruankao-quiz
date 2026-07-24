(function(){
  'use strict';
  const NEW_KEY='ruankao-smart-v35-state';
  const OLD_KEY='ruankao-smart-v3-state';
  const STATE_VERSION=35;

  function today(){
    const d=new Date();
    const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }

  function defaultState(){
    return {
      version:STATE_VERSION,
      profile:null,
      questionStats:{},
      history:[],
      plan:[],
      planLength:30,
      draft:null,
      favorites:[],
      notes:{},
      wrongReasons:{},
      caseAttempts:[],
      settings:{theme:'system',fontScale:1,lastBackup:'',lastSeenQuestionVersion:''},
      streak:{lastDate:'',days:0},
      createdAt:today(),
      updatedAt:today()
    };
  }

  function safeParse(text){
    try{return JSON.parse(text);}catch(_){return null;}
  }

  function migrateV3(old){
    const fresh=defaultState();
    if(!old||typeof old!=='object')return fresh;
    fresh.profile=old.profile||null;
    const legacyStats=old.questionStats||old.qstats||old.stats||{};
    fresh.questionStats={};
    Object.keys(legacyStats).forEach(function(id){
      const x=legacyStats[id]||{};
      fresh.questionStats[id]={
        seen:Number(x.seen)||0,correct:Number(x.correct)||0,wrong:Number(x.wrong)||0,
        level:Number(x.level)||0,lastSeen:String(x.lastSeen||x.lastAt||'').slice(0,10),
        nextReview:String(x.nextReview||'').slice(0,10),totalTime:Number(x.totalTime)||0
      };
    });
    if(Array.isArray(old.history))fresh.history=old.history;
    else if(Array.isArray(old.sessions))fresh.history=old.sessions.map(function(x){
      const total=Number(x.total||x.count)||0,correct=Number(x.correct)||0;
      return {id:x.id||('legacy-'+Math.random()),mode:x.mode||'random',total:total,correct:correct,percent:total?Math.round(correct/total*100):0,duration:Number(x.duration||x.elapsed)||0,date:x.date||today(),timestamp:Date.now()};
    });
    fresh.plan=Array.isArray(old.plan)?old.plan:[];
    fresh.planLength=old.planLength||30;
    fresh.draft=null;
    fresh.favorites=Array.isArray(old.favorites)?old.favorites:[];
    fresh.caseAttempts=Array.isArray(old.caseAttempts)?old.caseAttempts:[];
    if(typeof old.streak==='number')fresh.streak={lastDate:old.lastStudyDate||'',days:old.streak};
    fresh.createdAt=old.createdAt||today();
    return fresh;
  }

  function normalize(state){
    const base=defaultState();
    if(!state||typeof state!=='object')return base;
    const merged=Object.assign(base,state);
    merged.version=STATE_VERSION;
    merged.questionStats=merged.questionStats&&typeof merged.questionStats==='object'?merged.questionStats:{};
    merged.history=Array.isArray(merged.history)?merged.history:[];
    merged.plan=Array.isArray(merged.plan)?merged.plan:[];
    merged.favorites=Array.isArray(merged.favorites)?Array.from(new Set(merged.favorites)):[];
    merged.notes=merged.notes&&typeof merged.notes==='object'?merged.notes:{};
    merged.wrongReasons=merged.wrongReasons&&typeof merged.wrongReasons==='object'?merged.wrongReasons:{};
    merged.caseAttempts=Array.isArray(merged.caseAttempts)?merged.caseAttempts:[];
    merged.settings=Object.assign(base.settings,merged.settings||{});
    merged.streak=Object.assign(base.streak,merged.streak||{});
    return merged;
  }

  function load(){
    let state=safeParse(localStorage.getItem(NEW_KEY));
    if(state)return normalize(state);
    const old=safeParse(localStorage.getItem(OLD_KEY));
    if(old){
      state=migrateV3(old);
      save(state);
      return state;
    }
    return defaultState();
  }

  function save(state){
    state.updatedAt=today();
    localStorage.setItem(NEW_KEY,JSON.stringify(normalize(state)));
  }

  function clear(){
    localStorage.removeItem(NEW_KEY);
  }

  window.RuankaoStorage={KEY:NEW_KEY,STATE_VERSION,defaultState,load,save,clear,normalize,migrateV3,today};
})();
