(function(){
'use strict';

const APP_VERSION='3.5.0';
const REASONS=['完全不会','概念混淆','公式记错','计算错误','审题不仔细','随机猜测'];
const MODE_NAMES={adaptive:'智能练习',random:'随机练习',category:'章节专项',wrong:'错题复习',favorite:'收藏题练习',formula:'计算专项',mock:'全真模拟',diagnostic:'能力摸底',shared:'固定试卷'};
const REVIEW_INTERVALS=[1,3,7,14,30];
let BANK=[],CASES=[],FORMULAS=[],VERSION={};
let state=RuankaoStorage.load();
let active=null;
let selectedMode='adaptive';
let wrongFilter='due';
let timerId=null;
let deferredInstallPrompt=null;
let swRegistration=null;

const $=id=>document.getElementById(id);
const $$=sel=>Array.from(document.querySelectorAll(sel));
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function localDate(d=new Date()){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${day}`;}
function addDays(dateStr,n){const d=new Date(dateStr+'T12:00:00');d.setDate(d.getDate()+n);return localDate(d);}
function daysBetween(a,b){return Math.round((new Date(b+'T12:00:00')-new Date(a+'T12:00:00'))/86400000);}
function formatDuration(sec){sec=Math.max(0,Math.round(sec||0));const m=Math.floor(sec/60),s=sec%60;return m?`${m}分${s}秒`:`${s}秒`;}
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.remove('hidden');clearTimeout(el._t);el._t=setTimeout(()=>el.classList.add('hidden'),2200);}
function saveState(){RuankaoStorage.save(state);}
function hashSeed(text){let h=2166136261;for(const ch of String(text)){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}
function rng(seed){let x=seed>>>0||123456789;return function(){x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;};}
function shuffle(arr,seed){const a=arr.slice(),r=seed===undefined?Math.random:rng(hashSeed(seed));for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function byId(id){return BANK.find(q=>q.id===id);}
function difficultyLabel(n){return n===1?'基础':n===3?'较难':'中等';}
function typeLabel(t){return t==='scenario'?'情景题':t==='calculation'?'计算题':'概念题';}
function unique(arr){return Array.from(new Set(arr));}
function compareVersion(a,b){const pa=String(a||'0').split(/[.-]/).map(x=>parseInt(x,10)||0),pb=String(b||'0').split(/[.-]/).map(x=>parseInt(x,10)||0);for(let i=0;i<Math.max(pa.length,pb.length);i++){if((pa[i]||0)>(pb[i]||0))return 1;if((pa[i]||0)<(pb[i]||0))return -1;}return 0;}

async function fetchJson(url,opts={}){const r=await fetch(url,opts);if(!r.ok)throw new Error(`${url} ${r.status}`);return r.json();}
async function loadData(){
  try{
    const [questions,cases,formulas,version]=await Promise.all([
      fetchJson('data/questions.json'),fetchJson('data/cases.json'),fetchJson('data/formulas.json'),fetchJson('data/version.json',{cache:'no-store'})
    ]);
    if(!Array.isArray(questions)||questions.length<50)throw new Error('题库格式异常');
    BANK=questions;CASES=cases;FORMULAS=formulas;VERSION=version;
    $('loadingView').classList.add('hidden');
    $('versionBadge').textContent=`V${APP_VERSION} · ${BANK.length}题`;
    $('questionCountLabel').textContent=BANK.length;
    $('settingsVersion').textContent=`应用 ${APP_VERSION} / 题库 ${VERSION.questionVersion||'-'}`;
    $('updateNotes').innerHTML=(VERSION.updateNotes||[]).map(x=>`<div class="task"><span>✓</span><span>${escapeHtml(x)}</span></div>`).join('');
    initApp();
  }catch(e){
    $('loadingView').classList.add('hidden');$('fatalView').classList.remove('hidden');
    $('fatalText').textContent=`${e.message}。请确认已通过GitHub Pages或本地HTTP服务器打开，不能直接双击JSON分离版文件。`;
    console.error(e);
  }
}

function qStat(id){
  if(!state.questionStats[id])state.questionStats[id]={seen:0,correct:0,wrong:0,level:0,lastSeen:'',nextReview:'',totalTime:0};
  return state.questionStats[id];
}
function accuracyStat(s){return s.seen?Math.round(s.correct/s.seen*100):0;}
function mastery(q){
  const s=qStat(q.id);if(!s.seen)return 25;
  const acc=s.correct/s.seen*100;
  const spaced=Math.min(30,(s.level||0)*7);
  let recency=0;if(s.lastSeen){const gap=Math.max(0,daysBetween(s.lastSeen,localDate()));recency=Math.min(15,gap*1.5);}
  return clamp(Math.round(acc*.65+spaced-recency),0,100);
}
function allWrongQuestions(){return BANK.filter(q=>qStat(q.id).wrong>0);}
function dueWrongQuestions(){const t=localDate();return allWrongQuestions().filter(q=>!qStat(q.id).nextReview||qStat(q.id).nextReview<=t);}
function masteredWrongQuestions(){return allWrongQuestions().filter(q=>qStat(q.id).level>=4&&accuracyStat(qStat(q.id))>=80);}
function favoriteQuestions(){return state.favorites.map(byId).filter(Boolean);}
function noteQuestions(){return Object.keys(state.notes).filter(k=>state.notes[k]&&state.notes[k].trim()).map(byId).filter(Boolean);}
function categorySummary(){
  const map={};BANK.forEach(q=>{if(!map[q.category])map[q.category]={category:q.category,total:0,seen:0,correct:0,wrong:0,masteries:[]};const x=map[q.category],s=qStat(q.id);x.total++;x.seen+=s.seen;x.correct+=s.correct;x.wrong+=s.wrong;if(s.seen)x.masteries.push(mastery(q));});
  return Object.values(map).map(x=>{x.mastery=x.masteries.length?Math.round(x.masteries.reduce((a,b)=>a+b,0)/x.masteries.length):25;return x;}).sort((a,b)=>a.mastery-b.mastery);
}
function weakCategories(limit=5){return categorySummary().slice(0,limit).map(x=>x.category);}
function daysLeft(){if(!state.profile||!state.profile.examDate)return null;return daysBetween(localDate(),state.profile.examDate);}
function phase(){const d=daysLeft();if(d===null)return{key:'steady',name:'稳步学习'};if(d<=14)return{key:'sprint',name:'冲刺阶段'};if(d<=45)return{key:'improve',name:'强化阶段'};return{key:'foundation',name:'基础阶段'};}
function updateStreak(){const t=localDate(),last=state.streak.lastDate;if(last===t)return;if(last&&daysBetween(last,t)===1)state.streak.days+=1;else state.streak.days=1;state.streak.lastDate=t;}
function recordAnswer(q,isCorrect,seconds){
  const s=qStat(q.id);s.seen++;s.lastSeen=localDate();s.totalTime=(s.totalTime||0)+(seconds||0);
  if(isCorrect){s.correct++;s.level=Math.min(5,(s.level||0)+1);s.nextReview=addDays(localDate(),REVIEW_INTERVALS[Math.min(REVIEW_INTERVALS.length-1,Math.max(0,s.level-1))]);}
  else{s.wrong++;s.level=0;s.nextReview=addDays(localDate(),1);}
  updateStreak();saveState();
}
function setWrongReason(qid,reason){
  if(!active||!reason)return;
  active.reasons=active.reasons||{};
  const old=active.reasons[qid];
  state.wrongReasons[qid]=state.wrongReasons[qid]||{};
  if(old&&state.wrongReasons[qid][old])state.wrongReasons[qid][old]=Math.max(0,state.wrongReasons[qid][old]-1);
  active.reasons[qid]=reason;state.wrongReasons[qid][reason]=(state.wrongReasons[qid][reason]||0)+1;
  state.draft=active;saveState();renderQuiz();toast('已记录错因');
}

function applyTheme(){
  const theme=state.settings.theme||'system';
  const dark=theme==='dark'||(theme==='system'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('dark',dark);
  document.documentElement.style.setProperty('--fontScale',String(state.settings.fontScale||1));
}
function showSetupOrApp(){
  if(state.profile){$('setupView').classList.add('hidden');$('mainApp').classList.remove('hidden');$('bottomNav').classList.remove('hidden');renderAll();handleSharedLink();}
  else{$('setupView').classList.remove('hidden');$('mainApp').classList.add('hidden');$('bottomNav').classList.add('hidden');}
}
function switchPage(name){
  $$('.page').forEach(p=>p.classList.add('hidden'));const page=$(`page-${name}`);if(page)page.classList.remove('hidden');
  $$('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===name));
  if(name==='dashboard')renderDashboard();if(name==='practice')renderPracticeHome();if(name==='plan')renderPlan();if(name==='wrongs')renderWrongs();if(name==='cases')renderCases();if(name==='formulas')renderFormulas();if(name==='stats')renderStats();if(name==='settings')renderSettings();
  window.scrollTo({top:0,behavior:'smooth'});
}
function renderAll(){renderHero();renderDashboard();renderPracticeHome();renderPlan();renderWrongs();renderCases();renderFormulas();renderStats();renderSettings();}
function renderHero(){
  if(!state.profile)return;
  const seen=Object.values(state.questionStats).reduce((a,s)=>a+(s.seen||0),0),correct=Object.values(state.questionStats).reduce((a,s)=>a+(s.correct||0),0),acc=seen?Math.round(correct/seen*100):0,d=daysLeft();
  $('heroMeta').classList.remove('hidden');$('heroMeta').innerHTML=`<span class="hero-chip">学习者：${escapeHtml(state.profile.name||'学习者')}</span><span class="hero-chip">累计 ${seen} 题</span><span class="hero-chip">正确率 ${acc}%</span><span class="hero-chip">连续 ${state.streak.days||0} 天</span><span class="hero-chip">${d===null?'未设置考试日期':d>=0?`距考试 ${d} 天`:'考试日期已过'}</span>`;
}
function renderDashboard(){
  if(!state.profile)return;
  const stats=Object.values(state.questionStats),seen=stats.reduce((a,s)=>a+(s.seen||0),0),correct=stats.reduce((a,s)=>a+(s.correct||0),0),acc=seen?Math.round(correct/seen*100):0,due=dueWrongQuestions().length;
  const overall=categorySummary();const masteryAvg=overall.length?Math.round(overall.reduce((a,x)=>a+x.mastery,0)/overall.length):25;
  $('dashboardMetrics').innerHTML=[['累计答题',seen,'本机记录'],['正确率',acc+'%','累计正确率'],['到期错题',due,'建议今日复习'],['参考掌握度',masteryAvg+'%','根据本机答题估算']].map(x=>`<div class="metric"><small>${x[0]}</small><strong>${x[1]}</strong><div class="sub">${x[2]}</div></div>`).join('');
  const p=phase(),weak=weakCategories(3);$('phaseTag').textContent=p.name;
  let advice=seen<20?'先完成20题能力摸底，系统才能更准确识别薄弱章节。':due?`今天有 ${due} 道到期错题，建议先复习，再完成 ${state.profile.dailyTarget||20} 道智能练习。`:`当前薄弱方向：${weak.join('、')||'暂无'}。建议完成 ${state.profile.dailyTarget||20} 道智能练习。`;
  $('todayAdvice').innerHTML=`<b>${escapeHtml(advice)}</b><div class="small muted" style="margin-top:5px">参考建议基于本机记录，不代表官方预测。</div>`;
  $('weakBars').innerHTML=categorySummary().slice(0,6).map(x=>`<div class="bar-row"><div class="bar-head"><span>${escapeHtml(x.category)}</span><b>${x.mastery}%</b></div><div class="bar-track"><div class="bar-fill" style="width:${x.mastery}%"></div></div></div>`).join('')||'<div class="empty">完成练习后显示</div>';
  renderTodayTasks();renderRecentHistory();renderResume();
}
function renderResume(){
  const el=$('resumeCard');if(!state.draft||!state.draft.questions||!state.draft.questions.length){el.classList.add('hidden');return;}
  el.classList.remove('hidden');el.innerHTML=`<div class="resume"><div><b>有一组未完成的${escapeHtml(MODE_NAMES[state.draft.mode]||'练习')}</b><div class="muted small">进度 ${(state.draft.current||0)+1}/${state.draft.questions.length}，已自动暂存。</div></div><div class="inline"><button id="resumeQuiz" class="primary">继续答题</button><button id="discardDraft" class="danger">放弃</button></div></div>`;
  $('resumeQuiz').onclick=()=>{active=state.draft;switchPage('practice');showQuiz();};
  $('discardDraft').onclick=()=>{if(confirm('确定放弃这组未完成练习吗？')){state.draft=null;saveState();renderResume();}};
}
function renderRecentHistory(){
  const list=state.history.slice(-6).reverse();$('historyCount').textContent=`${state.history.length} 次`;
  $('recentHistory').innerHTML=list.length?list.map(h=>`<div class="history-row"><b>${escapeHtml(MODE_NAMES[h.mode]||h.mode)} · ${h.correct}/${h.total}</b><span class="tag ${h.percent>=60?'ok':'bad'}">${h.percent}%</span><span>${escapeHtml(h.date)} · ${formatDuration(h.duration)}</span></div>`).join(''):'<div class="empty">暂无练习记录</div>';
}
function renderTodayTasks(){
  if(!state.plan.length)generatePlan(30,false);
  const day=state.plan.find(d=>d.date===localDate())||state.plan[0];if(!day){$('todayTasks').innerHTML='<div class="empty">暂无任务</div>';return;}
  const done=day.tasks.filter(t=>t.done).length;$('todayTaskCount').textContent=`${done}/${day.tasks.length}`;
  $('todayTasks').innerHTML=day.tasks.map(t=>`<label class="task"><input type="checkbox" data-today-task="${escapeHtml(t.id)}" ${t.done?'checked':''}><span><b>${escapeHtml(t.label)}</b><div class="muted small">${escapeHtml(t.note||'')}</div></span></label>`).join('');
  $$('[data-today-task]').forEach(x=>x.onchange=()=>{const t=day.tasks.find(t=>t.id===x.dataset.todayTask);if(t)t.done=x.checked;saveState();renderTodayTasks();renderPlan();});
}

function populateFilters(){
  const cats=unique(BANK.map(q=>q.category)).sort((a,b)=>a.localeCompare(b,'zh-CN'));
  $('practiceCategory').innerHTML='<option value="">全部章节</option>'+cats.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
}
function updateModeHelp(){
  const help={adaptive:'综合掌握度、最近错题、复习到期、答题次数和难度进行抽题。',random:'从符合筛选条件的题目中随机抽取。',category:'请至少选择章节、难度或题型中的一项。',wrong:'优先抽取今日到期错题，不足时补充其他错题。',favorite:'从收藏题中抽取，可用于考前集中复习。',formula:'只抽取计算题和带公式题。',mock:'默认75题、150分钟、答题过程中不显示解析。',shared:'生成带随机种子的固定试卷链接，同一链接题目和顺序一致。'};
  $('modeHelp').textContent=help[selectedMode]||'';$('shareBuilder').classList.toggle('hidden',selectedMode!=='shared');
  if(selectedMode==='mock'){$('practiceCount').value='75';}
}
function renderPracticeHome(){
  $('practiceHome').classList.remove('hidden');$('quizView').classList.add('hidden');$('resultView').classList.add('hidden');updateModeHelp();
}
function filteredPool(){
  const cat=$('practiceCategory').value,diff=Number($('practiceDifficulty').value)||0,type=$('practiceType').value;
  return BANK.filter(q=>(!cat||q.category===cat)&&(!diff||q.difficulty===diff)&&(!type||q.type===type));
}
function adaptiveQuestions(pool,count){
  const t=localDate();return pool.map(q=>{const s=qStat(q.id);let score=100-mastery(q);if(!s.seen)score+=25;if(s.wrong)score+=Math.min(30,s.wrong*5);if(s.nextReview&&s.nextReview<=t)score+=35;score+=Math.random()*15;return{q,score};}).sort((a,b)=>b.score-a.score).slice(0,count).map(x=>x.q);
}
function diagnosticQuestions(pool,count){
  const cats=unique(pool.map(q=>q.category)),result=[];let i=0;const grouped={};cats.forEach(c=>grouped[c]=shuffle(pool.filter(q=>q.category===c),`diag-${c}-${Date.now()}`));while(result.length<count&&i<2000){const c=cats[i%cats.length],q=grouped[c].shift();if(q)result.push(q);i++;if(!cats.some(c=>grouped[c].length))break;}return result.slice(0,count);
}
function chooseQuestions(mode,count,seed){
  let pool=filteredPool();if(!pool.length)return[];
  if(mode==='wrong'){const due=dueWrongQuestions().filter(q=>pool.some(p=>p.id===q.id));const rest=allWrongQuestions().filter(q=>pool.some(p=>p.id===q.id)&&!due.some(d=>d.id===q.id));return shuffle(due,seed).concat(shuffle(rest,seed+'r')).slice(0,count);}
  if(mode==='favorite')return shuffle(favoriteQuestions().filter(q=>pool.some(p=>p.id===q.id)),seed).slice(0,count);
  if(mode==='formula')pool=pool.filter(q=>q.type==='calculation'||q.formula); 
  if(mode==='adaptive')return adaptiveQuestions(pool,count);
  if(mode==='diagnostic')return diagnosticQuestions(pool,count);
  return shuffle(pool,seed).slice(0,count);
}
function createSession(mode,count,opts={}){
  const seed=opts.seed||`${Date.now()}-${Math.random()}`;
  const questions=chooseQuestions(mode,count,seed);
  if(!questions.length){toast(mode==='favorite'?'还没有收藏题':mode==='wrong'?'还没有错题':'没有符合条件的题目');return false;}
  const strict=mode==='mock'||mode==='shared'||opts.strict;
  const timeLimit=opts.timeLimit!==undefined?opts.timeLimit:(mode==='mock'?150*60:0);
  active={mode,questions:questions.map(q=>q.id),answers:{},evaluated:{},reasons:{},current:0,startedAt:Date.now(),questionStartedAt:Date.now(),elapsed:0,timeLimit,strict,seed,committed:false};
  state.draft=active;saveState();showQuiz();return true;
}
function showQuiz(){
  switchPage('practice');$('practiceHome').classList.add('hidden');$('resultView').classList.add('hidden');$('quizView').classList.remove('hidden');startTimer();renderQuiz();
}
function currentQuestion(){return active?byId(active.questions[active.current]):null;}
function startTimer(){clearInterval(timerId);if(!active)return;timerId=setInterval(()=>{active.elapsed=Math.floor((Date.now()-active.startedAt)/1000);if(active.timeLimit){const left=Math.max(0,active.timeLimit-active.elapsed);$('timer').classList.remove('hidden');$('timer').textContent=`剩余 ${formatDuration(left)}`;if(left<=0){clearInterval(timerId);finishQuiz(true);}}else{$('timer').classList.add('hidden');}state.draft=active;saveState();},1000);}
function renderQuiz(){
  if(!active)return;const q=currentQuestion();if(!q)return;
  $('quizModeTag').textContent=MODE_NAMES[active.mode]||active.mode;$('quizMetaTag').textContent=`第 ${active.current+1}/${active.questions.length} 题`;
  $('quizProgress').style.width=`${(active.current+1)/active.questions.length*100}%`;
  $('questionNav').innerHTML=active.questions.map((id,i)=>{const cls=[i===active.current?'current':'',active.answers[id]!==undefined?'done':'',active.evaluated[id]&&active.answers[id]!==byId(id).answer?'wrong-mark':''].filter(Boolean).join(' ');return `<button class="${cls}" data-qindex="${i}">${i+1}</button>`;}).join('');
  $$('[data-qindex]').forEach(b=>b.onclick=()=>{active.current=Number(b.dataset.qindex);active.questionStartedAt=Date.now();state.draft=active;saveState();renderQuiz();});
  $('questionText').textContent=q.text;$('questionTags').innerHTML=`<span class="tag">${escapeHtml(q.category)}</span><span class="tag">${escapeHtml(q.knowledge)}</span><span class="tag">${difficultyLabel(q.difficulty)}</span><span class="tag">${typeLabel(q.type)}</span>`;
  const selected=active.answers[q.id],evaluated=!!active.evaluated[q.id];
  $('options').innerHTML=q.options.map((o,i)=>{let cls='option';if(selected===i)cls+=' selected';if(evaluated){if(i===q.answer)cls+=' correct';else if(i===selected)cls+=' incorrect';}return `<label class="${cls}" data-option="${i}"><input type="radio" name="answer" ${selected===i?'checked':''} ${evaluated&&!active.strict?'disabled':''}><span><b>${String.fromCharCode(65+i)}.</b> ${escapeHtml(o)}</span></label>`;}).join('');
  $$('[data-option]').forEach(el=>el.onclick=e=>{e.preventDefault();chooseOption(Number(el.dataset.option));});
  $('favoriteCurrent').textContent=state.favorites.includes(q.id)?'★ 已收藏':'☆ 收藏';
  $('questionNote').value=state.notes[q.id]||'';
  $('prevQuestion').disabled=active.current===0;$('nextQuestion').disabled=active.current===active.questions.length-1;
  if(evaluated&&!active.strict)renderFeedback(q,selected);else{$('feedback').classList.add('hidden');$('reasonPanel').classList.add('hidden');}
  $('reasonButtons').innerHTML=REASONS.map(r=>`<button class="reason-btn ${active.reasons&&active.reasons[q.id]===r?'active':''}" data-reason="${r}">${r}</button>`).join('');
  $$('[data-reason]').forEach(b=>b.onclick=()=>setWrongReason(q.id,b.dataset.reason));
}
function chooseOption(index){
  const q=currentQuestion();if(!q)return;if(active.evaluated[q.id]&&!active.strict)return;
  active.answers[q.id]=index;
  if(!active.strict){
    active.evaluated[q.id]=true;
    const sec=Math.max(1,Math.round((Date.now()-(active.questionStartedAt||Date.now()))/1000));recordAnswer(q,index===q.answer,sec);
  }
  active.questionStartedAt=Date.now();state.draft=active;saveState();renderQuiz();
}
function renderFeedback(q,selected){
  const ok=selected===q.answer,el=$('feedback');el.classList.remove('hidden','ok','bad');el.classList.add(ok?'ok':'bad');
  el.innerHTML=`<b>${ok?'回答正确':'回答错误，正确答案：'+String.fromCharCode(65+q.answer)}</b><div style="margin-top:6px">${escapeHtml(q.explanation)}</div>${q.mistakeTip?`<div class="small muted" style="margin-top:6px">易错提示：${escapeHtml(q.mistakeTip)}</div>`:''}${q.formula?`<div class="formula">${escapeHtml(q.formula)}</div>`:''}`;
  $('reasonPanel').classList.toggle('hidden',ok);
}
function finishQuiz(auto=false){
  if(!active)return;clearInterval(timerId);
  if(!auto&&!confirm('确定交卷吗？未答题将按错误处理。')){startTimer();return;}
  const total=active.questions.length;let correct=0;
  active.questions.forEach(id=>{const q=byId(id),answer=active.answers[id],isCorrect=answer===q.answer;if(isCorrect)correct++;if(!active.evaluated[id]){const avg=active.elapsed/Math.max(1,total);recordAnswer(q,isCorrect,avg);active.evaluated[id]=true;}});
  const duration=Math.max(1,Math.floor((Date.now()-active.startedAt)/1000)),percent=Math.round(correct/total*100);
  const entry={id:`h-${Date.now()}`,mode:active.mode,total,correct,percent,duration,date:localDate(),timestamp:Date.now(),seed:active.seed};state.history.push(entry);state.history=state.history.slice(-200);state.draft=null;saveState();
  renderResult(entry,active);active=null;renderHero();renderDashboard();renderStats();
}
function renderResult(entry,session){
  $('quizView').classList.add('hidden');$('practiceHome').classList.add('hidden');$('resultView').classList.remove('hidden');
  const reviews=session.questions.map(id=>{const q=byId(id),a=session.answers[id],ok=a===q.answer;return{q,a,ok};});
  $('resultView').innerHTML=`<div class="card"><div class="grid4"><div class="metric"><small>成绩</small><strong>${entry.correct}/${entry.total}</strong></div><div class="metric"><small>正确率</small><strong>${entry.percent}%</strong></div><div class="metric"><small>用时</small><strong>${formatDuration(entry.duration)}</strong></div><div class="metric"><small>结果</small><strong>${entry.percent>=60?'达标':'需加强'}</strong></div></div><div class="actions"><button class="ghost" id="backPractice">返回练习</button><div class="right"><button class="secondary" id="retryWrong">重练本次错题</button><button class="primary" id="makePoster">生成成绩海报</button></div></div></div><div class="card"><div class="section-title"><h3>答题解析</h3><span class="tag">${reviews.filter(x=>!x.ok).length} 道错题</span></div><div class="result-list">${reviews.map((x,i)=>`<div class="review"><div><span class="tag ${x.ok?'ok':'bad'}">${x.ok?'正确':'错误'}</span> <span class="tag">${escapeHtml(x.q.category)}</span></div><b>${i+1}. ${escapeHtml(x.q.text)}</b><div class="small ${x.ok?'right-text':'wrong-text'}">你的答案：${x.a===undefined?'未作答':String.fromCharCode(65+x.a)+' '+escapeHtml(x.q.options[x.a])}</div><div class="small right-text">正确答案：${String.fromCharCode(65+x.q.answer)} ${escapeHtml(x.q.options[x.q.answer])}</div><div class="muted small">${escapeHtml(x.q.explanation)}</div></div>`).join('')}</div></div>`;
  $('backPractice').onclick=()=>renderPracticeHome();
  $('retryWrong').onclick=()=>{const ids=reviews.filter(x=>!x.ok).map(x=>x.q.id);if(!ids.length){toast('本次没有错题');return;}active={mode:'wrong',questions:ids,answers:{},evaluated:{},reasons:{},current:0,startedAt:Date.now(),questionStartedAt:Date.now(),elapsed:0,timeLimit:0,strict:false,seed:`retry-${Date.now()}`};state.draft=active;saveState();showQuiz();};
  $('makePoster').onclick=()=>makePoster(entry);
}
function quitQuiz(){clearInterval(timerId);if(active){active.elapsed=Math.floor((Date.now()-active.startedAt)/1000);state.draft=active;saveState();active=null;}renderPracticeHome();toast('答题进度已暂存');}

function generatePlan(len=30,announce=true){
  const today=localDate(),p=phase(),weak=weakCategories(5),plan=[];
  for(let i=0;i<len;i++){
    const date=addDays(today,i),target=Number(state.profile.dailyTarget)||20,cat=weak[i%Math.max(1,weak.length)]||'项目管理',tasks=[];
    tasks.push({id:'adaptive',label:`智能练习 ${target} 题`,note:`重点：${cat}`,done:false});
    tasks.push({id:'wrong',label:'复习到期错题',note:'按间隔复习，建议至少5题',done:false});
    if(i%2===0)tasks.push({id:'case',label:'完成1道案例题关键词检查',note:'结论先行、分条作答、写出闭环',done:false});
    if(p.key==='sprint'&&i%3===0)tasks.push({id:'mock',label:'完成1次全真模拟',note:'交卷后集中复盘错因',done:false});
    else if(i%3===0)tasks.push({id:'formula',label:'完成10题计算专项',note:'公式、条件和单位都要检查',done:false});
    plan.push({date,tasks});
  }
  state.plan=plan;state.planLength=len;saveState();renderPlan();renderTodayTasks();if(announce)toast(`已生成${len}天计划`);
}
function renderPlan(){
  if(!state.profile)return;if(!state.plan.length)generatePlan(30,false);let total=0,done=0;state.plan.forEach(d=>d.tasks.forEach(t=>{total++;if(t.done)done++;}));
  $('planProgress').style.width=`${total?done/total*100:0}%`;$('planProgressText').textContent=`已完成 ${done} / ${total} 项任务`;$('planSummary').textContent=`${phase().name} · ${daysLeft()===null?'未设置目标日期':`距目标 ${Math.max(0,daysLeft())} 天`} · 当前计划 ${state.planLength} 天`;
  $('planList').innerHTML=state.plan.map(d=>{const today=d.date===localDate(),dDone=d.tasks.filter(t=>t.done).length;return `<div class="plan-day ${today?'today':''}"><div class="section-title"><b>${today?'今天 · ':''}${d.date}</b><span class="tag ${dDone===d.tasks.length?'ok':''}">${dDone}/${d.tasks.length}</span></div>${d.tasks.map(t=>`<label class="task"><input type="checkbox" data-task-date="${d.date}" data-task-id="${t.id}" ${t.done?'checked':''}><span><b>${escapeHtml(t.label)}</b><div class="muted small">${escapeHtml(t.note)}</div></span></label>`).join('')}</div>`;}).join('');
  $$('[data-task-date]').forEach(x=>x.onchange=()=>{const day=state.plan.find(d=>d.date===x.dataset.taskDate),t=day&&day.tasks.find(t=>t.id===x.dataset.taskId);if(t)t.done=x.checked;saveState();renderPlan();renderTodayTasks();});
}
function wrongDueLabel(s){if(s.level>=4&&accuracyStat(s)>=80)return'已掌握';if(!s.nextReview)return'待复习';const d=daysBetween(localDate(),s.nextReview);return d<=0?'今日到期':`${d}天后复习`;}
function renderWrongs(){
  let list=wrongFilter==='due'?dueWrongQuestions():wrongFilter==='mastered'?masteredWrongQuestions():wrongFilter==='favorite'?favoriteQuestions():wrongFilter==='notes'?noteQuestions():allWrongQuestions();
  $$('.wrong-filter').forEach(b=>b.classList.toggle('active',b.dataset.filter===wrongFilter));
  if(!list.length){$('wrongList').innerHTML=`<div class="card empty">${wrongFilter==='due'?'今天没有到期错题。':'暂无符合条件的题目。'}</div>`;return;}
  list=list.slice().sort((a,b)=>(qStat(b.id).wrong||0)-(qStat(a.id).wrong||0));
  $('wrongList').innerHTML=list.map(q=>{const s=qStat(q.id),note=state.notes[q.id],fav=state.favorites.includes(q.id);return `<div class="wrong-card"><div class="section-title"><div><span class="tag ${s.wrong?'bad':''}">${escapeHtml(q.category)}</span> <span class="tag">${wrongDueLabel(s)}</span> ${fav?'<span class="tag warn">★ 收藏</span>':''}</div><span class="muted small">答 ${s.seen} 次 · 正确率 ${accuracyStat(s)}%</span></div><b>${escapeHtml(q.text)}</b><div class="muted small" style="margin-top:6px">${escapeHtml(q.explanation)}</div>${note?`<div class="callout" style="margin-top:8px"><b>我的笔记</b><div class="small">${escapeHtml(note)}</div></div>`:''}</div>`;}).join('');
}
function renderCases(){
  $('caseSelect').innerHTML=CASES.map(c=>`<option value="${c.id}">${escapeHtml(c.category)}｜${escapeHtml(c.title)}</option>`).join('');updateCasePrompt();
}
function updateCasePrompt(){const c=CASES.find(x=>x.id===$('caseSelect').value)||CASES[0];if(c)$('casePrompt').innerHTML=`<b>${escapeHtml(c.title)}</b><div style="margin-top:5px">${escapeHtml(c.prompt)}</div><div class="small muted" style="margin-top:7px">建议框架：${escapeHtml((c.framework||[]).join(' → '))}</div>`;}
function scoreCase(){
  const c=CASES.find(x=>x.id===$('caseSelect').value)||CASES[0],answer=$('caseAnswer').value.trim();if(answer.length<10){toast('请先填写较完整的答案');return;}
  const text=answer.toLowerCase(),hits=c.points.map(p=>({label:p.label,matched:p.terms.some(t=>text.includes(t.toLowerCase()))})),count=hits.filter(x=>x.matched).length,score=Math.round(count/hits.length*100);state.caseAttempts.push({caseId:c.id,date:localDate(),score});saveState();
  $('caseResult').innerHTML=`<div class="card"><div class="grid2"><div><div class="muted small">关键词覆盖评分</div><div class="case-score">${score}分</div><div class="muted small">命中 ${count} / ${hits.length} 个核心要点</div></div><div class="callout ${score>=80?'ok':score<50?'warn':''}"><b>${score>=80?'要点较完整':score>=60?'基本覆盖，仍可补充':'遗漏较多，建议重写'}</b><div class="small">本功能只检查关键词和要点覆盖，不代表真实阅卷得分。</div></div></div><div class="keyword-grid">${hits.map(h=>`<span class="keyword ${h.matched?'hit':'miss'}">${h.matched?'✓ ':'缺：'}${escapeHtml(h.label)}</span>`).join('')}</div></div><div class="card"><h3>参考答题框架</h3><p>${escapeHtml(c.outline)}</p></div>`;$('caseResult').classList.remove('hidden');renderHero();toast('案例检查完成');
}
function renderFormulas(){$('formulaGrid').innerHTML=FORMULAS.map(f=>`<div class="formula-card"><b>${escapeHtml(f.name)}</b><div class="formula">${escapeHtml(f.formula)}</div><div class="muted small">${escapeHtml(f.meaning)}</div></div>`).join('');}
function renderStats(){
  const all=Object.values(state.questionStats),seen=all.reduce((a,s)=>a+(s.seen||0),0),correct=all.reduce((a,s)=>a+(s.correct||0),0),seconds=all.reduce((a,s)=>a+(s.totalTime||0),0),avg=seen?Math.round(seconds/seen):0;
  $('statsMetrics').innerHTML=[['累计答题',seen],['正确率',seen?Math.round(correct/seen*100)+'%':'0%'],['平均用时',avg?avg+'秒':'0秒'],['收藏题',state.favorites.length]].map(x=>`<div class="metric"><small>${x[0]}</small><strong>${x[1]}</strong></div>`).join('');
  $('categoryStats').innerHTML=categorySummary().map(x=>`<div class="bar-row"><div class="bar-head"><span>${escapeHtml(x.category)} <small class="muted">答${x.seen}次</small></span><b>${x.mastery}%</b></div><div class="bar-track"><div class="bar-fill" style="width:${x.mastery}%"></div></div></div>`).join('');
  const counts={};Object.values(state.wrongReasons).forEach(o=>Object.entries(o||{}).forEach(([k,v])=>counts[k]=(counts[k]||0)+v));const total=Object.values(counts).reduce((a,b)=>a+b,0);
  $('reasonStats').innerHTML=total?REASONS.map(r=>{const v=counts[r]||0,p=Math.round(v/total*100);return `<div class="bar-row"><div class="bar-head"><span>${r}</span><b>${v}次 · ${p}%</b></div><div class="bar-track"><div class="bar-fill" style="width:${p}%"></div></div></div>`;}).join(''):'<div class="empty">答错后标记错因，这里会生成统计。</div>';
  $('historyTable').innerHTML=state.history.length?`<table class="stat-table"><thead><tr><th>日期</th><th>模式</th><th>成绩</th><th>正确率</th><th>用时</th></tr></thead><tbody>${state.history.slice().reverse().map(h=>`<tr><td>${h.date}</td><td>${escapeHtml(MODE_NAMES[h.mode]||h.mode)}</td><td>${h.correct}/${h.total}</td><td>${h.percent}%</td><td>${formatDuration(h.duration)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">暂无历史记录</div>';
}
function renderSettings(){
  if(!state.profile)return;$('settingName').value=state.profile.name||'';$('settingDate').value=state.profile.examDate||'';$('settingTarget').value=String(state.profile.dailyTarget||20);$('themeSelect').value=state.settings.theme||'system';$('fontSelect').value=String(state.settings.fontScale||1);
}
function saveSettings(){state.profile.name=$('settingName').value.trim()||'学习者';state.profile.examDate=$('settingDate').value;state.profile.dailyTarget=Number($('settingTarget').value)||20;state.settings.theme=$('themeSelect').value;state.settings.fontScale=Number($('fontSelect').value)||1;saveState();applyTheme();generatePlan(state.planLength||30,false);renderAll();toast('设置已保存');}
function exportData(){state.settings.lastBackup=localDate();saveState();const payload={format:'ruankao-v35-backup',exportedAt:new Date().toISOString(),appVersion:APP_VERSION,state};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`柱子软考V3.5_学习记录_${localDate()}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('备份已导出');}
function copyData(){const text=JSON.stringify({format:'ruankao-v35-backup',appVersion:APP_VERSION,state});if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(text).then(()=>toast('备份文本已复制'));else prompt('请复制备份文本：',text);}
function importData(file){const r=new FileReader();r.onload=()=>{try{const x=JSON.parse(r.result),incoming=x.state||x;if(!incoming||typeof incoming!=='object')throw new Error('格式无效');state=RuankaoStorage.normalize(incoming);saveState();active=null;showSetupOrApp();switchPage('dashboard');toast('备份已导入');}catch(e){alert(`备份文件无效：${e.message}`);}};r.readAsText(file);}
function shareSite(){const url=location.origin+location.pathname,data={title:document.title,text:'柱子软考智能备考V3.5：300题、自适应练习、错题复习和离线使用',url};if(navigator.share)navigator.share(data).catch(()=>{});else if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(url).then(()=>toast('网页链接已复制'));else prompt('请复制网页链接：',url);}
function makePoster(entry){
  if(!entry){toast('暂无成绩可生成');return;}
  const canvas=document.createElement('canvas');canvas.width=900;canvas.height=1200;const c=canvas.getContext('2d');
  const grad=c.createLinearGradient(0,0,900,1200);grad.addColorStop(0,'#0e387a');grad.addColorStop(1,'#3483fa');c.fillStyle=grad;c.fillRect(0,0,900,1200);c.fillStyle='rgba(255,255,255,.12)';for(let i=0;i<10;i++){c.beginPath();c.arc(90+i*95,140+(i%2)*70,40+i*2,0,Math.PI*2);c.fill();}
  c.fillStyle='#fff';c.textAlign='center';c.font='bold 54px sans-serif';c.fillText('柱子软考智能备考',450,165);c.font='30px sans-serif';c.fillText(`V${APP_VERSION} · ${MODE_NAMES[entry.mode]||entry.mode}`,450,220);
  c.fillStyle='rgba(255,255,255,.95)';roundRect(c,100,300,700,600,35,true);c.fillStyle='#172033';c.font='28px sans-serif';c.fillText('本次成绩',450,390);c.fillStyle='#155eef';c.font='bold 120px sans-serif';c.fillText(`${entry.percent}%`,450,535);c.fillStyle='#172033';c.font='bold 42px sans-serif';c.fillText(`${entry.correct} / ${entry.total} 题`,450,615);c.font='28px sans-serif';c.fillText(`用时：${formatDuration(entry.duration)}`,450,680);c.fillText(`日期：${entry.date}`,450,730);
  const weak=weakCategories(2);c.font='26px sans-serif';c.fillStyle='#667085';c.fillText(`建议重点：${weak.join('、')||'继续保持'}`,450,810);c.fillStyle='#fff';c.font='25px sans-serif';c.fillText('数据来自当前浏览器，仅作备考参考',450,1025);c.font='22px sans-serif';c.fillText(location.host||'GitHub Pages 静态版',450,1080);
  canvas.toBlob(blob=>{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`软考成绩海报_${entry.date}_${entry.percent}分.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},'image/png');
}
function roundRect(ctx,x,y,w,h,r,fill){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();if(fill)ctx.fill();}

function generateShareLink(){
  const count=Number($('practiceCount').value)||20,cat=$('practiceCategory').value,diff=$('practiceDifficulty').value,type=$('practiceType').value,seed=$('shareSeed').value.trim()||String(Date.now()).slice(-8),time=Math.max(0,Number($('shareTime').value)||0);const u=new URL(location.origin+location.pathname);u.searchParams.set('mode','exam');u.searchParams.set('count',String(count));u.searchParams.set('seed',seed);if(cat)u.searchParams.set('category',cat);if(diff)u.searchParams.set('difficulty',diff);if(type)u.searchParams.set('type',type);if(time)u.searchParams.set('time',String(time));$('shareLinkBox').classList.remove('hidden');$('shareLinkBox').innerHTML=`<b>固定试卷链接</b><div style="margin:8px 0">${escapeHtml(u.toString())}</div><button id="copyShareLink" class="primary">复制链接</button>`;$('copyShareLink').onclick=()=>navigator.clipboard?navigator.clipboard.writeText(u.toString()).then(()=>toast('试卷链接已复制')):prompt('请复制：',u.toString());
}
function handleSharedLink(){
  if(window._sharedHandled)return;const p=new URLSearchParams(location.search);if(p.get('mode')!=='exam')return;window._sharedHandled=true;selectedMode='shared';$('practiceCount').value=p.get('count')||'20';$('practiceCategory').value=p.get('category')||'';$('practiceDifficulty').value=p.get('difficulty')||'';$('practiceType').value=p.get('type')||'';switchPage('practice');const count=clamp(Number(p.get('count'))||20,1,75),seed=p.get('seed')||'shared',time=clamp(Number(p.get('time'))||0,0,300)*60;setTimeout(()=>createSession('shared',count,{seed,timeLimit:time,strict:true}),50);
}

async function checkUpdate(manual=false){
  try{const remote=await fetchJson(`data/version.json?t=${Date.now()}`,{cache:'no-store'});const newer=compareVersion(remote.appVersion,APP_VERSION)>0||(remote.questionVersion&&remote.questionVersion!==VERSION.questionVersion);if(newer){$('updateTitle').textContent=`发现新版本 ${remote.appVersion||''}`;$('updateText').textContent=`题库版本 ${remote.questionVersion||''}，${remote.questionCount||''} 题。完成当前练习后更新更安全。`;$('updateBanner').classList.remove('hidden');window._remoteVersion=remote;}else if(manual)toast('已经是最新版本');}catch(e){if(manual)toast('检查失败，请稍后重试');}}
async function applyUpdate(){
  if(active&&!confirm('当前有未完成练习，更新后可从暂存记录继续。确定更新吗？'))return;
  try{if(swRegistration){await swRegistration.update();if(swRegistration.waiting)swRegistration.waiting.postMessage({type:'SKIP_WAITING'});}if('caches' in window){const keys=await caches.keys();await Promise.all(keys.map(k=>caches.delete(k)));}location.href=`${location.pathname}?updated=${Date.now()}`;}catch(_){location.reload(true);}
}
async function registerSW(){
  if(!('serviceWorker' in navigator)||location.protocol==='file:')return;
  try{swRegistration=await navigator.serviceWorker.register('sw.js');navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload());swRegistration.addEventListener('updatefound',()=>{const worker=swRegistration.installing;worker&&worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller){$('updateBanner').classList.remove('hidden');$('updateTitle').textContent='网站资源已更新';$('updateText').textContent='点击立即更新即可使用最新版本。';}});});}catch(e){console.warn('SW',e);}
}
function bindInstall(){window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;$('installApp').classList.remove('hidden');});$('installApp').onclick=async()=>{if(!deferredInstallPrompt){toast('请使用浏览器菜单中的“添加到主屏幕”');return;}deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$('installApp').classList.add('hidden');};}

function bindEvents(){
  $$('[data-page]').forEach(b=>b.onclick=()=>switchPage(b.dataset.page));$$('[data-go]').forEach(b=>b.onclick=()=>switchPage(b.dataset.go));
  $$('[data-quick]').forEach(b=>b.onclick=()=>{const m=b.dataset.quick;if(m==='adaptive')createSession('adaptive',state.profile.dailyTarget||20);else if(m==='diagnostic')createSession('diagnostic',20);else if(m==='mock')createSession('mock',75);else if(m==='wrong'){if(!createSession('wrong',Math.min(20,Math.max(1,dueWrongQuestions().length))))switchPage('wrongs');}else if(m==='favorite'){if(!createSession('favorite',Math.min(20,Math.max(1,favoriteQuestions().length))))switchPage('wrongs');}});
  $$('.mode-card').forEach(b=>b.onclick=()=>{$$('.mode-card').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');selectedMode=b.dataset.mode;updateModeHelp();});
  $('createProfile').onclick=()=>{state.profile={name:$('setupName').value.trim()||'学习者',examDate:$('setupDate').value,dailyTarget:Number($('setupTarget').value)||20};saveState();generatePlan(30,false);showSetupOrApp();switchPage('dashboard');};
  $('startPractice').onclick=()=>{const count=Number($('practiceCount').value)||20;if(selectedMode==='category'&&!$('practiceCategory').value&&!$('practiceDifficulty').value&&!$('practiceType').value){toast('章节专项请至少选择一项筛选条件');return;}if(selectedMode==='shared'){generateShareLink();return;}createSession(selectedMode,count);};
  $('generateShareLink').onclick=generateShareLink;
  $('prevQuestion').onclick=()=>{if(active&&active.current>0){active.current--;active.questionStartedAt=Date.now();state.draft=active;saveState();renderQuiz();}};
  $('nextQuestion').onclick=()=>{if(active&&active.current<active.questions.length-1){active.current++;active.questionStartedAt=Date.now();state.draft=active;saveState();renderQuiz();}};
  $('submitQuiz').onclick=()=>finishQuiz(false);$('quitQuiz').onclick=quitQuiz;
  $('favoriteCurrent').onclick=()=>{const q=currentQuestion();if(!q)return;const i=state.favorites.indexOf(q.id);if(i>=0)state.favorites.splice(i,1);else state.favorites.push(q.id);saveState();renderQuiz();toast(i>=0?'已取消收藏':'已收藏');};
  $('toggleNote').onclick=()=>$('notePanel').classList.toggle('hidden');$('saveNote').onclick=()=>{const q=currentQuestion();if(!q)return;const v=$('questionNote').value.trim();if(v)state.notes[q.id]=v;else delete state.notes[q.id];saveState();toast('笔记已保存');};
  $('plan7').onclick=()=>generatePlan(7,true);$('plan30').onclick=()=>generatePlan(30,true);
  $$('.wrong-filter').forEach(b=>b.onclick=()=>{wrongFilter=b.dataset.filter;renderWrongs();});$('startDueWrongs').onclick=()=>createSession('wrong',Math.min(20,Math.max(1,dueWrongQuestions().length)));
  $('caseSelect').onchange=updateCasePrompt;$('scoreCase').onclick=scoreCase;$('startFormulaPractice').onclick=()=>createSession('formula',10);
  $('saveSettings').onclick=saveSettings;$('exportData').onclick=exportData;$('copyData').onclick=copyData;$('importFile').onchange=function(){if(this.files&&this.files[0])importData(this.files[0]);};$('shareSite').onclick=shareSite;
  $('resetData').onclick=()=>{if(confirm('确定清空全部学习记录吗？此操作无法撤销。')){RuankaoStorage.clear();state=RuankaoStorage.defaultState();location.reload();}};
  $('checkUpdate').onclick=()=>checkUpdate(true);$('applyUpdate').onclick=applyUpdate;$('makePosterLast').onclick=()=>makePoster(state.history[state.history.length-1]);
  window.addEventListener('beforeunload',()=>{if(active){state.draft=active;saveState();}});
}
function initApp(){populateFilters();applyTheme();bindEvents();bindInstall();registerSW();showSetupOrApp();checkUpdate(false);setInterval(()=>checkUpdate(false),60*60*1000);}

loadData();
})();
